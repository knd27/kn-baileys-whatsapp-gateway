const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  delay,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const axios = require("axios");
const multer = require("multer");
const sharp = require("sharp");
const mariadb = require("mariadb");
const { send } = require("process");

const app = express();
BigInt.prototype.toJSON = function () {
  return this.toString();
};
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TZ || "Asia/Jakarta";
const WEBHOOK_URL_1 = process.env.WEBHOOK_URL_1;
const WEBHOOK_URL_2 = process.env.WEBHOOK_URL_2;
const WEBHOOK_URL_3 = process.env.WEBHOOK_URL_3;
const MEDIA_PATH = process.env.MEDIA_PATH || "/app/media";
const SESSION_DIR = "./sessions";
const LOG_DIR = "/app/log";
const LOG_FILE = `${LOG_DIR}/baileys.log`;
const DB_TABLE = process.env.DB_TABLE || "messages";
let ME_NUMBER = process.env.ME_NUMBER || null; // nomor akun WhatsApp utama (untuk fromMe handling)
let ME_pushName = "";

moment.tz.setDefault(TIMEZONE);

const logger = pino({ level: "silent" });

let sock;
let qrCodeData = null;
let connectionStatus = "disconnected";

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, MEDIA_PATH);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  },
});

const upload = multer({ storage: storage });

if (!fs.existsSync(MEDIA_PATH)) {
  fs.mkdirSync(MEDIA_PATH, { recursive: true });
}

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  console.log("Created log directory:", LOG_DIR);
}

function logBaileysEvent(data) {
  try {
    const tgl = moment().format("YYYY-MM-DD HH:mm:ss") + " WIB";
    const line = tgl + "\n" + data + "\n\n";
    fs.appendFile(LOG_FILE, line, (err) => {
      if (err) console.error("Error writing log:", err);
    });
  } catch (e) {
    console.error("Error generating log:", e);
  }
}

async function sendWebhook(url, data) {
  if (!url) return;

  try {
    await axios.post(url, data, {
      headers: { "Content-Type": "application/json" },
      timeout: 5000,
    });
  } catch (error) {
    console.error(`Webhook error (${url}):`, error.message);
  }
}

async function sendToAllWebhooks(data) {
  const webhooks = [WEBHOOK_URL_1, WEBHOOK_URL_2, WEBHOOK_URL_3].filter(
    Boolean
  );

  const promises = webhooks.map((url) => sendWebhook(url, data));
  await Promise.allSettled(promises);
}

// ----------------------------------------------------------------------
// Tambahkan helper ini somewhere di atas (bersama fungsi lain)
function detectFileTypeFromBuffer(buffer) {
  if (!buffer || buffer.length < 12) return null;

  const hex = (b, len = 8) =>
    buffer.slice(0, len).toString("hex").toLowerCase();
  const startsWith = (sig) =>
    buffer.slice(0, sig.length).equals(Buffer.from(sig));

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { ext: "png", mime: "image/png" };
  }

  // GIF: 47 49 46 38
  if (startsWith([0x47, 0x49, 0x46, 0x38])) {
    return { ext: "gif", mime: "image/gif" };
  }

  // PDF: %PDF
  if (startsWith([0x25, 0x50, 0x44, 0x46])) {
    return { ext: "pdf", mime: "application/pdf" };
  }

  // WEBP: RIFF....WEBP (bytes 0-3 = 'RIFF' and 8-11 = 'WEBP')
  if (
    buffer.slice(0, 4).toString() === "RIFF" &&
    buffer.slice(8, 12).toString() === "WEBP"
  ) {
    return { ext: "webp", mime: "image/webp" };
  }

  // MKV (Matroska) EBML header: 1A 45 DF A3
  if (startsWith([0x1a, 0x45, 0xdf, 0xa3])) {
    return { ext: "mkv", mime: "video/x-matroska" };
  }

  // MP4 / MOV / QT family: 'ftyp' at offset 4
  try {
    if (buffer.length > 12 && buffer.slice(4, 8).toString() === "ftyp") {
      // more specific detection could be added but mp4 is safe default
      return { ext: "mp4", mime: "video/mp4" };
    }
  } catch (e) {}

  // AVI: 'RIFF' + 'AVI ' at offset 8
  if (
    buffer.slice(0, 4).toString() === "RIFF" &&
    buffer.slice(8, 12).toString() === "AVI "
  ) {
    return { ext: "avi", mime: "video/x-msvideo" };
  }

  // MP3: ID3 or frame sync 0xFF 0xFB/0xF3/0xF2
  if (
    buffer.slice(0, 3).toString() === "ID3" ||
    (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
  ) {
    return { ext: "mp3", mime: "audio/mpeg" };
  }

  // OGG: 'OggS'
  if (buffer.slice(0, 4).toString() === "OggS") {
    return { ext: "ogg", mime: "audio/ogg" };
  }

  // ZIP / Office Open XML (docx, xlsx, pptx): 50 4B 03 04
  if (startsWith([0x50, 0x4b, 0x03, 0x04])) {
    return { ext: "zip", mime: "application/zip" };
  }

  // RAR: 52 61 72 21 1A 07 00
  if (
    buffer
      .slice(0, 7)
      .equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]))
  ) {
    return { ext: "rar", mime: "application/x-rar-compressed" };
  }

  // BMP: 42 4D
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { ext: "bmp", mime: "image/bmp" };
  }

  // ICO: 00 00 01 00
  if (buffer.slice(0, 4).equals(Buffer.from([0x00, 0x00, 0x01, 0x00]))) {
    return { ext: "ico", mime: "image/x-icon" };
  }

  // TIFF: II* or MM*
  if (
    (buffer[0] === 0x49 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x2a &&
      buffer[3] === 0x00) ||
    (buffer[0] === 0x4d &&
      buffer[1] === 0x4d &&
      buffer[2] === 0x00 &&
      buffer[3] === 0x2a)
  ) {
    return { ext: "tiff", mime: "image/tiff" };
  }

  // Default: unable to detect
  return null;
}

// -----------------
async function downloadMedia(message) {
  try {
    const messageType = Object.keys(message.message || {})[0];
    const msg = message.message[messageType];

    // ... (Bagian pengunduhan buffer tetap sama) ...
    const buffer = await downloadMediaMessage(
      message,
      "buffer",
      {},
      {
        logger,
        reuploadRequest: sock.updateMediaMessage,
      }
    );

    // --- Bagian Penentuan Lokasi Penyimpanan yang Dimodifikasi ---

    // 1. Ambil ID pesan sebagai nama file dasar
    const fileBaseName = message.key.id;

    // 2. Tentukan apakah pesan ini adalah Status
    // Status menggunakan JID 'status@broadcast'
    const isStatus = message.key.remoteJid === "status@broadcast";

    // 3. Tentukan folder penyimpanan
    let subfolder;
    if (isStatus) {
      // Jika Status, subfolder adalah 'status'
      subfolder = "status";
    } else {
      // Jika bukan Status, subfolder adalah 'messages'
      subfolder = "messages";
    }

    // 4. Gabungkan MEDIA_PATH dengan subfolder yang ditentukan
    const savePath = path.join(MEDIA_PATH, subfolder);

    // 5. Buat folder jika belum ada
    if (!fs.existsSync(savePath)) {
      fs.mkdirSync(savePath, { recursive: true });
    }

    // --- Lanjutan kode (Penentuan Ekstensi dan Penulisan File) ---

    const timestamp = moment().format("YYYYMMDDHHmmss");
    const random = Math.random().toString(36).substring(7);

    // Default ext dari mimetype (jika ada)
    let ext = "bin";
    let detectedMime = null;
    const mimetype = msg?.mimetype;

    if (mimetype) {
      const mimeExt = mimetype.split("/")[1]?.split(";")[0];
      if (mimeExt) ext = mimeExt;
    }

    // Jika ext masih 'bin' atau mimetype tidak ada, coba deteksi magic bytes
    if (ext === "bin" || !mimetype) {
      const detected = detectFileTypeFromBuffer(buffer);
      if (detected) {
        ext = detected.ext || ext;
        detectedMime = detected.mime || null;
      }
    }

    // Gunakan ID pesan sebagai nama file utama
    const filename = `${fileBaseName}.${ext}`;
    const filepath = path.join(savePath, filename);

    // Tulis file ke disk
    fs.writeFileSync(filepath, buffer);

    // Logika rename (Jika terdeteksi .bin dan ekstensi baru ditemukan)
    if (detectedMime && ext && filepath.endsWith(".bin")) {
      const newFilename = `${fileBaseName}.${ext}`;
      const newPath = path.join(savePath, newFilename);
      try {
        fs.renameSync(filepath, newPath);
      } catch (err) {
        console.warn("Gagal rename file berdasarkan magic bytes:", err.message);
      }
      // Return setelah rename
      return {
        filename: newFilename,
        filepath: newPath,
        relativePath: path.join(subfolder, newFilename),
        size: buffer.length,
        mimetype: detectedMime,
      };
    }

    const returnMime = detectedMime || mimetype || null;

    // Return standar
    return {
      filename,
      filepath,
      relativePath: path.join(subfolder, filename),
      size: buffer.length,
      mimetype: returnMime,
    };
  } catch (error) {
    console.error("Error downloading media:", error.message);
    return null;
  }
}

// ----------------------------------------------------------------------
// ---------------------------------------------------------
// Ambil nomor pengirim yang valid untuk balas pesan
// ---------------------------------------------------------
function extractNumber(jid) {
  if (!jid) return null;
  jid = String(jid).split(",")[0];
  let num = jid.split("@")[0];
  if (!/^\d+$/.test(num)) return null;
  return num;
}

function getSenderNumber(m) {
  // jika fromMe, gunakan nomor akun sendiri
  if (m.key?.fromMe) {
    return extractNumber(ME_NUMBER);
  }

  // cari apakah ada kata @s.whatsapp.net pada RemoteJid, participant, participantPn, participantLid, senderPn, remoteJid
  if (m.key?.remoteJid?.includes("@s.whatsapp.net")) {
    const num = extractNumber(m.key.remoteJid);
    if (num) return num;
  }

  if (m.key?.participant?.includes("@s.whatsapp.net")) {
    const num = extractNumber(m.key.participant);
    if (num) return num;
  }

  if (m.key?.participantPn?.includes("@s.whatsapp.net")) {
    const num = extractNumber(m.key.participantPn);
    if (num) return num;
  }

  if (m.key?.participantLid?.includes("@s.whatsapp.net")) {
    const num = extractNumber(m.key.participantLid);
    if (num) return num;
  }

  if (m.key?.senderPn?.includes("@s.whatsapp.net")) {
    const num = extractNumber(m.key.senderPn);
    if (num) return num;
  }

  if (m.key?.remoteJid?.includes("@s.whatsapp.net")) {
    const num = extractNumber(m.key.remoteJid);
    if (num) return num;
  }

  return null;
}

// ---------------------------------------------------------
// Format pesan untuk dikirim ke webhook
// ---------------------------------------------------------
function normalizeJid(jid) {
  if (!jid) return null;
  // jika ada koma (multiple recipients) ambil yang pertama
  const j = jid.split(",")[0];
  // pastikan string
  return String(j);
}

function extractNumberFromJid(jid) {
  if (!jid) return null;
  const parts = jid.split("@")[0];
  // some JIDs may include device ids like 12345-67890, ignore those
  if (parts.includes("-")) return null;
  return parts;
}

function formatMessage(m) {
  const senderNumber = getSenderNumber(m);
  const messageType = Object.keys(m.message || {})[0];
  const isStatus = normalizeJid(m.key.remoteJid) === "status@broadcast";
  const isGroup = m.key.remoteJid.endsWith("@g.us");
  const groupJid = isGroup ? m.key.remoteJid : null;

  let data = {
    messageId: m.key.id,
    fromMe: m.key.fromMe || false,
    from: senderNumber,
    groupJid: groupJid,
    remoteJid: m.key.remoteJid,
    pushName: m.pushName || null,
    type: isStatus ? "status" : "message",
    isGroup: isGroup,
    timestamp: m.messageTimestamp
      ? moment.unix(m.messageTimestamp).format("YYYY-MM-DD HH:mm:ss")
      : null,
    messageType: messageType,
    hasMedia: false,
  };

  console.log(
    "--------------------\n🔍 DEBUG FULL MESSAGE: \n",
    JSON.stringify(m, null, 2)
  );
  logBaileysEvent(JSON.stringify(m, null, 2));

  // ------- Text Message -------
  if (m.message?.conversation) {
    data.text = m.message.conversation || "";
  }

  // ------- ExtendedText -------
  else if (m.message?.extendedTextMessage) {
    data.text = m.message.extendedTextMessage.text;

    // quoted message jika ada
    const q = m.message.extendedTextMessage.contextInfo;
    if (q?.quotedMessage) {
      const qm = q.quotedMessage;
      data.quotedMessage = {
        messageId: q.stanzaId,
        from: q.participant ? q.participant.split("@")[0] : null,
        text:
          qm.conversation ||
          qm.extendedTextMessage?.text ||
          qm.imageMessage?.caption ||
          qm.videoMessage?.caption ||
          qm.documentMessage?.caption ||
          "",
      };
    }
  }

  // ------- Image -------
  else if (m.message?.imageMessage) {
    data.mediaType = "image";
    data.caption = m.message.imageMessage.caption || null;
  }

  // ------- Video -------
  else if (m.message?.videoMessage) {
    data.mediaType = "video";
    data.caption = m.message.videoMessage.caption || null;
  }

  // ------- Document -------
  else if (m.message?.documentMessage) {
    data.mediaType = "document";
    data.fileName = m.message.documentMessage.fileName;
    data.caption = m.message.documentMessage.caption || null;
  }

  // ------- Audio -------
  else if (m.message?.audioMessage) {
    data.mediaType = "audio";
  }

  // ------- Sticker -------
  else if (m.message?.stickerMessage) {
    data.mediaType = "sticker";
  }

  // ------- Location -------
  else if (m.message?.locationMessage) {
    const loc = m.message.locationMessage;
    data.mediaType = "location";
    data.location = {
      latitude: loc.degreesLatitude,
      longitude: loc.degreesLongitude,
      name: loc.name || null,
      address: loc.address || null,
    };
    data.text =
      "[share location] \n" +
      data.location.name +
      "\n" +
      data.location.latitude +
      ", " +
      data.location.longitude;
  }

  data.text = data.text || data.caption || null;
  return data;
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("./sessions");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: state,
    browser: ["Baileys Gateway", "Chrome", "1.0.0"],
    markOnlineOnConnect: true,
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n=== QR CODE ===");
      qrcode.generate(qr, { small: true });
      console.log("===============\n");
      qrCodeData = qr;
      connectionStatus = "qr";

      await sendToAllWebhooks({
        status: "qr_generated",
        timestamp: moment().format("YYYY-MM-DD HH:mm:ss"),
      });
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;
      console.log("Connection closed. Reconnecting:", shouldReconnect);

      connectionStatus = "disconnected";
      qrCodeData = null;

      await sendToAllWebhooks({
        status: "disconnected",
        reason: lastDisconnect?.error?.message,
        timestamp: moment().format("YYYY-MM-DD HH:mm:ss"),
      });

      if (shouldReconnect) {
        setTimeout(() => connectToWhatsApp(), 3000);
      }
    } else if (connection === "open") {
      console.log("✅ Connected to WhatsApp");
      connectionStatus = "connected";
      qrCodeData = null;

      await getMeInfo(sock, { sessionDir: "./sessions", includePic: true });

      await sendToAllWebhooks({
        status: "connected",
        timestamp: moment().format("YYYY-MM-DD HH:mm:ss"),
      });
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const m of messages) {
      if (!m.message) continue;

      const formattedMessage = formatMessage(m);

      const hasMedia =
        m.message.imageMessage ||
        m.message.videoMessage ||
        m.message.documentMessage;

      formattedMessage.hasMedia = false;
      if (hasMedia) {
        const mediaInfo = await downloadMedia(m);
        if (mediaInfo) {
          formattedMessage.media = mediaInfo;
          formattedMessage.hasMedia = true;
        }
      }

      await sendToAllWebhooks(formattedMessage);

      console.log("📨 Webhook : Message received:", formattedMessage);
      // Save message to database
      saveMessageToDatabase(formattedMessage);
    }
  });
}

app.get("/", (req, res) => {
  res.json({
    status: "running",
    connection: connectionStatus,
    timestamp: moment().format("YYYY-MM-DD HH:mm:ss"),
  });
});

app.get("/status", (req, res) => {
  res.json({
    status: connectionStatus,
    qrCode: qrCodeData,
    timestamp: moment().format("YYYY-MM-DD HH:mm:ss"),
  });
});

// =============================================================
// ENDPOINT SEND MESSAGE
// =============================================================
app.post("/send-message", async (req, res) => {
  try {
    if (!sock)
      return res.status(500).json({ error: "WhatsApp belum terkoneksi" });

    const { to, text, mediaUrl, filename } = req.body;
    if (!to)
      return res.status(400).json({ error: "Parameter 'to' wajib diisi" });

    let jid = to;

    // Jika kirim ke nomor biasa → ubah ke format JID
    if (/^\d+$/.test(to)) {
      jid = to + "@s.whatsapp.net";
    }

    // Jika mediaUrl ada → kirim media
    if (mediaUrl) {
      const axiosResp = await axios.get(mediaUrl, {
        responseType: "arraybuffer",
      });
      const buffer = Buffer.from(axiosResp.data);

      const mime =
        axiosResp.headers["content-type"] || "application/octet-stream";
      const ext = mime.split("/")[1] || "bin";

      let sendData = {};

      if (mime.startsWith("image/")) {
        sendData.image = buffer;
        sendData.caption = text || "";
      } else if (mime.startsWith("video/")) {
        sendData.video = buffer;
        sendData.caption = text || "";
      } else {
        sendData.document = buffer;
        sendData.mimetype = mime;
        sendData.fileName = filename || `file.${ext}`;
      }

      const result = await sock.sendMessage(jid, sendData);

      console.log("Media sent result:", result);
      if (to !== null) {
        const data = {
          messageId: result.key.id,
          senderNumber: null,
          toNumber: to, // result.key.remoteJid,
          remoteJid: result.key.remoteJid,
          pushName: null, // pushName dari nomor tujuan tidak diketahui saat mengirim
          text: text,
        };
        saveMessageToDatabase(data);
      }

      return res.json({
        status: "success",
        to,
        type: "media",
        result,
      });
    }

    // Jika hanya teks
    if (text) {
      const result = await sock.sendMessage(jid, { text });
      console.log("Text sent result:", result);

      if (to !== null) {
        const data = {
          messageId: result.key.id,
          senderNumber: null,
          toNumber: to, // result.key.remoteJid,
          remoteJid: result.key.remoteJid,
          pushName: null, // pushName dari nomor tujuan tidak diketahui saat mengirim
          text: text,
        };
        saveMessageToDatabase(data);
      }

      return res.json({
        status: "success",
        to,
        type: "text",
        result,
      });
    }

    return res.status(400).json({
      error: "Tidak ada text atau mediaUrl yang dikirim",
    });
  } catch (err) {
    console.error("Send message error:", err);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================
// ENDPOINT REPLY MESSAGE (FINAL FIX PERSONAL + GROUP)
// =============================================================
app.post("/reply-message", async (req, res) => {
  try {
    if (!sock)
      return res.status(500).json({ error: "WhatsApp belum terkoneksi" });

    const { messageId, to, participant, text, mediaUrl, filename } = req.body;

    if (!messageId || !to) {
      return res.status(400).json({ error: "messageId & to wajib diisi" });
    }
    if (!text && !mediaUrl) {
      return res.status(400).json({ error: "text atau mediaUrl harus diisi" });
    }

    // Tentukan remoteJid
    let remoteJid = /^\d+$/.test(to) ? `${to}@s.whatsapp.net` : to;
    const isGroup = remoteJid.endsWith("@g.us");

    // console.log("🔥 remoteJid =", remoteJid);

    // Siapkan quoted message
    const quotedMsg = {
      key: {
        remoteJid: remoteJid,
        id: messageId,
        fromMe: false,
      },
      message: { conversation: "" },
    };

    // Siapkan message content
    let messageContent = {};

    // Jika ada media
    if (mediaUrl) {
      const resp = await axios.get(mediaUrl, { responseType: "arraybuffer" });
      const buffer = Buffer.from(resp.data);
      const mime = resp.headers["content-type"] || "application/octet-stream";

      if (mime.startsWith("image/")) {
        messageContent.image = buffer;
        messageContent.caption = text || "";
      } else if (mime.startsWith("video/")) {
        messageContent.video = buffer;
        messageContent.caption = text || "";
      } else {
        messageContent.document = buffer;
        messageContent.mimetype = mime;
        messageContent.fileName = filename || "file";
      }
    } else {
      // Jika hanya text
      messageContent.text = text;
    }

    // Kirim message
    let result;
    if (isGroup) {
      // Untuk group: gunakan contextInfo
      if (!participant) {
        return res
          .status(400)
          .json({ error: "participant WAJIB untuk reply pesan grup" });
      }

      messageContent.contextInfo = {
        stanzaId: messageId,
        remoteJid: remoteJid,
        participant: participant.includes("@")
          ? participant
          : `${participant}@s.whatsapp.net`,
      };

      result = await sock.sendMessage(remoteJid, messageContent);
    } else {
      // Untuk personal: gunakan quoted
      result = await sock.sendMessage(remoteJid, messageContent, {
        quoted: quotedMsg,
      });
    }

    console.log("Reply sent result:", result);
    if (to !== null) {
      const data = {
        messageId: result.key.id,
        senderNumber: null,
        toNumber: to, // result.key.remoteJid,
        remoteJid: result.key.remoteJid,
        pushName: null, // pushName dari nomor tujuan tidak diketahui saat mengirim
        text: text,
      };
      saveMessageToDatabase(data);
    }

    return res.json({
      success: true,
      type: isGroup ? "reply-group" : "reply-personal",
      messageId: result.key.id,
      timestamp: moment().format("YYYY-MM-DD HH:mm:ss"),
    });
  } catch (err) {
    console.error("Reply error:", err);
    res.status(500).json({ error: err.message });
  }
});
// =============================================================

app.post("/send-file", upload.single("file"), async (req, res) => {
  try {
    const { to, caption, type } = req.body;
    const number = to;
    const file = req.file;

    if (!number || !file) {
      return res.status(400).json({ error: "Number and file are required" });
    }

    const jid = number.includes("@s.whatsapp.net")
      ? number
      : `${number}@s.whatsapp.net`;
    const fileBuffer = fs.readFileSync(file.path);

    let messageContent = {};

    if (type === "image" || file.mimetype.startsWith("image/")) {
      messageContent = {
        image: fileBuffer,
        caption: caption || "",
      };
    } else if (type === "video" || file.mimetype.startsWith("video/")) {
      messageContent = {
        video: fileBuffer,
        caption: caption || "",
      };
    } else {
      messageContent = {
        document: fileBuffer,
        mimetype: file.mimetype,
        fileName: file.originalname,
        caption: caption || "",
      };
    }

    const sent = await sock.sendMessage(jid, messageContent);

    fs.unlinkSync(file.path);

    res.json({
      success: true,
      messageId: sent.key.id,
      timestamp: moment().format("YYYY-MM-DD HH:mm:ss"),
    });
  } catch (error) {
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

app.post("/send-sticker", upload.single("file"), async (req, res) => {
  try {
    const { to } = req.body;
    const number = to;
    const file = req.file;

    if (!number || !file) {
      return res.status(400).json({ error: "Number and file are required" });
    }

    const jid = number.includes("@s.whatsapp.net")
      ? number
      : `${number}@s.whatsapp.net`;

    const webpBuffer = await sharp(file.path)
      .resize(512, 512, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp()
      .toBuffer();

    const sent = await sock.sendMessage(jid, {
      sticker: webpBuffer,
    });

    fs.unlinkSync(file.path);

    res.json({
      success: true,
      messageId: sent.key.id,
      timestamp: moment().format("YYYY-MM-DD HH:mm:ss"),
    });
  } catch (error) {
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

app.post("/send-loc", async (req, res) => {
  try {
    const { to, latitude, longitude, name, address } = req.body;
    const number = to;

    if (!number || !latitude || !longitude) {
      return res
        .status(400)
        .json({ error: "Number, latitude, and longitude are required" });
    }

    const jid = number.includes("@s.whatsapp.net")
      ? number
      : `${number}@s.whatsapp.net`;

    const sent = await sock.sendMessage(jid, {
      location: {
        degreesLatitude: parseFloat(latitude),
        degreesLongitude: parseFloat(longitude),
        name: name || "",
        address: address || "",
      },
    });

    res.json({
      success: true,
      messageId: sent.key.id,
      timestamp: moment().format("YYYY-MM-DD HH:mm:ss"),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/typing", async (req, res) => {
  try {
    const { to, duration } = req.body;
    const number = to;

    if (!number) {
      return res.status(400).json({ error: "Number is required" });
    }

    const jid = number.includes("@s.whatsapp.net")
      ? number
      : `${number}@s.whatsapp.net`;
    const typingDuration = duration || 3000;

    await sock.sendPresenceUpdate("composing", jid);

    setTimeout(async () => {
      await sock.sendPresenceUpdate("paused", jid);
    }, typingDuration);

    res.json({
      success: true,
      timestamp: moment().format("YYYY-MM-DD HH:mm:ss"),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/profile", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const { number } = req.query;

    if (!number) {
      return res.status(400).json({ error: "Number is required" });
    }

    const jid = number.includes("@s.whatsapp.net")
      ? number
      : `${number}@s.whatsapp.net`;

    let profilePicUrl;
    try {
      profilePicUrl = await sock.profilePictureUrl(jid, "image");
    } catch (error) {
      profilePicUrl = null;
    }

    res.json({
      success: true,
      number: jid,
      profilePicUrl: profilePicUrl,
      timestamp: moment().format("YYYY-MM-DD HH:mm:ss"),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ------------------------- 11.12.2025----------------
// Helper: safe extract number/jid
function normalizeJidInput(q) {
  if (!q) return null;
  if (q.includes("@")) return q;
  if (/^\d+$/.test(q)) return `${q}@s.whatsapp.net`;
  // accept also g.us or others if provided raw
  return q;
}

// Helper: try get profile picture url safely
async function safeProfilePic(jid) {
  try {
    if (!jid) return null;
    // some Baileys versions expose sock.profilePictureUrl
    if (typeof sock.profilePictureUrl === "function") {
      const url = await sock.profilePictureUrl(jid, "image");
      return url || null;
    }
    // fallback: some builds provide fetchProfilePicture? try generic
    if (typeof sock.fetchProfilePicture === "function") {
      const url = await sock.fetchProfilePicture(jid);
      return url || null;
    }
  } catch (e) {
    // not found or blocked / no profile pic
    return null;
  }
  return null;
}

// ------------------------- Helper extractNumber -------------------------
function extractNumber(jid) {
  if (!jid) return null;
  jid = String(jid).split(",")[0]; // jika ada list, ambil pertama
  let num = jid.split("@")[0]; // ambil bagian sebelum '@'
  num = num.split(":")[0]; // hapus device id setelah ':', contoh 628...:36
  if (!/^\d+$/.test(num)) return null; // validasi numeric
  return num;
}

// ------------------------- safeProfilePic (reusable) -------------------------
async function safeProfilePic(sockInstance, jid) {
  if (!jid || !sockInstance) return null;
  try {
    if (typeof sockInstance.profilePictureUrl === "function") {
      const url = await sockInstance.profilePictureUrl(jid, "image");
      return url || null;
    }
    if (typeof sockInstance.fetchProfilePicture === "function") {
      const url = await sockInstance.fetchProfilePicture(jid);
      return url || null;
    }
  } catch (e) {
    return null;
  }
  return null;
}

/**
 * Endpoint untuk melayani file media berdasarkan ID unik.
 * Mencari file di folder 'status' dan 'messages'.
 * * @param {string} mediaId - ID unik dari file (misalnya, ACBCAA9B252721F36D5436B264380589)
 */
app.get("/media", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // 1. Ambil ID media dari query parameter
  const mediaId = req.query.id;

  if (!mediaId) {
    // Cek jika ID media tidak disediakan
    return res.status(400).json({ error: 'Parameter "id" dibutuhkan.' });
  }

  // Direktori yang harus dicari (sesuai dengan fungsi downloadMedia)
  const searchDirectories = ["messages", "status"];

  let foundFilePath = null;

  // 2. Lakukan pencarian di setiap direktori
  for (const dirName of searchDirectories) {
    const fullDirPath = path.join(MEDIA_PATH, dirName);

    try {
      // Baca semua file di dalam folder (secara sinkron untuk penyederhanaan)
      const files = fs.readdirSync(fullDirPath);

      // Cari file yang diawali dengan mediaId (mengabaikan ekstensi)
      const foundFile = files.find((file) => {
        // Pastikan file dimulai dengan ID yang dicari dan diikuti oleh titik (ekstensi)
        // Ini mencegah kecocokan parsial jika ID pesan lainnya mengandung substring ID ini
        return file.startsWith(mediaId + ".");
      });

      if (foundFile) {
        // Jika file ditemukan, simpan jalurnya dan hentikan pencarian
        foundFilePath = path.join(fullDirPath, foundFile);
        break;
      }
    } catch (error) {
      // Jika folder tidak ada atau gagal dibaca, lanjutkan ke folder berikutnya
      if (error.code !== "ENOENT") {
        console.warn(
          `Gagal membaca direktori ${fullDirPath}: ${error.message}`
        );
      }
    }
  }

  console.log(
    "🔍 Media lookup for ID:",
    mediaId,
    "->",
    foundFilePath ? "FOUND" : "NOT FOUND"
  );

  // 3. Tangani hasil pencarian
  if (foundFilePath) {
    // Ambil nama file dan ekstensi untuk keperluan MIME type (opsional)
    const fileName = path.basename(foundFilePath);

    // Kirim file menggunakan res.sendFile()
    return res.sendFile(foundFilePath, (err) => {
      // Hanya tangani error jika koneksi belum ditutup oleh klien (EPIPE)
      if (err && err.code !== "EPIPE" && err.code !== "ECONNABORTED") {
        // Log error yang BUKAN EPIPE atau ECONNABORTED
        console.error("Error saat mengirim file:", err.message);

        // Cek dulu apakah headers belum dikirim
        if (!res.headersSent) {
          res.status(500).json({ error: "Gagal memuat file." });
        }
      } else if (err && (err.code === "EPIPE" || err.code === "ECONNABORTED")) {
        // Log jika koneksi ditutup oleh klien, tapi jangan kirim header lagi
        console.warn(
          "Koneksi ditutup oleh klien sebelum transfer selesai:",
          err.code
        );
      }
    });
  } else {
    // Jika file tidak ditemukan di direktori manapun
    return res
      .status(404)
      .json({ error: `Media dengan ID ${mediaId} tidak ditemukan.` });
  }
});

// Endpoint untuk mengambil informasi group
app.get("/groupInfo", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const { jid } = req.query; // Mengambil jid dari query parameter

    if (!jid) {
      return res.status(400).json({ error: "jid is required" });
    }

    const remoteJid = jid.includes("@g.us") ? jid : `${jid}@g.us`;

    // Fungsi fetchGroupMetadata di sock (WA-JS) adalah yang digunakan untuk mengambil detail grup
    const metadata = await sock.groupMetadata(remoteJid);

    // Memformat data yang ingin dikirimkan ke client
    const groupInfo = {
      id: metadata.id,
      subject: metadata.subject,
      owner: metadata.owner,
      creation: new Date(metadata.creation * 1000).toISOString(),
      description: metadata.desc,
      participantsCount: metadata.participants.length,
      participants: metadata.participants.map((p) => ({
        jid: p.id,
        isAdmin: p.isAdmin || false,
        isSuperAdmin: p.isSuperAdmin || false,
      })),
      isAnnounce: metadata.announce,
      isLocked: metadata.restrict,
    };

    res.json({
      success: true,
      groupInfo: groupInfo,
      timestamp: moment().format("YYYY-MM-DD HH:mm:ss"),
    });
  } catch (error) {
    console.error("Error fetching group info:", error);
    // Menangani kasus di mana JID grup tidak valid atau grup tidak ditemukan
    if (error.output && error.output.statusCode === 404) {
      return res.status(404).json({ error: "Group not found or invalid JID" });
    }
    res.status(500).json({ error: error.message });
  }
});

// ------------------------- getMeInfo (reusable) -------------------------
/**
 * Mengembalikan info akun yang terhubung ke Baileys secara reusable.
 * @param {object} sockInstance - instance socket Baileys (sock)
 * @param {object} options - opsi tambahan:
 *    - sessionDir: path ke folder sessions (default './sessions')
 *    - includePic: boolean, apakah memanggil profilePic (default true)
 * @returns {Promise<object>} { success, jid, number, pushName, name, profilePicUrl, sessionFolder, raw }
 */
async function getMeInfo(sockInstance, options = {}) {
  const SESSION_DIR = options.sessionDir || "./sessions";
  const includePic =
    options.includePic !== undefined ? options.includePic : true;

  let out = {
    success: false,
    jid: null,
    number: null,
    pushName: null,
    name: null,
    profilePicUrl: null,
    sessionFolder: null,
    raw: {},
  };

  try {
    // 1) coba dari sock.user (umumnya paling cepat tersedia setelah connected)
    try {
      if (sockInstance && sockInstance.user) {
        const u = sockInstance.user;
        out.raw.sockUser = u;
        // beberapa versi punya 'id', beberapa 'jid'
        out.jid = u.id || u.jid || null;
        out.name = u.name || u.notify || null;
        out.pushName = u.name || u.pushName || u.notify || null;
      }
    } catch (e) {
      // ignore
    }

    // 2) jika belum ditemukan jid, coba dari sessions/*/creds.json
    if (!out.jid) {
      try {
        if (fs.existsSync(SESSION_DIR)) {
          const folders = fs
            .readdirSync(SESSION_DIR)
            .filter((f) =>
              fs.statSync(path.join(SESSION_DIR, f)).isDirectory()
            );
          for (const f of folders) {
            const credPath = path.join(SESSION_DIR, f, "creds.json");
            if (fs.existsSync(credPath)) {
              try {
                const creds = JSON.parse(fs.readFileSync(credPath, "utf8"));
                if (creds && creds.me) {
                  out.jid = creds.me.id || creds.me.jid || null;
                  out.name = creds.me.name || creds.me.notify || out.name;
                  out.sessionFolder = f;
                  out.raw.creds = creds.me;
                  break;
                }
              } catch (e) {
                // parse error -> skip
              }
            }
          }
        }
      } catch (e) {
        // ignore
      }
    }

    // 3) pastikan number di-extract dengan benar (hapus :device)
    if (out.jid) {
      out.number = extractNumber(out.jid);
    }

    // 4) include profile picture (opsional)
    if (includePic && out.jid) {
      try {
        out.profilePicUrl = await safeProfilePic(sockInstance, out.jid);
      } catch (e) {
        out.profilePicUrl = null;
      }
    }

    // finalisasi
    out.success = true;
    ME_NUMBER = out.number || ME_NUMBER; // update global ME_NUMBER jika perlu
    ME_pushName = out.pushName ?? out.name ?? "";
    return out;
  } catch (error) {
    return {
      success: false,
      error: error.message,
      raw: out.raw || {},
    };
  }
}

// ------------------------- REPLACE /me endpoint to use getMeInfo -------------------------
// GET /me — info akun Baileys saat ini
app.get("/me", async (req, res) => {
  try {
    if (!sock)
      return res
        .status(500)
        .json({ success: false, error: "Socket not initialized" });

    const info = await getMeInfo(sock, {
      sessionDir: "./sessions",
      includePic: true,
    });

    if (!info.success) {
      return res.status(500).json({
        success: false,
        error: "Unable to get account info",
        details: info,
      });
    }

    return res.json({
      success: true,
      jid: info.jid,
      number: info.number,
      pushName: info.pushName || info.name || null,
      profilePicUrl: info.profilePicUrl || null,
      sessionFolder: info.sessionFolder || null,
      timestamp: moment().format("YYYY-MM-DD HH:mm:ss"),
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// GET /contact-info?jid=628123... atau ?jid=628123@s.whatsapp.net
app.get("/contact-info", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const q = req.query.jid;
    if (!q)
      return res.status(400).json({
        success: false,
        error:
          'Query param "jid" diperlukan | jid=628123... atau ?jid=628123@s.whatsapp.net',
      });

    const jid = normalizeJidInput(q);

    const result = {
      jid,
      number: jid ? jid.split("@")[0] : null,
      pushName: null,
      isOnWhatsApp: null,
      profilePicUrl: null,
      // raw fallback data
      fromContacts: null,
    };

    // 1) coba lihat di cache contacts local (sock.contacts)
    try {
      if (sock && sock.contacts && sock.contacts[jid]) {
        const c = sock.contacts[jid];
        result.pushName = c.name || c.notify || c.subject || null;
        result.fromContacts = true;
      } else {
        result.fromContacts = false;
      }
    } catch (e) {
      result.fromContacts = null;
    }

    // 2) cek apakah onWhatsApp (beberapa versi punya method onWhatsApp)
    try {
      if (typeof sock.onWhatsApp === "function") {
        const arr = await sock.onWhatsApp([jid]);
        // arr example: [{ exists: true, jid: '628...', isBusiness: false, ... }]
        if (Array.isArray(arr) && arr.length > 0) {
          result.isOnWhatsApp = !!arr[0]?.exists;
        }
      }
    } catch (e) {
      // ignore
    }

    // 3) profile picture
    try {
      const p = await safeProfilePic(jid);
      result.profilePicUrl = p;
    } catch (e) {
      result.profilePicUrl = null;
    }

    // 4) jika pushName masih null, coba ambil dari presence in contacts map fields
    try {
      if (!result.pushName && sock && sock.contacts) {
        const c = sock.contacts[jid];
        if (c) result.pushName = c.pushname || c.notify || c.name || null;
      }
    } catch (e) {}

    return res.json({
      success: true,
      data: result,
      timestamp: moment().format("YYYY-MM-DD HH:mm:ss"),
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// GET /contacts - list semua kontak dari cache sock.contacts
// Query params:
//  - q (string): search keyword (jid, number, name)
//  - limit (int): max hasil (default 100)
//  - offset (int): offset untuk paging (default 0)
//  - withPic (1|0): jika 1 maka include profilePicUrl (akan memanggil safeProfilePic untuk setiap kontak)
app.get("/contacts", async (req, res) => {
  try {
    if (!sock)
      return res
        .status(500)
        .json({ success: false, error: "Socket not initialized" });

    const q = (req.query.q || "").toString().trim().toLowerCase();
    const limit = Math.max(
      1,
      Math.min(1000, parseInt(req.query.limit || "100", 10))
    );
    const offset = Math.max(0, parseInt(req.query.offset || "0", 10));
    const withPic = req.query.withPic === "1" || req.query.withPic === "true";

    const contactsObj = sock.contacts || {};
    const jids = Object.keys(contactsObj);

    // Map kontak -> array of simplified objects
    let list = jids.map((jid) => {
      const c = contactsObj[jid] || {};
      const number = jid.split("@")[0];
      return {
        jid,
        number,
        name: c.name || c.notify || c.pushname || c.subject || null,
        short: c.short || null,
        isBusiness: c.isBusiness || false,
        isEnterprise: c.isEnterprise || false,
        // raw contact cache for debugging (optional)
        _raw: undefined,
      };
    });

    // Optional search filter
    if (q) {
      list = list.filter((item) => {
        return (
          (item.jid && item.jid.toLowerCase().includes(q)) ||
          (item.number && item.number.includes(q)) ||
          (item.name && item.name.toLowerCase().includes(q))
        );
      });
    }

    const total = list.length;

    // Apply offset + limit
    list = list.slice(offset, offset + limit);

    // Optionally fetch profilePicUrl for each contact (careful: heavy)
    if (withPic) {
      // perform in parallel but limit concurrency to avoid overload
      // simple concurrency limiter:
      const concurrency = 10;
      const results = [];
      for (let i = 0; i < list.length; i += concurrency) {
        const chunk = list.slice(i, i + concurrency);
        const promises = chunk.map(async (item) => {
          try {
            item.profilePicUrl = await safeProfilePic(item.jid);
          } catch (e) {
            item.profilePicUrl = null;
          }
          return item;
        });
        const resolved = await Promise.all(promises);
        results.push(...resolved);
      }
      list = results;
    }

    // Remove _raw to keep response small (or keep if you want)
    list = list.map(({ _raw, ...rest }) => rest);

    return res.json({
      success: true,
      total,
      count: list.length,
      offset,
      limit,
      data: list,
      timestamp: moment().format("YYYY-MM-DD HH:mm:ss"),
    });
  } catch (error) {
    console.error("GET /contacts error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/getInbox", async (req, res) => {
  try {
    const senderNumber = req.query.senderNumber || "*";
    const limit = parseInt(req.query.limit) || 200;
    const messages = await getInboxFromDatabase(senderNumber, limit);
    return res.json({
      success: true,
      senderNumber,
      limit,
      count: messages.length,
      messages,
      timestamp: moment().format("YYYY-MM-DD HH:mm:ss"),
    });
  } catch (error) {
    console.error("Error fetching inbox messages:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/getSent", async (req, res) => {
  try {
    const toNumber = req.query.toNumber || "*";
    const limit = parseInt(req.query.limit) || 150;
    const messages = await getSentFromDatabase(toNumber, limit);
    return res.json({
      success: true,
      limit,
      count: messages.length,
      messages,
      timestamp: moment().format("YYYY-MM-DD HH:mm:ss"),
    });
  } catch (error) {
    console.error("Error fetching inbox messages:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/getMessage", async (req, res) => {
  try {
    const messageId = req.query.id || req.query.messageId;
    if (!messageId) {
      return res.status(400).json({
        success: false,
        error: "Message ID is required",
      });
    }

    const message = await getMessageFromDatabase(messageId);
    if (!message || message.length === 0) {
      return res.json({
        success: false,
        error: "Message not found",
      });
    }

    return res.json({
      success: true,
      data: message,
    });
  } catch (error) {
    console.error("Error fetching inbox messages:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Setup MariaDB connection
const pool = mariadb.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "whatsapp_gateway",
  connectionLimit: 5,
});

// Save message to database
async function saveMessageToDatabase(data) {
  console.log("Saving message to database." + DB_TABLE + ": ", data);
  if (data.messageType === "stickerMessage") {
    console.log("Sticker message detected, skipping database save.");
    return;
  }
  if (data.text === null && data.hasMedia === false) {
    console.log("No text or media found, skipping database save.");
    return;
  }

  let senderNumber = data.from ?? data.senderNumber ?? null;
  if (senderNumber === ME_NUMBER && data.toNumber === null) {
    console.log("Message from self with no toNumber, skipping database save.");
    return;
  }

  if (senderNumber === ME_NUMBER) {
    senderNumber = null; // jika pengirim adalah self, set ke null = sent message
  }

  const toNumber = data.toNumber ?? null;
  const timestamp = data.timestamp ?? moment().format("YYYY-MM-DD HH:mm:ss");
  if (senderNumber === null && toNumber === null) {
    console.log(
      "Both senderNumber and toNumber are null, skipping database save."
    );
    return;
  }

  let conn;
  try {
    conn = await pool.getConnection();
    const query = `INSERT INTO ${DB_TABLE} (messageId, timestamp, senderNumber, toNumber, remoteJid, pushName, text, media) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    const values = [
      data.messageId,
      timestamp,
      senderNumber,
      toNumber,
      data.remoteJid,
      data.pushName || null,
      data.text || data.caption || null,
      data.media?.relativePath || null,
    ];
    await conn.query(query, values);
    console.log("Message saved to database w/ values:", values);
  } catch (err) {
    console.error("Database error:", err);
  } finally {
    if (conn) conn.release();
  }
}

// Get messages from database
async function getInboxFromDatabase(senderNumber = "*", limit = 50) {
  let conn;
  try {
    conn = await pool.getConnection();

    let query = `
      SELECT 
        messageId,
        timestamp,
        senderNumber,
        toNumber,
        remoteJid,
        pushName,
        text,
        media
      FROM ${DB_TABLE} `;
    let params = [];
    // Logika Filter
    if (senderNumber !== "*") {
      query += ` WHERE senderNumber = ? `;
      params.push(senderNumber);
    } else {
      query += ` WHERE (senderNumber IS NOT NULL) `;
    }

    // Penambahan Order dan Limit
    query += ` ORDER BY timestamp DESC LIMIT ? `;
    params.push(limit);

    console.log("Executing query:", query, "with params:", params);

    const rows = await conn.query(query, params);
    return rows;
  } catch (err) {
    console.error("Database read error:", err);
    return [];
  } finally {
    if (conn) conn.release();
  }
}

async function getSentFromDatabase(toNumber = "*", limit = 100) {
  let conn;
  try {
    conn = await pool.getConnection();

    let query = `
      SELECT 
        messageId,
        timestamp,
        senderNumber,
        toNumber,
        remoteJid,
        pushName,
        text,
        media
      FROM ${DB_TABLE} `;
    let params = [];
    // Logika Filter
    if (toNumber !== "*") {
      query += ` WHERE toNumber = ? `;
      params.push(toNumber);
    } else {
      query += ` WHERE (senderNumber IS NULL OR senderNumber = ?) `;
      params.push(ME_NUMBER);
    }

    // Penambahan Order dan Limit
    query += ` ORDER BY timestamp DESC LIMIT ? `;
    params.push(limit);

    console.log("Executing query:", query, "with params:", params);

    const rows = await conn.query(query, params);
    return rows;
  } catch (err) {
    console.error("Database read error:", err);
    return [];
  } finally {
    if (conn) conn.release();
  }
}

async function getMessageFromDatabase(messageId) {
  try {
    const cleanId = String(messageId).trim();
    const query = `
      SELECT 
        *
      FROM ${DB_TABLE} 
      WHERE messageId = ?`;
    const [rows] = await pool.execute(query, [cleanId]);

    if (Array.isArray(rows)) {
      return rows.length > 0 ? rows[0] : null;
    } else {
      // Fallback jika library Anda mengembalikan object langsung
      return rows ? rows : null;
    }
  } catch (err) {
    console.error("Database read error:", err);
    return [];
  }
}

connectToWhatsApp().catch((err) => console.error("Connection error:", err));

app.listen(PORT, () => {
  console.log(`🚀 Baileys WhatsApp Gateway running on port ${PORT}`);
  console.log(`⏰ Timezone: ${TIMEZONE}`);
  console.log(`📁 Media path: ${MEDIA_PATH}`);
  console.log(`📡 Webhook 1: ${WEBHOOK_URL_1 || "Not configured"}`);
  console.log(`📡 Webhook 2: ${WEBHOOK_URL_2 || "Not configured"}`);
  console.log(`📡 Webhook 3: ${WEBHOOK_URL_3 || "Not configured"}`);
});
