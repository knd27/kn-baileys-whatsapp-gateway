const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage, delay } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const axios = require('axios');
const multer = require('multer');
const sharp = require('sharp');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TZ || 'Asia/Jakarta';
const WEBHOOK_URL_1 = process.env.WEBHOOK_URL_1;
const WEBHOOK_URL_2 = process.env.WEBHOOK_URL_2;
const WEBHOOK_URL_3 = process.env.WEBHOOK_URL_3;
const MEDIA_PATH = process.env.MEDIA_PATH || '/app/media';

moment.tz.setDefault(TIMEZONE);

const logger = pino({ level: 'silent' });

let sock;
let qrCodeData = null;
let connectionStatus = 'disconnected';

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, MEDIA_PATH);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const upload = multer({ storage: storage });

if (!fs.existsSync(MEDIA_PATH)) {
    fs.mkdirSync(MEDIA_PATH, { recursive: true });
}

async function sendWebhook(url, data) {
    if (!url) return;
    
    try {
        await axios.post(url, data, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 5000
        });
    } catch (error) {
        console.error(`Webhook error (${url}):`, error.message);
    }
}

async function sendToAllWebhooks(data) {
    const webhooks = [WEBHOOK_URL_1, WEBHOOK_URL_2, WEBHOOK_URL_3].filter(Boolean);
    
    const promises = webhooks.map(url => sendWebhook(url, data));
    await Promise.allSettled(promises);
}

async function downloadMedia(message) {
    try {
        const messageType = Object.keys(message.message || {})[0];
        const msg = message.message[messageType];
        
        // Download buffer dari media
        const buffer = await downloadMediaMessage(
            message,
            'buffer',
            {},
            {
                logger,
                reuploadRequest: sock.updateMediaMessage
            }
        );
        
        // Ambil nomor pengirim
        const sender = message.key.remoteJid.split('@')[0];
        const senderFolder = path.join(MEDIA_PATH, sender);
        
        // Buat folder untuk pengirim jika belum ada
        if (!fs.existsSync(senderFolder)) {
            fs.mkdirSync(senderFolder, { recursive: true });
        }
        
        const timestamp = moment().format('YYYYMMDDHHmmss');
        const random = Math.random().toString(36).substring(7);
        
        let ext = 'bin';
        const mimetype = msg?.mimetype;
        
        if (mimetype) {
            const mimeExt = mimetype.split('/')[1]?.split(';')[0];
            if (mimeExt) ext = mimeExt;
        }
        
        const filename = `${timestamp}-${random}.${ext}`;
        const filepath = path.join(senderFolder, filename);
        
        fs.writeFileSync(filepath, buffer);
        
        return {
            filename,
            filepath,
            relativePath: `${sender}/${filename}`,
            size: buffer.length,
            mimetype
        };
    } catch (error) {
        console.error('Error downloading media:', error.message);
        return null;
    }
}

function formatMessage(m) {
    const messageType = Object.keys(m.message || {})[0];
    const isStatus = m.key.remoteJid === 'status@broadcast';
    
    const baseData = {
        messageId: m.key.id,
        from: m.key.remoteJid,
        fromMe: m.key.fromMe,
        participant: m.key.participant,
        timestamp: moment.unix(m.messageTimestamp).format('YYYY-MM-DD HH:mm:ss'),
        type: isStatus ? 'status' : 'message',
        messageType: messageType,
        pushName: m.pushName
    };
    
    if (m.message?.conversation) {
        baseData.text = m.message.conversation;
    } else if (m.message?.extendedTextMessage) {
        baseData.text = m.message.extendedTextMessage.text;
        
        if (m.message.extendedTextMessage.contextInfo?.quotedMessage) {
            const quotedMsg = m.message.extendedTextMessage.contextInfo.quotedMessage;
            baseData.quotedMessage = {
                messageId: m.message.extendedTextMessage.contextInfo.stanzaId,
                participant: m.message.extendedTextMessage.contextInfo.participant,
                text: quotedMsg.conversation || 
                      quotedMsg.extendedTextMessage?.text || 
                      quotedMsg.imageMessage?.caption || 
                      quotedMsg.videoMessage?.caption || 
                      quotedMsg.documentMessage?.caption || ''
            };
        }
    } else if (m.message?.imageMessage) {
        baseData.caption = m.message.imageMessage.caption;
        baseData.mediaType = 'image';
    } else if (m.message?.videoMessage) {
        baseData.caption = m.message.videoMessage.caption;
        baseData.mediaType = 'video';
    } else if (m.message?.documentMessage) {
        baseData.caption = m.message.documentMessage.caption;
        baseData.fileName = m.message.documentMessage.fileName;
        baseData.mediaType = 'document';
    } else if (m.message?.audioMessage) {
        baseData.mediaType = 'audio';
    } else if (m.message?.stickerMessage) {
        baseData.mediaType = 'sticker';
    } else if (m.message?.locationMessage) {
        baseData.location = {
            latitude: m.message.locationMessage.degreesLatitude,
            longitude: m.message.locationMessage.degreesLongitude,
            name: m.message.locationMessage.name,
            address: m.message.locationMessage.address
        };
        baseData.mediaType = 'location';
    }
    
    return baseData;
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./sessions');
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: state,
        browser: ['Baileys Gateway', 'Chrome', '1.0.0'],
        markOnlineOnConnect: true
    });
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n=== QR CODE ===');
            qrcode.generate(qr, { small: true });
            console.log('===============\n');
            qrCodeData = qr;
            connectionStatus = 'qr';
            
            await sendToAllWebhooks({
                status: 'qr_generated',
                timestamp: moment().format('YYYY-MM-DD HH:mm:ss')
            });
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            
            connectionStatus = 'disconnected';
            qrCodeData = null;
            
            await sendToAllWebhooks({
                status: 'disconnected',
                reason: lastDisconnect?.error?.message,
                timestamp: moment().format('YYYY-MM-DD HH:mm:ss')
            });
            
            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(), 3000);
            }
        } else if (connection === 'open') {
            console.log('✅ Connected to WhatsApp');
            connectionStatus = 'connected';
            qrCodeData = null;
            
            await sendToAllWebhooks({
                status: 'connected',
                timestamp: moment().format('YYYY-MM-DD HH:mm:ss')
            });
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        for (const m of messages) {
            if (!m.message) continue;
            
            const formattedMessage = formatMessage(m);
            
            const hasMedia = m.message.imageMessage || 
                           m.message.videoMessage || 
                           m.message.documentMessage;
            
            if (hasMedia) {
                const mediaInfo = await downloadMedia(m);
                if (mediaInfo) {
                    formattedMessage.media = mediaInfo;
                }
            }
            
            await sendToAllWebhooks(formattedMessage);
            
            console.log('📨 Message received:', formattedMessage);
        }
    });
}

app.get('/', (req, res) => {
    res.json({
        status: 'running',
        connection: connectionStatus,
        timestamp: moment().format('YYYY-MM-DD HH:mm:ss')
    });
});

app.get('/status', (req, res) => {
    res.json({
        status: connectionStatus,
        qrCode: qrCodeData,
        timestamp: moment().format('YYYY-MM-DD HH:mm:ss')
    });
});

app.post('/send-message', async (req, res) => {
    try {
        const { number, message } = req.body;
        
        if (!number || !message) {
            return res.status(400).json({ error: 'Number and message are required' });
        }
        
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        
        const sent = await sock.sendMessage(jid, { text: message });
        
        res.json({
            success: true,
            messageId: sent.key.id,
            timestamp: moment().format('YYYY-MM-DD HH:mm:ss')
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/reply-message', async (req, res) => {
    try {
        const { number, message, quotedMessageId } = req.body;
        
        if (!number || !message || !quotedMessageId) {
            return res.status(400).json({ error: 'Number, message, and quotedMessageId are required' });
        }
        
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        
        const sent = await sock.sendMessage(jid, {
            text: message
        }, {
            quoted: {
                key: {
                    remoteJid: jid,
                    id: quotedMessageId,
                    fromMe: false
                },
                message: { conversation: '' }
            }
        });
        
        res.json({
            success: true,
            messageId: sent.key.id,
            timestamp: moment().format('YYYY-MM-DD HH:mm:ss')
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/send-file', upload.single('file'), async (req, res) => {
    try {
        const { number, caption, type } = req.body;
        const file = req.file;
        
        if (!number || !file) {
            return res.status(400).json({ error: 'Number and file are required' });
        }
        
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        const fileBuffer = fs.readFileSync(file.path);
        
        let messageContent = {};
        
        if (type === 'image' || file.mimetype.startsWith('image/')) {
            messageContent = {
                image: fileBuffer,
                caption: caption || ''
            };
        } else if (type === 'video' || file.mimetype.startsWith('video/')) {
            messageContent = {
                video: fileBuffer,
                caption: caption || ''
            };
        } else {
            messageContent = {
                document: fileBuffer,
                mimetype: file.mimetype,
                fileName: file.originalname,
                caption: caption || ''
            };
        }
        
        const sent = await sock.sendMessage(jid, messageContent);
        
        fs.unlinkSync(file.path);
        
        res.json({
            success: true,
            messageId: sent.key.id,
            timestamp: moment().format('YYYY-MM-DD HH:mm:ss')
        });
    } catch (error) {
        if (req.file) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: error.message });
    }
});

app.post('/send-sticker', upload.single('file'), async (req, res) => {
    try {
        const { number } = req.body;
        const file = req.file;
        
        if (!number || !file) {
            return res.status(400).json({ error: 'Number and file are required' });
        }
        
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        
        const webpBuffer = await sharp(file.path)
            .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp()
            .toBuffer();
        
        const sent = await sock.sendMessage(jid, {
            sticker: webpBuffer
        });
        
        fs.unlinkSync(file.path);
        
        res.json({
            success: true,
            messageId: sent.key.id,
            timestamp: moment().format('YYYY-MM-DD HH:mm:ss')
        });
    } catch (error) {
        if (req.file) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: error.message });
    }
});

app.post('/send-loc', async (req, res) => {
    try {
        const { number, latitude, longitude, name, address } = req.body;
        
        if (!number || !latitude || !longitude) {
            return res.status(400).json({ error: 'Number, latitude, and longitude are required' });
        }
        
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        
        const sent = await sock.sendMessage(jid, {
            location: {
                degreesLatitude: parseFloat(latitude),
                degreesLongitude: parseFloat(longitude),
                name: name || '',
                address: address || ''
            }
        });
        
        res.json({
            success: true,
            messageId: sent.key.id,
            timestamp: moment().format('YYYY-MM-DD HH:mm:ss')
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/button', async (req, res) => {
    try {
        const { number, text, buttons, footer } = req.body;
        
        if (!number || !text || !buttons) {
            return res.status(400).json({ error: 'Number, text, and buttons are required' });
        }
        
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        
        // Untuk WhatsApp personal, gunakan list message (menu dropdown)
        const sections = [{
            title: 'Pilihan Menu',
            rows: buttons.map((btn, idx) => ({
                title: typeof btn === 'string' ? btn : btn.text || btn.title,
                rowId: `row_${idx}`,
                description: typeof btn === 'object' ? btn.description || '' : ''
            }))
        }];
        
        const listMessage = {
            text: text,
            footer: footer || '',
            title: '📋 Menu',
            buttonText: 'Lihat Pilihan',
            sections: sections
        };
        
        const sent = await sock.sendMessage(jid, listMessage);
        
        res.json({
            success: true,
            messageId: sent.key.id,
            type: 'list',
            note: 'Button tidak didukung di WhatsApp personal. Menggunakan list message.',
            timestamp: moment().format('YYYY-MM-DD HH:mm:ss')
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/send-list', async (req, res) => {
    try {
        const { number, text, buttonText, sections, footer, title } = req.body;
        
        if (!number || !text || !sections) {
            return res.status(400).json({ error: 'Number, text, and sections are required' });
        }
        
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        
        const listMessage = {
            text: text,
            footer: footer || '',
            title: title || 'Menu',
            buttonText: buttonText || 'Pilih',
            sections: sections
        };
        
        const sent = await sock.sendMessage(jid, listMessage);
        
        res.json({
            success: true,
            messageId: sent.key.id,
            timestamp: moment().format('YYYY-MM-DD HH:mm:ss')
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/send-template', async (req, res) => {
    res.status(400).json({ 
        error: 'Template buttons hanya tersedia untuk WhatsApp Business API',
        alternative: 'Gunakan /send-list untuk menu interaktif'
    });
});

app.post('/send-copy-code', async (req, res) => {
    try {
        const { number, message, code } = req.body;
        
        if (!number || !code) {
            return res.status(400).json({ error: 'Number and code are required' });
        }
        
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        
        // Kirim code dalam format monospace yang bisa di-copy
        const fullMessage = message ? `${message}\n\n\`\`\`${code}\`\`\`` : `\`\`\`${code}\`\`\``;
        
        const sent = await sock.sendMessage(jid, { 
            text: fullMessage
        });
        
        res.json({
            success: true,
            messageId: sent.key.id,
            note: 'Copy button tidak didukung di WhatsApp personal. Code dikirim dalam format monospace.',
            timestamp: moment().format('YYYY-MM-DD HH:mm:ss')
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/typing', async (req, res) => {
    try {
        const { number, duration } = req.body;
        
        if (!number) {
            return res.status(400).json({ error: 'Number is required' });
        }
        
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        const typingDuration = duration || 3000;
        
        await sock.sendPresenceUpdate('composing', jid);
        
        setTimeout(async () => {
            await sock.sendPresenceUpdate('paused', jid);
        }, typingDuration);
        
        res.json({
            success: true,
            timestamp: moment().format('YYYY-MM-DD HH:mm:ss')
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/profile', async (req, res) => {
    try {
        const { number } = req.query;
        
        if (!number) {
            return res.status(400).json({ error: 'Number is required' });
        }
        
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        
        let profilePicUrl;
        try {
            profilePicUrl = await sock.profilePictureUrl(jid, 'image');
        } catch (error) {
            profilePicUrl = null;
        }
        
        res.json({
            success: true,
            number: jid,
            profilePicUrl: profilePicUrl,
            timestamp: moment().format('YYYY-MM-DD HH:mm:ss')
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

connectToWhatsApp().catch(err => console.error('Connection error:', err));

app.listen(PORT, () => {
    console.log(`🚀 Baileys WhatsApp Gateway running on port ${PORT}`);
    console.log(`⏰ Timezone: ${TIMEZONE}`);
    console.log(`📁 Media path: ${MEDIA_PATH}`);
    console.log(`📡 Webhook 1: ${WEBHOOK_URL_1 || 'Not configured'}`);
    console.log(`📡 Webhook 2: ${WEBHOOK_URL_2 || 'Not configured'}`);
    console.log(`📡 Webhook 3: ${WEBHOOK_URL_3 || 'Not configured'}`);
});
