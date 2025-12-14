# AI Coding Agent Instructions for Baileys WhatsApp Gateway

Welcome to the Baileys WhatsApp Gateway project! This document provides essential guidance for AI coding agents to be productive in this codebase. Follow these instructions to understand the architecture, workflows, and conventions.

---

## 📂 Project Overview

This project is a WhatsApp Gateway built using the Baileys library, with Docker support for deployment. It enables sending and receiving WhatsApp messages, media, and interactive elements via RESTful APIs.

### Key Components:
- **`src/index.js`**: Main application logic, including:
  - Web server setup using Express.
  - WhatsApp session management with Baileys.
  - Webhook integration for external APIs.
  - Media handling (upload/download).
- **`sessions/`**: Persistent storage for WhatsApp sessions.
- **`media/`**: Directory for storing received media files, organized by sender.
- **`docker-compose.yml`**: Docker configuration for running the gateway.

---

## 🛠️ Developer Workflows

### 1. **Setup and Run**
- Clone the repository and configure `.env` with required values (see `README.md`).
- Build and start the Docker container:
  ```bash
  docker-compose up -d --build
  ```
- View logs to scan the QR code:
  ```bash
  docker logs -f baileys_whatsapp_gateway
  ```

### 2. **Testing API Endpoints**
- Use tools like Postman or cURL to test endpoints (e.g., `/send-message`, `/send-file`).
- Refer to `README.md` for detailed API payload examples.

### 3. **Debugging**
- Logs are stored in `/app/log/baileys.log`.
- Use `docker-compose restart` to restart the container if issues arise.

---

## 📐 Project-Specific Conventions

### 1. **Environment Variables**
- `WEBHOOK_URL_1`, `WEBHOOK_URL_2`, `WEBHOOK_URL_3`: URLs for sending webhook data.
- `MEDIA_PATH`: Directory for storing media files.
- `PORT`: Port for the Express server.

### 2. **Media Handling**
- Media files are saved in `media/` under subdirectories named after the sender's number.
- Use `multer` for file uploads and `sharp` for image processing.

### 3. **Webhook Integration**
- Webhooks are triggered for incoming messages, media, and status updates.
- Data is sent to all configured webhook URLs in parallel.

---

## 🔗 Integration Points

### 1. **Baileys Library**
- Handles WhatsApp connections, message sending, and media downloads.
- Key functions:
  - `makeWASocket`: Initializes the WhatsApp connection.
  - `downloadMediaMessage`: Downloads media files.

### 2. **Express Server**
- Routes for API endpoints (e.g., `/send-message`, `/send-file`).
- Middleware for JSON parsing and file uploads.

### 3. **Docker**
- Ensures consistent runtime environment.
- Use `docker-compose` for managing the application lifecycle.

---

## 📝 Examples and Patterns

### 1. **API Endpoint Example**
```javascript
app.post("/send-message", async (req, res) => {
  const { to, text } = req.body;
  try {
    await sock.sendMessage(to, { text });
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
```

### 2. **Webhook Example**
```javascript
async function sendToAllWebhooks(data) {
  const webhooks = [WEBHOOK_URL_1, WEBHOOK_URL_2, WEBHOOK_URL_3].filter(Boolean);
  const promises = webhooks.map((url) => sendWebhook(url, data));
  await Promise.allSettled(promises);
}
```

---

## ⚠️ Notes for AI Agents

- Always validate environment variables before using them.
- Follow the folder structure for organizing media and session files.
- Use `moment-timezone` for consistent timestamp formatting.
- Ensure all webhook calls are non-blocking and handle errors gracefully.

---

For more details, refer to the `README.md` file or explore the `src/` directory.