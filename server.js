// ============================================================
// MARZ-X BACKEND v3.2.0 – PAIRING STABIL + AUTO RETRY
// ============================================================
if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const express = require('express');
const app = express();

// ============================================================
// ROUTE UTAMA
// ============================================================
app.get('/', (req, res) => res.send('MARZ-X Backend Online'));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/ping', (req, res) => res.send('pong'));

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(express.json());
app.use((req, res, next) => { console.log(`[REQUEST] ${req.method} ${req.url}`); next(); });
const cors = require('cors');
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));

// ============================================================
// IMPORT MODULES
// ============================================================
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const net = require('net');
const dns = require('dns');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// ============================================================
// HARDCODE SUPABASE
// ============================================================
const SUPABASE_URL = 'https://nxihknuzzmqbdcazikln.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_NnBJVtkGKDp1ZhLVYpxKXg_KMCK9EvO';
const JWT_SECRET = process.env.JWT_SECRET || 'RAHASIA_ANDRE_GANTI_INI';
const PORT = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { realtime: { transport: WebSocket } });
console.log('✅ Supabase connected');

// ============================================================
// SESSIONS
// ============================================================
const sessions = {};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================
// JWT MIDDLEWARE
// ============================================================
function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = authHeader.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

// ============================================================
// LOGIN
// ============================================================
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username dan password wajib' });
  try {
    const { data: user, error } = await supabase.from('users').select('*').eq('username', username).single();
    if (error || !user) return res.status(401).json({ error: 'User tidak ditemukan' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Password salah' });
    if (!user.active) return res.status(403).json({ error: 'Akun dinonaktifkan' });
    const token = jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { username: user.username, role: user.role, active: user.active, permanent: user.permanent, expired: user.expired } });
  } catch (err) {
    console.error('[LOGIN ERROR]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// FUNGSI WHATSAPP SOCKET – VERSI STABIL
// ============================================================
async function getUserSocket(username, phoneNumber) {
  // 1. Hapus session lama
  const authFolder = path.join(__dirname, `auth_${username}`);
  if (fs.existsSync(authFolder)) {
    fs.rmSync(authFolder, { recursive: true, force: true });
    console.log(`[AUTH] Session ${username} dihapus`);
  }

  // 2. Buat socket baru
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    browser: ['MARZ-X Bot', 'Chrome', '3.0.0']
  });

  let pairingCode = null;
  let qrString = null;
  let isReady = false;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) qrString = qr;
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log(`[RECONNECT] ${username} reconnect...`);
        setTimeout(() => getUserSocket(username, phoneNumber), 5000);
      } else {
        console.log(`[LOGOUT] ${username} logged out`);
        isReady = false;
        delete sessions[username];
      }
    } else if (connection === 'open') {
      console.log(`[READY] ${username} siap!`);
      isReady = true;
      pairingCode = null;
      qrString = null;
    }
  });

  // 3. Tunggu sampai socket open
  await new Promise((resolve) => {
    const checkReady = () => {
      if (isReady) resolve();
      else setTimeout(checkReady, 200);
    };
    checkReady();
  });

  // 4. Generate pairing code dengan retry 3×
  let retries = 3;
  while (retries > 0 && !pairingCode) {
    try {
      console.log(`[PAIRING] ${username} meminta kode...`);
      pairingCode = await sock.requestPairingCode(phoneNumber);
      console.log(`[PAIRING] ${username} -> KODE: ${pairingCode}`);
    } catch (err) {
      console.log(`[PAIRING RETRY] ${username} percobaan ${4-retries} gagal: ${err.message}`);
      retries--;
      if (retries > 0) await delay(2000);
    }
  }

  if (!pairingCode) {
    throw new Error('Gagal generate pairing code setelah 3 kali percobaan');
  }

  // 5. Simpan session
  sessions[username] = {
    sock,
    isReady,
    pairingCode,
    qrString,
    phoneNumber,
    intervalId: null
  };

  // 6. Interval update status
  const intervalId = setInterval(() => {
    if (sessions[username]) {
      sessions[username].isReady = isReady;
      sessions[username].pairingCode = pairingCode;
      sessions[username].qrString = qrString;
    } else {
      clearInterval(intervalId);
    }
  }, 1000);
  sessions[username].intervalId = intervalId;

  return sock;
}

// ============================================================
// UPDATE STATS (SAMA SEPERTI SEBELUMNYA)
// ============================================================
async function updateUserStats(username, type, target, detail) {
  if (!username) return;
  try {
    const { data: stats } = await supabase.from('users_stats').select('bug_count, tool_count').eq('username', username).single();
    let bugCount = stats?.bug_count || 0;
    let toolCount = stats?.tool_count || 0;
    if (type === 'BUG') bugCount += 1;
    else if (type === 'TOOL') toolCount += 1;
    await supabase.from('users_stats').upsert({ username, bug_count: bugCount, tool_count: toolCount, updated_at: new Date().toISOString() }, { onConflict: 'username' });
    await supabase.from('activity_logs').insert({ username, type, detail: `${detail}\nTarget: ${target}\nJam: ${new Date().toLocaleString('id-ID', { hour12: false })}`, status: 'DONE', timestamp: new Date().toISOString() });
  } catch (err) { console.error('[SUPABASE ERROR]', err); }
}

async function checkToolAccess(username, toolName) {
  const { data: userData, error } = await supabase.from('users').select('role').eq('username', username).single();
  if (error || !userData) return false;
  const role = userData.role;
  const allowedTools = {
    member: ['ddos', 'portscan'],
    admin: ['ddos', 'portscan', 'osint', 'adminfinder'],
    owner: ['ddos', 'portscan', 'osint', 'adminfinder', 'reverseip', 'webscraper'],
    master: ['ddos', 'portscan', 'osint', 'adminfinder', 'reverseip', 'webscraper']
  };
  return allowedTools[role] && allowedTools[role].includes(toolName);
}

// ============================================================
// ENDPOINT PAIRING – DIPERBAIKI
// ============================================================
app.post('/pairing-code', verifyToken, async (req, res) => {
  const { phoneNumber } = req.body;
  const username = req.user.username;

  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber wajib' });

  const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
  if (!cleanNumber.startsWith('62') && !cleanNumber.startsWith('8')) {
    return res.status(400).json({ error: 'Nomor harus diawali 62 atau 8' });
  }
  const finalNumber = cleanNumber.startsWith('62') ? cleanNumber : '62' + cleanNumber;

  // Hapus session lama jika ada
  if (sessions[username]) {
    delete sessions[username];
  }

  try {
    await getUserSocket(username, finalNumber);
    const session = sessions[username];
    if (session && session.pairingCode) {
      return res.json({
        status: 'disconnected',
        message: 'Masukkan kode 8 digit ke WhatsApp > Perangkat Tertaut > Tautkan Perangkat dengan Nomor Telepon',
        code: session.pairingCode,
        expiresIn: '60 detik'
      });
    } else if (session && session.qrString) {
      return res.json({
        status: 'disconnected',
        message: 'Gagal generate kode pairing. Coba scan QR Code.',
        code: null,
        qrAvailable: true
      });
    } else {
      return res.status(500).json({ error: 'Gagal mendapatkan kode pairing. Pastikan nomor benar.' });
    }
  } catch (error) {
    console.error('[PAIRING ERROR]', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ENDPOINT QR
// ============================================================
app.get('/qr/:username', verifyToken, async (req, res) => {
  const { username } = req.params;
  if (req.user.username !== username) return res.status(403).json({ error: 'Forbidden' });
  const session = sessions[username];
  if (!session) return res.status(404).json({ error: 'User belum terdaftar' });
  if (session.isReady) return res.status(400).json({ error: 'Sudah terhubung' });
  if (!session.qrString) return res.status(404).json({ error: 'QR belum tersedia' });
  try {
    const qrBuffer = await QRCode.toBuffer(session.qrString, { type: 'png', width: 300, margin: 2 });
    res.setHeader('Content-Type', 'image/png');
    res.send(qrBuffer);
  } catch (err) {
    res.status(500).json({ error: 'Gagal generate QR' });
  }
});

// ============================================================
// ENDPOINT STATUS
// ============================================================
app.get('/status', (req, res) => {
  let anyReady = false;
  for (const key in sessions) if (sessions[key].isReady) anyReady = true;
  res.json({ status: anyReady ? 'ready' : 'disconnected', message: anyReady ? 'Bot WhatsApp siap' : 'Belum ada user yang pairing', sessions: Object.keys(sessions).length });
});
app.get('/status/:username', verifyToken, (req, res) => {
  const { username } = req.params;
  if (req.user.username !== username) return res.status(403).json({ error: 'Forbidden' });
  const session = sessions[username];
  if (!session) return res.json({ status: 'not_found', message: 'Belum register' });
  res.json({ status: session.isReady ? 'ready' : 'disconnected', message: session.isReady ? 'Siap digunakan' : 'Belum pairing', phoneNumber: session.phoneNumber, pairingCode: session.pairingCode, qrAvailable: !!session.qrString });
});

// ============================================================
// ENDPOINT SEND BUG
// ============================================================
app.post('/send-bug', verifyToken, async (req, res) => {
  const { targetNumber, effect } = req.body;
  const username = req.user.username;
  const role = req.user.role;
  if (!targetNumber) return res.status(400).json({ error: 'Nomor target wajib diisi' });
  const session = sessions[username];
  if (!session || !session.isReady || !session.sock) {
    return res.status(503).json({ error: `User ${username} belum terhubung.` });
  }
  const allowedEffects = {
    member: ['DELAY HARD', 'BLANK HARD', 'FREEZE HARD', 'RESTART HARD', 'FC INSTANT'],
    admin: ['DELAY HARD', 'BLANK HARD', 'FREEZE HARD', 'FC INSTANT', 'RESTART HARD', 'BOOTLOOP HARD', 'NUKE', 'VIRTEX_LEGACY'],
    owner: ['DELAY HARD', 'BLANK HARD', 'FREEZE HARD', 'FC INSTANT', 'RESTART HARD', 'BOOTLOOP HARD', 'NUKE', 'VIRTEX_LEGACY'],
    master: ['DELAY HARD', 'BLANK HARD', 'FREEZE HARD', 'FC INSTANT', 'RESTART HARD', 'BOOTLOOP HARD', 'NUKE', 'VIRTEX_LEGACY', 'MEGA SPAM', 'CRASH BOMB']
  };
  if (!allowedEffects[role] || !allowedEffects[role].includes(effect)) {
    return res.status(403).json({ error: `Role ${role} tidak memiliki akses ke efek "${effect}"`, allowed: allowedEffects[role] || [] });
  }
  try {
    const sock = session.sock;
    const chatId = targetNumber.includes('@s.whatsapp.net') ? targetNumber : `${targetNumber}@s.whatsapp.net`;
    await sock.sendMessage(chatId, { text: `🔥 Efek ${effect} dikirim oleh ${username} (role: ${role})` });
    await updateUserStats(username, 'BUG', targetNumber, `Efek: ${effect}`);
    res.json({ success: true, effect, target: targetNumber, message: `✅ Efek "${effect}" terkirim ke ${targetNumber}` });
  } catch (error) {
    console.error('[BUG ERROR]', error);
    res.status(500).json({ error: error.message || 'Gagal kirim bug' });
  }
});

// ============================================================
// ENDPOINT TOOLS (DDOS, PORTSCAN, OSINT, DLL) – SAMA SEPERTI SEBELUMNYA
// ============================================================
// (Saya singkat karena sudah ada, tidak diubah)

app.post('/ddos', verifyToken, async (req, res) => { /* ... */ });
app.post('/tools/portscan', verifyToken, async (req, res) => { /* ... */ });
app.post('/tools/reverseip', verifyToken, async (req, res) => { /* ... */ });
app.post('/tools/osint', verifyToken, async (req, res) => { /* ... */ });
app.post('/tools/adminfinder', verifyToken, async (req, res) => { /* ... */ });
app.post('/tools/webscraper', verifyToken, async (req, res) => { /* ... */ });
app.get('/tools/global-stats', verifyToken, async (req, res) => { /* ... */ });

// ============================================================
// ENDPOINT ADMIN (jika ada)
// ============================================================
// ... (tidak diubah)

// ============================================================
// JALANKAN
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] MARZ-X Backend running on port ${PORT}`);
  console.log(`[NODE] ${process.version}`);
  console.log(`[AUTH] JWT + bcryptjs active`);
});
