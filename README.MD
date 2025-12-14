# Baileys WhatsApp Gateway Docker

WhatsApp Gateway menggunakan Baileys library dengan Docker support.

## 🚀 Instalasi

### 1. Clone repo
```bash
git clone https://github.com/knd27/kn-baileys-whatsapp-gateway
cd kn-baileys-whatsapp-gateway
```


### 3. Konfigurasi Environment
Edit file `.env` sesuai kebutuhan:
```env
WEBHOOK_URL_1=http://your-api.com/webhook
WEBHOOK_URL_2=http://your-api.com/webhook2
WEBHOOK_URL_3=http://your-api.com/webhook3
MEDIA_PATH=/app/media
TZ=Asia/Jakarta
PORT=3000
```

**Catatan:** Semua webhook akan menerima data yang sama. Anda bisa mengisi 1, 2, atau 3 webhook sesuai kebutuhan.

### 4. Build dan Jalankan
```bash
docker-compose up -d --build
```

### 5. Lihat QR Code
```bash
docker logs -f baileys_
```

Scan QR Code yang muncul di terminal dengan WhatsApp Anda.

## 📡 API Endpoints

### 1. **Send Message**
```bash
POST /send-message
Content-Type: application/json

{
  "to": "628123456789",
  "text": "Hello World!"
}
```

### 2. **Reply Message**
```bash
POST /reply-message
Content-Type: application/json

{
  "to": "628123456789",
  "text": "This is reply",
  "messageId": "MESSAGE_ID_HERE"
}
```

### 3. **Send File**
```bash
POST /send-file
Content-Type: multipart/form-data

file: [binary file]
to: 628123456789
caption: "Photo caption"
type: image|video|document
```

### 4. **Send Sticker**
```bash
POST /send-sticker
Content-Type: multipart/form-data

file: [image file]
to: 628123456789
```

### 5. **Send Location**
```bash
POST /send-loc
Content-Type: application/json

{
  "to": "628123456789",
  "latitude": -6.200000,
  "longitude": 106.816666,
  "name": "Jakarta",
  "address": "Jakarta, Indonesia"
}
```

### 6. **Lihat Media**
```bash
GET /media?id=<messageId>

```


### 7. **Typing Indicator**
```bash
POST /typing
Content-Type: application/json

{
  "to": "628123456789",
  "duration": 3000
}
```

### 8. **Get Profile Picture**
```bash
GET /profile?number=628123456789
```

### 9. **Check Status**
```bash
GET /status
```

Response:
```json
{
  "status": "connected|disconnected|qr",
  "qrCode": "QR_STRING_IF_AVAILABLE",
  "timestamp": "2024-12-08 14:30:00"
}
```

## 📥 Webhook Structure

**Semua webhook akan menerima data yang sama untuk setiap event.**

### Message Webhook (Personal/Group/Status)
```json
{
  "messageId": "3EB0XXXXX",
  "from": "628123456789@s.whatsapp.net",
  "fromMe": false,
  "participant": null,
  "timestamp": "2024-12-08 14:30:00",
  "type": "message",
  "messageType": "conversation",
  "pushName": "John Doe",
  "text": "Hello",
  "quotedMessage": {
    "messageId": "3EB0YYYYY",
    "participant": "628987654321@s.whatsapp.net",
    "text": "Original message text"
  },
  "media": {
    "filename": "20241208143000-abc123.jpg",
    "filepath": "/app/media/628123456789/20241208143000-abc123.jpg",
    "relativePath": "628123456789/20241208143000-abc123.jpg",
    "size": 123456,
    "mimetype": "image/jpeg"
  }
}
```

### Status/Story
```json
{
  "messageId": "3EB0XXXXX",
  "from": "status@broadcast",
  "timestamp": "2024-12-08 14:30:00",
  "type": "status",
  "messageType": "imageMessage",
  "caption": "My status update",
  "mediaType": "image",
  "media": {
    "filename": "20241208143000-xyz789.jpg",
    "filepath": "/app/media/status@broadcast/20241208143000-xyz789.jpg",
    "relativePath": "status@broadcast/20241208143000-xyz789.jpg",
    "size": 234567,
    "mimetype": "image/jpeg"
  }
}
```

### Connection Status
```json
{
  "status": "connected|disconnected|qr_generated",
  "reason": "error message if disconnected",
  "timestamp": "2024-12-08 14:30:00"
}
```

## 📁 Struktur Folder

```
baileys-gateway/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── .env
├── README.md
├── src/
│   └── index.js
├── sessions/          # Session WhatsApp (persistent)
└── media/            # File media yang diterima
    ├── messages/ 
    │   ├── <messageId>.jpg
    │   └── <messageId>.mp4
    └── status/
        └── <messageId>.jpg
```

**Catatan:** Setiap file media yang diterima akan disimpan dalam folder messages / status sesuai jenis.

## 🔄 Docker Commands

```bash
# Start container
docker-compose up -d

# Stop container
docker-compose down

# View logs
docker logs -f baileys_

# Rebuild
docker-compose up -d --build

# Restart
docker-compose restart

# Remove volumes (logout WhatsApp)
docker-compose down -v
```

## ⚙️ Features

✅ Auto reconnect saat disconnect  
✅ QR Code di terminal/logs  
✅ Session persistent (tidak logout saat container stop)  
✅ Download media otomatis  
✅ Support reply message dengan quoted text  
✅ **3 Webhook URL berbeda** dengan data yang sama  
✅ Struktur JSON yang rapi dan konsisten  
✅ Timezone Asia/Jakarta  
✅ Multiple file type support  
✅ Sticker support dengan auto resize  

## ⚠️ Perbedaan WhatsApp Personal vs Business API

| Fitur | WhatsApp Personal (Baileys) | WhatsApp Business API |
|-------|------------------------------|----------------------|
| Interactive Buttons | ❌ Tidak didukung | ✅ Didukung |
| Template Buttons | ❌ Tidak didukung | ✅ Didukung |
| Copy Code Button | ❌ Tidak didukung | ✅ Didukung |
| List Message | ✅ Didukung | ✅ Didukung |
| URL/Call Buttons | ❌ Tidak didukung | ✅ Didukung |

**Solusi untuk WhatsApp Personal:**
- Gunakan **List Message** (`/button` atau `/send-list`) untuk menu interaktif
- Untuk code, kirim dalam format monospace: ```code``` yang bisa di-copy manual
- Untuk URL, kirim sebagai text biasa (akan otomatis jadi link yang bisa diklik)

## 📝 Notes

- Session disimpan di folder `./sessions` (persistent)
- Media disimpan di folder `./media`
- Format nomor: 628123456789 (tanpa +)
- QR Code akan muncul di logs Docker
- Container akan auto restart kecuali di-stop manual

## 🐛 Troubleshooting

**QR Code tidak muncul:**
```bash
docker logs baileys_
```

**Connection error:**
```bash
docker-compose restart
```

**Clear session (logout):**
```bash
docker-compose down
rm -rf sessions/*
docker-compose up -d
```

## 📦 Dependencies

- @whiskeysockets/baileys: ^6.7.8
- express: ^4.18.2
- qrcode-terminal: ^0.12.0
- axios: ^1.6.2
- moment-timezone: ^0.5.44
- multer: ^1.4.5-lts.1
- sharp: ^0.33.1

## 📄 License

MIT

## kn 12.2025
