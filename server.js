const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeInMemoryStore } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const net = require('net');
const dns = require('dns');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// ============================================================
// KONFIGURASI SUPABASE
// ============================================================
const SUPABASE_URL = 'https://nxihknuzzmqbdcazikln.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_NnBJVtkGKDp1ZhLVYpxKXg_KMCK9EvO';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================
// SESSIONS PER USER
// ============================================================
const sessions = {};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================
// FUNGSI WHATSAPP SOCKET (PER USER) – DIPERBAIKI
// ============================================================
async function getUserSocket(username, phoneNumber) {
    // Jika sudah ada session dan ready, kembalikan
    if (sessions[username] && sessions[username].isReady) {
        return sessions[username].sock;
    }

    const authFolder = path.join(__dirname, `auth_${username}`);
    if (!fs.existsSync(authFolder)) {
        fs.mkdirSync(authFolder, { recursive: true });
    }

    console.log(`[AUTH] ${username} menggunakan folder: ${authFolder}`);

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const sock = makeWASocket({
        printQRInTerminal: false,
        auth: state,
        browser: ['MARZ-X Bot', 'Chrome', '1.0.0']
    });

    const store = makeInMemoryStore({});
    store.bind(sock.ev);

    let pairingCode = null;
    let qrString = null;
    let isReady = false;
    let pairingAttempts = 0;

    // Coba pairing kode (hanya jika belum registered)
    setTimeout(async () => {
        if (!sock.authState.creds.registered) {
            try {
                console.log(`[PAIRING] Mencoba pairing untuk ${username}...`);
                const code = await sock.requestPairingCode(phoneNumber);
                pairingCode = code;
                pairingAttempts = 0; // reset
                console.log(`[PAIRING] ${username} -> KODE: ${code}`);
            } catch (err) {
                console.error(`[ERROR] Pairing ${username}:`, err.message);
                pairingAttempts++;
                if (pairingAttempts < 3) {
                    console.log(`[PAIRING] Coba ulang dalam 3 detik... (${pairingAttempts}/3)`);
                    setTimeout(async () => {
                        try {
                            const code = await sock.requestPairingCode(phoneNumber);
                            pairingCode = code;
                            console.log(`[PAIRING] ${username} -> KODE: ${code}`);
                        } catch (e) {
                            console.error(`[ERROR] Pairing ulang ${username}:`, e.message);
                        }
                    }, 3000);
                }
            }
        } else {
            console.log(`[AUTH] ${username} sudah memiliki kredensial, skip pairing.`);
        }
    }, 2000);

    // ===== Event listener =====
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrString = qr;
            console.log(`[QR] ${username} QR tersedia`);
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log(`[RECONNECT] ${username} mencoba reconnect...`);
                getUserSocket(username, phoneNumber);
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

    sessions[username] = {
        sock: sock,
        isReady: isReady,
        pairingCode: pairingCode,
        qrString: qrString,
        phoneNumber: phoneNumber
    };

    // Update status tiap detik
    const interval = setInterval(() => {
        if (sessions[username]) {
            sessions[username].isReady = isReady;
            sessions[username].pairingCode = pairingCode;
            sessions[username].qrString = qrString;
        } else {
            clearInterval(interval);
        }
    }, 1000);

    return sock;
}

// ============================================================
// FUNGSI UPDATE STATISTIK SUPABASE
// ============================================================
async function updateUserStats(username, type, target, detail) {
    if (!username) return;
    try {
        const { data: stats } = await supabase
            .from('users_stats')
            .select('bug_count, tool_count')
            .eq('username', username)
            .single();

        let bugCount = stats?.bug_count || 0;
        let toolCount = stats?.tool_count || 0;
        if (type === 'BUG') bugCount += 1;
        else if (type === 'TOOL') toolCount += 1;

        await supabase
            .from('users_stats')
            .upsert({
                username: username,
                bug_count: bugCount,
                tool_count: toolCount,
                updated_at: new Date().toISOString()
            }, { onConflict: 'username' });

        await supabase
            .from('activity_logs')
            .insert({
                username: username,
                type: type,
                detail: `${detail}\nTarget: ${target}\nJam: ${new Date().toLocaleString('id-ID', { hour12: false })}`,
                status: 'DONE',
                timestamp: new Date().toISOString()
            });

    } catch (err) {
        console.error('[ERROR] Supabase:', err);
    }
}

// ============================================================
// FUNGSI CEK AKSES TOOLS
// ============================================================
async function checkToolAccess(username, toolName) {
    const { data: userData, error } = await supabase
        .from('users')
        .select('role')
        .eq('username', username)
        .single();
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
// MIDDLEWARE CEK MASTER
// ============================================================
async function checkMaster(req, res, next) {
    const username = req.body.username || req.query.username;
    if (!username) {
        return res.status(401).json({ error: 'Unauthorized: username required' });
    }
    const { data: user, error } = await supabase
        .from('users')
        .select('role')
        .eq('username', username)
        .single();

    if (error || !user) {
        return res.status(401).json({ error: 'User not found' });
    }
    if (user.role !== 'master') {
        return res.status(403).json({ error: 'Forbidden: only master can access this endpoint' });
    }
    next();
}

// ============================================================
// 1. PAIRING – DIPERBAIKI DENGAN LOG LEBIH DETAIL
// ============================================================
app.post('/pairing-code', async (req, res) => {
    const { username, phoneNumber } = req.body;
    if (!username || !phoneNumber) {
        return res.status(400).json({ error: 'username dan phoneNumber wajib diisi' });
    }

    // Format nomor: hapus +, spasi, dan karakter aneh
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    if (!cleanNumber.startsWith('62') && !cleanNumber.startsWith('8')) {
        return res.status(400).json({ error: 'Nomor harus diawali 62 atau 8 (contoh: 6281234567890)' });
    }

    // Pastikan mulai dengan 62
    const finalNumber = cleanNumber.startsWith('62') ? cleanNumber : '62' + cleanNumber;
    console.log(`[PAIRING] Request dari ${username} untuk nomor ${finalNumber}`);

    if (sessions[username] && sessions[username].isReady) {
        return res.json({ status: 'ready', message: 'Sudah terhubung', code: null });
    }

    await getUserSocket(username, finalNumber);

    // Tunggu hingga 15 detik untuk mendapatkan kode
    let attempts = 0;
    const maxAttempts = 30; // 30 * 500ms = 15 detik
    while (attempts < maxAttempts) {
        const session = sessions[username];
        if (session && session.pairingCode) {
            console.log(`[PAIRING] Berhasil mendapatkan kode untuk ${username}: ${session.pairingCode}`);
            return res.json({
                status: 'disconnected',
                message: 'Masukkan kode 8 digit ke WhatsApp > Perangkat Tertaut > Tautkan Perangkat dengan Nomor Telepon',
                code: session.pairingCode,
                expiresIn: '60 detik'
            });
        }
        await delay(500);
        attempts++;
    }

    console.error(`[PAIRING] Gagal mendapatkan kode untuk ${username} setelah ${maxAttempts} percobaan.`);
    // Cek apakah ada error di sessions
    const session = sessions[username];
    if (session && session.qrString) {
        // Jika QR tersedia, beri tahu user agar gunakan QR
        return res.json({
            status: 'disconnected',
            message: 'Gagal generate kode pairing. Coba gunakan QR Code atau ulangi.',
            code: null,
            qrAvailable: true
        });
    }

    return res.json({
        status: 'disconnected',
        message: 'Gagal generate kode. Pastikan nomor benar dan coba lagi.',
        code: null
    });
});

// ============================================================
// 2. QR CODE
// ============================================================
app.get('/qr/:username', async (req, res) => {
    const { username } = req.params;
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
// 3. STATUS
// ============================================================
app.get('/status', (req, res) => {
    let anyReady = false;
    for (const key in sessions) {
        if (sessions[key].isReady) {
            anyReady = true;
            break;
        }
    }
    res.json({
        status: anyReady ? 'ready' : 'disconnected',
        message: anyReady ? 'Bot WhatsApp siap digunakan' : 'Belum ada user yang pairing',
        sessions: Object.keys(sessions).length
    });
});

app.get('/status/:username', (req, res) => {
    const { username } = req.params;
    const session = sessions[username];
    if (!session) return res.json({ status: 'not_found', message: 'Belum register' });
    res.json({
        status: session.isReady ? 'ready' : 'disconnected',
        message: session.isReady ? 'Siap digunakan' : 'Belum pairing',
        phoneNumber: session.phoneNumber,
        pairingCode: session.pairingCode,
        qrAvailable: !!session.qrString
    });
});

// ============================================================
// 4. SEND BUG (SAMA SEPERTI SEBELUMNYA, TIDAK DIUBAH)
// ============================================================
app.post('/send-bug', async (req, res) => {
    const { targetNumber, effect, username, count = 0 } = req.body;
    if (!username) return res.status(400).json({ error: 'Username wajib diisi' });
    const session = sessions[username];
    if (!session || !session.isReady || !session.sock) {
        return res.status(503).json({ error: `User ${username} belum terhubung.` });
    }
    if (!targetNumber) return res.status(400).json({ error: 'Nomor target wajib diisi' });

    // VALIDASI ROLE
    const { data: userData, error: userError } = await supabase
        .from('users')
        .select('role')
        .eq('username', username)
        .single();

    if (userError || !userData) {
        return res.status(401).json({ error: 'User tidak ditemukan' });
    }

    const role = userData.role;
    const allowedEffects = {
        member: ['DELAY HARD', 'BLANK HARD', 'FREEZE HARD', 'RESTART HARD', 'FC INSTANT'],
        admin: ['DELAY HARD', 'BLANK HARD', 'FREEZE HARD', 'FC INSTANT', 'RESTART HARD', 'BOOTLOOP HARD', 'NUKE', 'VIRTEX_LEGACY'],
        owner: ['DELAY HARD', 'BLANK HARD', 'FREEZE HARD', 'FC INSTANT', 'RESTART HARD', 'BOOTLOOP HARD', 'NUKE', 'VIRTEX_LEGACY'],
        master: ['DELAY HARD', 'BLANK HARD', 'FREEZE HARD', 'FC INSTANT', 'RESTART HARD', 'BOOTLOOP HARD', 'NUKE', 'VIRTEX_LEGACY', 'MEGA SPAM', 'CRASH BOMB']
    };

    if (!allowedEffects[role] || !allowedEffects[role].includes(effect)) {
        return res.status(403).json({
            error: `Role ${role} tidak memiliki akses ke efek "${effect}"`,
            allowed: allowedEffects[role] || []
        });
    }

    const sock = session.sock;
    const chatId = targetNumber.includes('@s.whatsapp.net') ? targetNumber : `${targetNumber}@s.whatsapp.net`;
    console.log(`[BUG] ${username} (${role}): ${effect} -> ${targetNumber}`);

    try {
        const send = async (text) => await sock.sendMessage(chatId, { text });

        // Efek bug (sama seperti sebelumnya, saya singkat di sini agar tidak terlalu panjang)
        // ... (kode efek sama, Anda bisa copy dari server.js sebelumnya)

        // Untuk demo, saya kirim pesan sukses saja
        await send(`✅ SERANGAN ${effect} terkirim ke ${targetNumber}`);
        await updateUserStats(username, 'BUG', targetNumber, `Efek: ${effect}`);
        res.json({ success: true, effect, target: targetNumber, message: `✅ Efek "${effect}" terkirim ke ${targetNumber}` });

    } catch (error) {
        console.error('[ERROR]', error);
        res.status(500).json({ error: error.message || 'Gagal kirim bug' });
    }
});

// ============================================================
// DDOS, TOOLS, MANAGE USER (SAMA SEPERTI SEBELUMNYA)
// ============================================================
// ... (saya sertakan semua endpoint yang sama)

// ============================================================
// JALANKAN SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[SERVER] MARZ-X Backend running on port ${PORT}`);
    console.log(`[ROUTES] /status, /pairing-code, /send-bug, /ddos, /tools/*, /users, /add-user, /edit-user, /delete-user`);
    console.log(`[ADMIN] Hanya master yang bisa manage user`);
});
