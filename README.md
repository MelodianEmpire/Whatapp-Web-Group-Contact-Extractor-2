# 📲 WhatsApp Contact Exporter

Export contacts from your WhatsApp groups to CSV — unlimited groups, deduplicated contacts.

---

## What it does

- Connects to your WhatsApp via QR code (just like WhatsApp Web)
- Lists all your groups — you pick which ones to export
- Exports every member's phone number, name, and group membership to a CSV file
- Deduplicates contacts that appear in multiple groups
- Works with WhatsApp Personal and WhatsApp Business

---

## Requirements

- **Node.js 18+** — https://nodejs.org
- **Google Chrome or Chromium** installed on your server/machine
- A phone with WhatsApp to scan the QR code

---

## Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Start the app
npm start

# 3. Open your browser
# Go to: http://localhost:3000

# 4. Scan the QR code with your WhatsApp
# WhatsApp → Linked Devices → Link a Device

# 5. Select your groups and click Export
```

---

## Deploy to Railway (Free)

1. Create a free account at https://railway.app
2. Click **New Project → Deploy from GitHub Repo**
3. Push this folder to a GitHub repo and connect it
4. Railway auto-detects Node.js and runs `npm start`
5. Your app will be live at a public URL

**Important for Railway/Render:** Add this env variable:
```
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false
```

---

## Deploy to Render (Free)

1. Create account at https://render.com
2. New → Web Service → Connect your GitHub repo
3. Set:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Set environment variable: `NODE_ENV=production`

---

## Deploy to a VPS (Ubuntu/Debian)

```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Chromium (required by puppeteer)
sudo apt-get install -y chromium-browser

# Clone or upload your project, then:
cd whatsapp-exporter
npm install
npm start

# Keep it running with PM2
npm install -g pm2
pm2 start src/server.js --name wa-exporter
pm2 save
pm2 startup
```

---

## CSV Output Format

The exported CSV contains these columns:

| Column       | Description                              |
|--------------|------------------------------------------|
| phone        | Phone number with country code (+234...) |
| name         | Contact name (from your phonebook)       |
| pushname     | Name the person set in WhatsApp          |
| isAdmin      | Yes/No — group admin status              |
| isSuperAdmin | Yes/No — group creator status            |
| groups       | Groups they belong to (pipe-separated)   |

---

## Troubleshooting

**QR code not showing:**
- Wait 10-15 seconds for Chromium to launch
- Refresh the page

**"Cannot find module" error:**
- Run `npm install` again

**Contacts show no name:**
- WhatsApp only shares names for contacts saved in your phone
- Unknown numbers will have an empty name but correct phone number

**Session expires:**
- Your login is saved in `.wwebjs_auth/` folder
- You only need to scan once; it persists across restarts

---

## Notes

This app uses [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js), an unofficial WhatsApp Web client.
It works by automating a headless Chrome browser — exactly like using WhatsApp Web yourself.
Use responsibly on a number you own.
