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

let client = null;
let clientReady = false;
let groups = [];
let linkingMethod = 'qr';
let pendingPhoneNumber = null;

function createClient(method = 'qr', phoneNumber = null) {
  linkingMethod = method;
  pendingPhoneNumber = phoneNumber;

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ||
        '/usr/bin/chromium' ||
        '/usr/bin/chromium-browser' ||
        '/usr/bin/google-chrome',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
        '--disable-software-rasterizer'
      ]
    }
  });

  client.on('qr', async (qr) => {
    if (linkingMethod === 'phone' && pendingPhoneNumber) {
      try {
        const code = await client.requestPairingCode(pendingPhoneNumber);
        io.emit('pairing_code', code);
        io.emit('status', { state: 'pairing', message: 'Enter the code in WhatsApp to link' });
      } catch (err) {
        try {
          const qrDataUrl = await qrcode.toDataURL(qr);
          io.emit('qr', qrDataUrl);
          io.emit('status', { state: 'qr', message: 'Pairing code failed — scan QR instead' });
        } catch (_) {}
      }
    } else {
      try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        io.emit('qr', qrDataUrl);
        io.emit('status', { state: 'qr', message: 'Scan the QR code with WhatsApp' });
      } catch (err) {
        console.error('QR error:', err);
      }
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
    io.emit('status', { state: 'auth_failure', message: 'Authentication failed. Please try again.' });
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

// Best name resolver — saved name > WA profile name > pushname > blank
async function getBestName(serialized) {
  try {
    const contact = await client.getContactById(serialized);
    if (contact.name && contact.name.trim()) {
      return { name: contact.name.trim(), whatsapp_name: contact.pushname || '', source: 'saved' };
    }
    if (contact.pushname && contact.pushname.trim()) {
      return { name: contact.pushname.trim(), whatsapp_name: contact.pushname.trim(), source: 'whatsapp' };
    }
    if (contact.shortName && contact.shortName.trim()) {
      return { name: contact.shortName.trim(), whatsapp_name: '', source: 'short' };
    }
    return { name: '', whatsapp_name: '', source: 'none' };
  } catch (_) {
    return { name: '', whatsapp_name: '', source: 'error' };
  }
}

// ─── REST Endpoints ────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json({ ready: clientReady, groupCount: groups.length });
});

app.get('/api/groups', (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'Client not ready' });
  res.json(groups);
});

app.post('/api/connect/qr', (req, res) => {
  if (clientReady) return res.json({ ok: true, message: 'Already connected' });
  if (client) { try { client.destroy(); } catch (_) {} }
  createClient('qr');
  res.json({ ok: true, message: 'Starting QR login...' });
});

app.post('/api/connect/phone', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length < 10) return res.status(400).json({ error: 'Invalid phone number' });
  if (clientReady) return res.json({ ok: true, message: 'Already connected' });
  if (client) { try { client.destroy(); } catch (_) {} }
  createClient('phone', cleaned);
  res.json({ ok: true, message: 'Requesting pairing code...' });
});

app.post('/api/export', async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'Client not ready' });
  const { groupIds } = req.body;
  if (!groupIds || !Array.isArray(groupIds) || groupIds.length === 0) {
    return res.status(400).json({ error: 'Provide at least one groupId' });
  }

  try {
    const contactMap = new Map();
    let processed = 0, total = 0;

    for (const groupId of groupIds) {
      const chat = await client.getChatById(groupId);
      if (chat && chat.isGroup) total += (chat.participants || []).length;
    }

    io.emit('export_progress', { processed: 0, total, message: 'Starting export...' });

    for (const groupId of groupIds) {
      const chat = await client.getChatById(groupId);
      if (!chat || !chat.isGroup) continue;
      const groupName = chat.name;
      const participants = chat.participants || [];

      for (const participant of participants) {
        const phone = participant.id.user;
        const serialized = participant.id._serialized;
        processed++;
        io.emit('export_progress', { processed, total, message: `Fetching contact ${processed} of ${total}...` });

        if (!contactMap.has(phone)) {
          const nameInfo = await getBestName(serialized);
          contactMap.set(phone, {
            phone: '+' + phone,
            name: nameInfo.name,
            whatsapp_name: nameInfo.whatsapp_name,
            name_source: nameInfo.source,
            isAdmin: participant.isAdmin ? 'Yes' : 'No',
            isSuperAdmin: participant.isSuperAdmin ? 'Yes' : 'No',
            groups: [groupName]
          });
        } else {
          const existing = contactMap.get(phone);
          if (!existing.groups.includes(groupName)) existing.groups.push(groupName);
          if (participant.isAdmin) existing.isAdmin = 'Yes';
          if (participant.isSuperAdmin) existing.isSuperAdmin = 'Yes';
        }
      }
    }

    const rows = Array.from(contactMap.values()).map(c => ({ ...c, groups: c.groups.join(' | ') }));
    if (rows.length === 0) return res.status(404).json({ error: 'No contacts found' });

    const fields = ['phone', 'name', 'whatsapp_name', 'name_source', 'isAdmin', 'isSuperAdmin', 'groups'];
    const csv = new Parser({ fields }).parse(rows);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="whatsapp_contacts_${timestamp}.csv"`);
    res.send(csv);

  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

app.post('/api/logout', async (req, res) => {
  try { if (client) { await client.logout(); await client.destroy(); } } catch (_) {}
  client = null; clientReady = false; groups = [];
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  if (clientReady) {
    socket.emit('status', { state: 'ready', message: `Connected — ${groups.length} groups loaded` });
    socket.emit('groups', groups);
  } else {
    socket.emit('status', { state: 'disconnected', message: 'Not connected. Choose a login method.' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✅ WhatsApp Contact Exporter running at http://localhost:${PORT}\n`);
});
