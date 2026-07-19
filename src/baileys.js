import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
  fetchLatestWaWebVersion,
  isLidUser,
  downloadMediaMessage,
  getContentType,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";
import { CONFIG } from "./config.js";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

export const DOWNLOADS_DIR = "/home/ubuntu/projects/jarvis/data/downloads/whatsapp";
const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB
const DOWNLOAD_TIMEOUT_MS = 30000; // 30 seconds

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    ),
  ]);
}

const ALLOWED_MIMETYPES = new Set([
  // Images
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  // Documents
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  // Audio
  "audio/ogg",
  "audio/aac",
  "audio/mpeg",
  "audio/mp4",
  "audio/amr",
  "audio/wav",
  "audio/webm",
  // Video
  "video/mp4",
  "video/webm",
  "video/3gpp",
  // Archives
  "application/zip",
  "application/x-zip-compressed",
  "application/x-tar",
  "application/gzip",
  "application/x-gzip",
  "application/x-bzip2",
  "application/x-xz",
  "application/vnd.rar",
  "application/x-rar-compressed",
  "application/x-7z-compressed",
]);

const DANGEROUS_EXTENSIONS = new Set([
  ".exe",
  ".bat",
  ".cmd",
  ".sh",
  ".js",
  ".jar",
  ".dll",
  ".app",
  ".apk",
  ".ipa",
]);

function sanitizeFilename(name) {
  if (!name) return "unnamed";
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 100);
}

function extensionFromMimetype(mimetype) {
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.ms-excel": ".xls",
    "audio/ogg": ".ogg",
    "audio/aac": ".aac",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/amr": ".amr",
    "audio/wav": ".wav",
    "audio/webm": ".webm",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/3gpp": ".3gp",
    // Archives
    "application/zip": ".zip",
    "application/x-zip-compressed": ".zip",
    "application/x-tar": ".tar",
    "application/gzip": ".gz",
    "application/x-gzip": ".gz",
    "application/x-bzip2": ".bz2",
    "application/x-xz": ".xz",
    "application/vnd.rar": ".rar",
    "application/x-rar-compressed": ".rar",
    "application/x-7z-compressed": ".7z",
  };
  return map[mimetype] || "";
}

async function saveAttachment(sock, msg, logger) {
  const contentType = getContentType(msg.message);
  if (!contentType) return null;

  const media = msg.message[contentType];
  if (!media || typeof media !== "object") return null;

  const mimetype = media.mimetype || "application/octet-stream";
  const fileSize = media.fileLength || media.size || 0;

  if (!ALLOWED_MIMETYPES.has(mimetype)) {
    throw new Error(`Tipo de archivo no permitido: ${mimetype}`);
  }

  if (fileSize && Number(fileSize) > MAX_ATTACHMENT_SIZE_BYTES) {
    throw new Error(
      `Archivo demasiado grande: ${(Number(fileSize) / 1024 / 1024).toFixed(1)} MB (máx ${MAX_ATTACHMENT_SIZE_BYTES / 1024 / 1024} MB)`
    );
  }

  let filename = media.fileName || "unnamed";
  filename = sanitizeFilename(filename);
  const originalExt = path.extname(filename).toLowerCase();
  if (DANGEROUS_EXTENSIONS.has(originalExt)) {
    throw new Error(`Extensión de archivo no permitida: ${originalExt}`);
  }

  const expectedExt = extensionFromMimetype(mimetype);
  if (!filename.toLowerCase().endsWith(expectedExt)) {
    filename = `${path.basename(filename, originalExt)}${expectedExt}`;
  }

  console.log(`Starting download for ${contentType} (${mimetype}, ${fileSize} bytes)`);
  const buffer = await withTimeout(
    downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage }),
    DOWNLOAD_TIMEOUT_MS,
    `downloadMediaMessage(${contentType})`
  );

  if (!buffer || buffer.length === 0) {
    throw new Error("No se pudo descargar el archivo adjunto");
  }

  if (buffer.length > MAX_ATTACHMENT_SIZE_BYTES) {
    throw new Error(
      `Archivo descargado demasiado grande: ${(buffer.length / 1024 / 1024).toFixed(1)} MB`
    );
  }

  await mkdir(DOWNLOADS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jidSafe = (msg.key.remoteJid || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  const finalName = `${timestamp}_${jidSafe}_${filename}`;
  const filePath = path.join(DOWNLOADS_DIR, finalName);

  await writeFile(filePath, buffer);

  return {
    path: filePath,
    filename: finalName,
    originalName: media.fileName || filename,
    mimetype,
    size: buffer.length,
    caption: media.caption || "",
    type: contentType.replace("Message", "").toLowerCase(), // image, video, document, audio, ptt
  };
}

const RECONNECT_BACKOFF_MS = [5000, 10000, 20000, 30000, 60000];

export async function startBaileys(onMessage, options = {}) {
  const { onSocketUpdate } = options;
  await mkdir(CONFIG.whatsapp.sessionPath, { recursive: true });

  // Fetch the latest WhatsApp Web version directly from WhatsApp servers.
  let waWebVersion;
  try {
    const versionInfo = await fetchLatestWaWebVersion();
    waWebVersion = versionInfo.version;
    console.log("Using WhatsApp Web version:", waWebVersion.join("."));
  } catch (err) {
    console.warn("Could not fetch latest WA Web version, using default:", err.message);
  }

  const { state, saveCreds } = await useMultiFileAuthState(
    CONFIG.whatsapp.sessionPath
  );

  const logger = pino({ level: "warn" });

  const sock = makeWASocket({
    auth: state,
    version: waWebVersion,
    browser: Browsers.macOS("Kimi EA"),
    logger,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    keepAliveIntervalMs: 30000,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    emitOwnEvents: false,
    shouldIgnoreJid: (jid) => {
      // Ignore status broadcasts and newsletter channels.
      return jid?.endsWith("@broadcast") || jid?.endsWith("@newsletter");
    },
  });

  if (onSocketUpdate) {
    onSocketUpdate(sock);
  }

  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let closed = false;

  const cleanup = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (reconnectTimer || closed) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    reconnectAttempt += 1;
    console.log(`Scheduling Baileys reconnect attempt ${reconnectAttempt} in ${delay}ms...`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      startBaileys(onMessage, options).catch((err) => {
        console.error("Baileys reconnection failed:", err);
      });
    }, delay);
  };

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n=== SCAN QR CODE WITH YOUR WHATSAPP ===\n");
      qrcode.generate(qr, { small: true });
      writeFile("/tmp/jarvis-qr-latest.txt", qr).catch(() => {});
    }

    if (connection === "close") {
      cleanup();
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(
        "Connection closed due to",
        lastDisconnect?.error?.message || lastDisconnect?.error,
        ", statusCode:",
        statusCode,
        ", reconnect:",
        shouldReconnect
      );

      if (shouldReconnect) {
        scheduleReconnect();
      } else {
        closed = true;
        console.error("Logged out. Manual re-pairing required.");
      }
    } else if (connection === "open") {
      console.log("WhatsApp connection opened. JID:", sock.user?.id);
      reconnectAttempt = 0;
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // Listen for LID <-> phone number mapping updates so we can identify the owner.
  sock.ev.on("lid-mapping.update", (mapping) => {
    console.log("LID mapping update:", mapping);
  });

  sock.ev.on("messages.upsert", async (m) => {
    console.log(`messages.upsert: ${m.messages?.length ?? 0} message(s), type=${m.type || "unknown"}`);
    for (const msg of m.messages) {
      if (msg.key.fromMe) {
        console.log("Skipping own message");
        continue;
      }

      const chatJid = msg.key.remoteJid;
      const isGroup = chatJid?.endsWith("@g.us");

      // In v7, participantAlt/remoteJidAlt contains the phone-number JID when participant is a LID.
      let authorJid = msg.key.participant || chatJid;
      const authorAltJid = msg.key.participantAlt || msg.key.remoteJidAlt;

      // Prefer the phone-number JID for owner identification.
      const canonicalAuthorJid = authorAltJid || authorJid;

      const contentType = getContentType(msg.message);
      const messageKeys = msg.message ? Object.keys(msg.message) : [];
      console.log(
        `Incoming msg chat=${chatJid} author=${authorJid} alt=${authorAltJid} canonical=${canonicalAuthorJid} contentType=${contentType} keys=${messageKeys.join(",")}`
      );

      const hasMedia =
        contentType === "imageMessage" ||
        contentType === "videoMessage" ||
        contentType === "documentMessage" ||
        contentType === "audioMessage" ||
        contentType === "pttMessage";

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        msg.message?.documentMessage?.caption ||
        "";

      if (!canonicalAuthorJid) {
        console.log("Skipping message without canonical author");
        continue;
      }
      if (!text && !hasMedia) {
        console.log(`Skipping message with no text/media (contentType=${contentType})`);
        continue;
      }

      const isOwner = CONFIG.whatsapp.ownerNumbers.includes(canonicalAuthorJid) ||
        CONFIG.whatsapp.ownerNumbers.includes(authorJid);
      const isWhitelisted =
        CONFIG.whatsapp.whitelist.length === 0 ||
        CONFIG.whatsapp.whitelist.includes(chatJid) ||
        CONFIG.whatsapp.whitelist.includes(canonicalAuthorJid) ||
        CONFIG.whatsapp.whitelist.includes(authorJid);

      console.log(`Auth check: isOwner=${isOwner} isWhitelisted=${isWhitelisted}`);

      if (!isOwner && !isWhitelisted) {
        console.log(
          `Ignoring message from non-whitelisted author=${canonicalAuthorJid} (alt=${authorAltJid}, lid=${authorJid}) chat=${chatJid}`
        );
        continue;
      }

      let attachment = null;
      if (hasMedia) {
        console.log(
          `Detected media message: ${contentType} from ${canonicalAuthorJid} in ${isGroup ? "group " : ""}${chatJid}`
        );
        try {
          attachment = await saveAttachment(sock, msg, logger);
          console.log(
            `Attachment saved from ${canonicalAuthorJid} in ${isGroup ? "group " : ""}${chatJid}: ${attachment.filename} (${attachment.mimetype}, ${(attachment.size / 1024).toFixed(1)} KB)`
          );
        } catch (err) {
          console.error("Failed to download attachment:", err.message);
          // Notify the user that the attachment could not be processed.
          try {
            await sendWhatsAppMessage(
              sock,
              chatJid,
              `No pude procesar el archivo adjunto: ${err.message}`
            );
          } catch (sendErr) {
            console.error("Failed to send attachment error notification:", sendErr);
          }
          // Continue processing the text/caption if present; otherwise skip.
          if (!text) continue;
        }
      }

      console.log(
        `Message from ${canonicalAuthorJid} in ${isGroup ? "group " : ""}${chatJid}: ${text.slice(
          0,
          100
        )}${attachment ? ` [+${attachment.type}]` : ""}`
      );

      try {
        await onMessage({
          sender: chatJid,
          author: canonicalAuthorJid,
          authorLid: isLidUser(authorJid) ? authorJid : undefined,
          text,
          isOwner,
          isGroup,
          msg,
          attachment,
        });
      } catch (err) {
        console.error("Error handling message:", err);
      }
    }
  });

  return sock;
}

export async function sendWhatsAppMessage(sock, to, text) {
  await sock.sendMessage(to, { text });
}
