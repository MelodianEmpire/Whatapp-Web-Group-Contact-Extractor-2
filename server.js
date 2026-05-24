const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { Parser } = require('json2csv');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── WhatsApp Client ───────────────────────────────────────────────────────────
let client = null;
let clientReady = false;
let groups = [];

function createClient() {
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
      ]
    }
  });

  client.on('qr', async (qr) => {
    try {
      const qrDataUrl = await qrcode.toDataURL(qr);
      io.emit('qr', qrDataUrl);
      io.emit('status', { state: 'qr', message: 'Scan the QR code with WhatsApp' });
    } catch (err) {
      console.error('QR error:', err);
    }
  });

  client.on('authenticated', () => {
    io.emit('status', { state: 'authenticated', message: 'Authenticated! Loading your chats...' });
  });

  client.on('ready', async () => {
    clientReady = true;
    io.emit('status', { state: 'ready', message: 'Connected! Fetching groups...' });
    try {
      await loadGroups();
    } catch (err) {
      io.emit('error', 'Failed to load groups: ' + err.message);
    }
  });

  client.on('auth_failure', () => {
    clientReady = false;
    io.emit('status', { state: 'auth_failure', message: 'Authentication failed. Please refresh and try again.' });
  });

  client.on('disconnected', (reason) => {
    clientReady = false;
    groups = [];
    io.emit('status', { state: 'disconnected', message: 'Disconnected: ' + reason });
  });

  client.initialize().catch(err => {
    io.emit('error', 'Failed to initialize: ' + err.message);
    console.error('Init error:', err);
  });
}

async function loadGroups() {
  const chats = await client.getChats();
  groups = chats
    .filter(c => c.isGroup)
    .map(g => ({
      id: g.id._serialized,
      name: g.name,
      participantCount: g.participants ? g.participants.length : 0
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  io.emit('groups', groups);
  io.emit('status', { state: 'ready', message: `Found ${groups.length} group${groups.length !== 1 ? 's' : ''}` });
}

// ─── REST Endpoints ────────────────────────────────────────────────────────────

// Status check
app.get('/api/status', (req, res) => {
  res.json({ ready: clientReady, groupCount: groups.length });
});

// Get groups list
app.get('/api/groups', (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'Client not ready' });
  res.json(groups);
});

// Export contacts from selected groups
app.post('/api/export', async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'Client not ready' });

  const { groupIds, format = 'csv' } = req.body;
  if (!groupIds || !Array.isArray(groupIds) || groupIds.length === 0) {
    return res.status(400).json({ error: 'Provide at least one groupId' });
  }

  try {
    const contactMap = new Map(); // keyed by phone to deduplicate

    for (const groupId of groupIds) {
      const chat = await client.getChatById(groupId);
      if (!chat || !chat.isGroup) continue;

      const groupName = chat.name;
      const participants = chat.participants || [];

      for (const participant of participants) {
        const phone = participant.id.user;
        const serialized = participant.id._serialized;

        if (!contactMap.has(phone)) {
          // Try to get contact details
          let name = '';
          let pushname = '';
          try {
            const contact = await client.getContactById(serialized);
            name = contact.name || contact.pushname || '';
            pushname = contact.pushname || '';
          } catch (_) {
            // Contact details unavailable — use phone only
          }

          contactMap.set(phone, {
            phone: '+' + phone,
            name: name,
            pushname: pushname,
            isAdmin: participant.isAdmin ? 'Yes' : 'No',
            isSuperAdmin: participant.isSuperAdmin ? 'Yes' : 'No',
            groups: [groupName]
          });
        } else {
          // Append group name if contact already seen
          const existing = contactMap.get(phone);
          if (!existing.groups.includes(groupName)) {
            existing.groups.push(groupName);
          }
          // Update admin status if true in any group
          if (participant.isAdmin) existing.isAdmin = 'Yes';
          if (participant.isSuperAdmin) existing.isSuperAdmin = 'Yes';
        }
      }
    }

    const rows = Array.from(contactMap.values()).map(c => ({
      ...c,
      groups: c.groups.join(' | ')
    }));

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No contacts found in selected groups' });
    }

    const fields = ['phone', 'name', 'pushname', 'isAdmin', 'isSuperAdmin', 'groups'];
    const parser = new Parser({ fields });
    const csv = parser.parse(rows);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `whatsapp_contacts_${timestamp}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);

  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// Logout / reset session
app.post('/api/logout', async (req, res) => {
  try {
    if (client) {
      await client.logout();
      await client.destroy();
    }
  } catch (_) {}
  client = null;
  clientReady = false;
  groups = [];
  res.json({ ok: true });
});

// Reconnect
app.post('/api/connect', (req, res) => {
  if (clientReady) return res.json({ ok: true, message: 'Already connected' });
  createClient();
  res.json({ ok: true, message: 'Connecting...' });
});

// ─── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send current state to newly connected UI
  if (clientReady) {
    socket.emit('status', { state: 'ready', message: `Connected — ${groups.length} groups loaded` });
    socket.emit('groups', groups);
  } else {
    socket.emit('status', { state: 'disconnected', message: 'Not connected. Click Connect.' });
  }

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✅ WhatsApp Contact Exporter running at http://localhost:${PORT}\n`);
  createClient(); // auto-start on launch
});
