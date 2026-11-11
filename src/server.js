// src/server.js - AS Cloud Dedicated Realtime Telegram & Messaging Service
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";

dotenv.config();

const PORT = parseInt(process.env.PORT, 10) || 8000;
const TG_API_ID = parseInt(process.env.TELEGRAM_API_ID, 10) || 38648695;
const TG_API_HASH = process.env.TELEGRAM_API_HASH || "9ea926414705c631aa6a908991cac059";
const TG_SESSION = process.env.TELEGRAM_SESSION || "";
const TG_CHANNEL = process.env.TELEGRAM_CHANNEL_ID || "-1002750437982";
const TG_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || "Seven1tel_Number_Bot";
const TG_MUSIC_BOT_USERNAME = process.env.TELEGRAM_MUSIC_BOT || "MusicsHuntersbot";

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

// ---------------------------------------------------------------------------
// Telegram Client Singleton (Persistent Keep-Alive Connection)
// ---------------------------------------------------------------------------
let tgClient = null;
let isTgConnected = false;
let connectionPromise = null;
let isTgHandlerAttached = false;

// Pending Telegram Verification Sessions (code -> session)
const PENDING_TG_CODES = new Map();

function setupTelegramAuthHandler(client) {
  if (isTgHandlerAttached) return;
  isTgHandlerAttached = true;
  console.log("[Telegram Auth] Initializing incoming verification message listener...");

  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message || message.out) return; // Only process incoming messages

      const rawText = (message.message || "").trim();
      if (!rawText) return;

      console.log(`[Telegram Auth] Incoming message from peer:`, message.peerId, `Text: "${rawText}"`);

      // Match code: e.g. "AS-12345" or "12345"
      const match = rawText.match(/AS-\d{4,6}/i) || rawText.match(/\b([A-Z0-9]{5,8})\b/i);
      let foundCode = null;
      let pending = null;

      if (match) {
        const candidate = match[0].toUpperCase();
        if (PENDING_TG_CODES.has(candidate)) {
          foundCode = candidate;
          pending = PENDING_TG_CODES.get(candidate);
        }
      }

      if (!pending) {
        for (const [codeKey, record] of PENDING_TG_CODES.entries()) {
          if (rawText.toUpperCase().includes(codeKey.toUpperCase())) {
            foundCode = codeKey;
            pending = record;
            break;
          }
        }
      }

      if (!pending) {
        console.log(`[Telegram Auth] No pending session found for: "${rawText}"`);
        return;
      }

      console.log(`[Telegram Auth] MATCHED code ${foundCode} for user @${pending.username}!`);

      // 1. REACTION TO INCOMING MESSAGE (Primary User Requirement)
      try {
        const chatInput = await message.getInputChat().catch(() => message.peerId);
        await client.invoke(
          new Api.messages.SendReaction({
            peer: chatInput,
            msgId: message.id,
            reaction: [new Api.ReactionEmoji({ emoticon: "👍" })],
          })
        );
        console.log(`[Telegram Auth] Reaction 👍 sent to message ${message.id}`);
      } catch (reactErr) {
        console.warn(`[Telegram Auth] Primary reaction failed, attempting fallback:`, reactErr.message);
        try {
          const chatInput = await message.getInputChat().catch(() => message.peerId);
          await client.invoke(
            new Api.messages.SendReaction({
              peer: chatInput,
              msgId: message.id,
              reaction: [new Api.ReactionEmoji({ emoticon: "❤️" })],
            })
          );
          console.log(`[Telegram Auth] Fallback reaction ❤️ sent!`);
        } catch (_) {}
      }

      // 2. EXTRACT SENDER INFO
      let senderInfo = {};
      try {
        const sender = await message.getSender();
        if (sender) {
          senderInfo = {
            id: sender.id ? sender.id.toString() : null,
            username: sender.username || null,
            firstName: sender.firstName || "",
            lastName: sender.lastName || "",
            phone: sender.phone || null,
          };
        }
      } catch (_) {}

      // 3. REPLY CONFIRMATION
      try {
        await client.sendMessage(message.peerId, {
          message: `✨ Verification Successful!\n\nWelcome to AS Cloud, @${pending.username}!\nYour account is now verified and logged in. Return to your browser to continue.`,
          replyTo: message.id,
        });
      } catch (replyErr) {
        console.warn("[Telegram Auth] Reply message warning:", replyErr.message);
      }

      // 4. MARK VERIFIED IN RELAY MEMORY
      pending.status = "verified";
      pending.telegramUser = senderInfo;
      pending.verifiedAt = Date.now();
      PENDING_TG_CODES.set(foundCode, pending);

      // 5. NOTIFY MAIN VERCEL API
      try {
        await fetch("https://asllm.vercel.app/api/msg?action=tg_login_confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: foundCode,
            username: pending.username,
            telegramUser: senderInfo,
          }),
        });
        console.log(`[Telegram Auth] Notified main API of verified login for @${pending.username}`);
      } catch (postErr) {
        console.warn("[Telegram Auth] Could not notify main API:", postErr.message);
      }

    } catch (err) {
      console.error("[Telegram Auth Event Handler Error]", err);
    }
  }, new NewMessage({ incoming: true }));
}

async function getTelegramClient() {
  if (tgClient && isTgConnected) return tgClient;
  if (connectionPromise) return connectionPromise;

  connectionPromise = (async () => {
    try {
      if (!TG_SESSION) {
        console.warn("[Telegram] TG_SESSION is not set!");
        return null;
      }
      const session = new StringSession(TG_SESSION);
      tgClient = new TelegramClient(session, TG_API_ID, TG_API_HASH, {
        connectionRetries: 10,
        requestRetries: 3,
        floodSleepThreshold: 60,
        baseLogger: null,
        useWSS: false,
        autoReconnect: true,
      });

      console.log("[Telegram] Connecting persistent MTProto client...");
      await tgClient.connect();
      isTgConnected = true;
      console.log("[Telegram] Client connected successfully and active!");

      setupTelegramAuthHandler(tgClient);

      return tgClient;
    } catch (err) {
      console.error("[Telegram] Connection error:", err);
      isTgConnected = false;
      tgClient = null;
      return null;
    } finally {
      connectionPromise = null;
    }
  })();

  return connectionPromise;
}

// Memory Caches with TTL for sub-5ms responses
const channelCache = { data: null, timestamp: 0 };
const profileCache = new Map(); // cleanId -> { data, timestamp }
const sseClients = new Set();

// ---------------------------------------------------------------------------
// Health Status
// ---------------------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "as-telegram-relay",
    telegram: isTgConnected ? "connected" : "connecting",
    uptime_sec: Math.floor(process.uptime()),
    timestamp: Date.now(),
  });
});

// ---------------------------------------------------------------------------
// 1. Channel Messages Fetcher (Ultra-Fast with 10s Cache)
// ---------------------------------------------------------------------------
app.all(["/api/updates", "/channel"], async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 25, 50);
  const now = Date.now();

  // Return cached result if within 8s
  if (channelCache.data && now - channelCache.timestamp < 8000) {
    return res.json({ success: true, cached: true, ...channelCache.data });
  }

  try {
    const client = await getTelegramClient();
    if (!client) {
      return res.status(503).json({ success: false, error: "Telegram client offline." });
    }

    let messages = [];
    try {
      const entity = await client.getEntity(TG_CHANNEL);
      messages = await client.getMessages(entity, { limit });
    } catch (_) {
      const chanId = BigInt(TG_CHANNEL.replace(/^-100/, ""));
      messages = await client.getMessages(chanId, { limit });
    }

    const cleanMessages = messages
      .filter((m) => m && (m.message || m.media))
      .map((m) => {
        let photoUrl = null;
        if (m.media?.photo) {
          photoUrl = `/api/updates?media=photo&msg_id=${m.id}`;
        }
        return {
          id: m.id,
          date: (m.date || 0) * 1000,
          text: (m.message || "").trim(),
          photo: photoUrl,
          has_media: Boolean(m.media),
          views: m.views || 0,
        };
      });

    const payload = {
      channelTitle: "Live Updates Feed",
      messages: cleanMessages,
      fetchedAt: Date.now(),
    };

    channelCache.data = payload;
    channelCache.timestamp = now;

    res.json({ success: true, cached: false, ...payload });
  } catch (err) {
    console.error("[Channel]", err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------------
// 2. Telegram Profile Lookup (MTProto Entity Resolution)
// ---------------------------------------------------------------------------
app.all(["/api/telegram", "/profile"], async (req, res) => {
  const query = (req.query.q || req.query.username || req.query.id || req.body?.q || "").trim();
  if (!query) {
    return res.status(400).json({ success: false, error: "Missing username or numeric ID." });
  }

  const clean = query.replace(/^@/, "").replace(/^https?:\/\/t\.me\//, "").trim();
  const now = Date.now();
  if (profileCache.has(clean)) {
    const c = profileCache.get(clean);
    if (now - c.timestamp < 30000) {
      return res.json({ success: true, cached: true, ...c.data });
    }
  }

  try {
    const client = await getTelegramClient();
    if (!client) {
      return res.status(503).json({ success: false, error: "Telegram client offline." });
    }

    let entity = null;
    try {
      entity = await client.getEntity(clean);
    } catch (_) {
      if (/^\d+$/.test(clean)) {
        entity = await client.getEntity(BigInt(clean)).catch(() => null);
      }
    }

    if (!entity) {
      return res.status(404).json({ success: false, message: `Profile @${clean} not found.` });
    }

    const firstName = entity.firstName || "";
    const lastName = entity.lastName || "";
    const title = entity.title || `${firstName} ${lastName}`.trim() || clean;
    const isBot = Boolean(entity.bot);
    const isVerified = Boolean(entity.verified);
    const username = entity.username || null;
    const id = entity.id ? entity.id.toString() : clean;

    const data = {
      id,
      name: title,
      username,
      isBot,
      isVerified,
      link: username ? `https://t.me/${username}` : `tg://user?id=${id}`,
      webLink: `https://web.telegram.org/a/#${id}`,
      type: entity.broadcast ? "channel" : entity.megagroup ? "supergroup" : "user",
    };

    profileCache.set(clean, { data, timestamp: now });
    res.json({ success: true, cached: false, ...data });
  } catch (err) {
    console.error("[Profile]", err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------------
// 3. Realtime Messaging Relay & In-Memory SSE Event Stream
// ---------------------------------------------------------------------------
const RECENT_MESSAGES = [];
const RELAY_CHATS = new Map(); // chatId -> array of messages

app.get("/api/msg/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.write(`data: ${JSON.stringify({ type: "connected", time: Date.now() })}\n\n`);
  sseClients.add(res);

  req.on("close", () => {
    sseClients.delete(res);
  });
});

app.post(["/api/msg/send_message", "/api/msg/send"], (req, res) => {
  const msg = req.body?.message || req.body;
  const chatId = msg?.chatId || req.body?.chatId;
  if (!msg || !chatId) return res.status(400).json({ error: "Missing message or chatId" });

  const record = {
    ...msg,
    chatId,
    receivedAt: Date.now(),
  };

  if (!RELAY_CHATS.has(chatId)) RELAY_CHATS.set(chatId, []);
  const list = RELAY_CHATS.get(chatId);
  list.push(record);
  if (list.length > 200) list.shift();

  RECENT_MESSAGES.push(record);
  if (RECENT_MESSAGES.length > 500) RECENT_MESSAGES.shift();

  // Broadcast to all active clients
  const payload = JSON.stringify({ type: "new_message", data: record });
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (_) {}
  }

  res.json({ status: "ok", message: record });
});

app.get(["/api/msg/get_messages", "/api/msg/messages"], (req, res) => {
  const chatId = req.query.chatId;
  if (!chatId) return res.status(400).json({ error: "Missing chatId" });
  const messages = RELAY_CHATS.get(chatId) || [];
  res.json({ status: "ok", messages });
});

app.get("/api/msg/sync", (req, res) => {
  const chatId = req.query.chatId;
  const since = parseInt(req.query.since || "0", 10);
  const msgs = RELAY_CHATS.get(chatId) || [];
  const newMessages = since > 0 ? msgs.filter((m) => m.timestamp > since) : msgs;
  res.json({ status: "ok", chatId, newMessages, timestamp: Date.now() });
});

app.post("/api/msg/sync", (req, res) => {
  const { message, chatId } = req.body || {};
  if (!message) return res.status(400).json({ error: "Missing message payload" });

  const record = {
    ...message,
    chatId: chatId || "global",
    receivedAt: Date.now(),
  };

  if (chatId) {
    if (!RELAY_CHATS.has(chatId)) RELAY_CHATS.set(chatId, []);
    const list = RELAY_CHATS.get(chatId);
    list.push(record);
    if (list.length > 200) list.shift();
  }

  RECENT_MESSAGES.push(record);
  if (RECENT_MESSAGES.length > 500) RECENT_MESSAGES.shift();

  // Broadcast to all active clients
  const payload = JSON.stringify({ type: "new_message", data: record });
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (_) {}
  }

  res.json({ success: true, id: record.id || Date.now() });
});

app.get("/api/msg/poll", (req, res) => {
  const since = parseInt(req.query.since, 10) || 0;
  const filtered = RECENT_MESSAGES.filter((m) => m.receivedAt > since);
  res.json({ success: true, count: filtered.length, messages: filtered });
});

// ---------------------------------------------------------------------------
// 4. Telegram Login & Verification Endpoints
// ---------------------------------------------------------------------------
app.post("/api/tg/register_code", (req, res) => {
  const { code, username } = req.body || {};
  if (!code || !username) {
    return res.status(400).json({ success: false, error: "Missing code or username" });
  }
  const cleanCode = code.toUpperCase().trim();
  const record = {
    code: cleanCode,
    username: username.toLowerCase().trim(),
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000,
  };
  PENDING_TG_CODES.set(cleanCode, record);
  console.log(`[Telegram Auth] Registered code: ${cleanCode} for @${record.username}`);
  res.json({ success: true, record });
});

app.get("/api/tg/check_code", (req, res) => {
  const code = (req.query.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ success: false, error: "Missing code" });
  const record = PENDING_TG_CODES.get(code);
  if (!record) return res.json({ success: false, status: "not_found" });
  res.json({ success: true, status: record.status, record });
});

// ---------------------------------------------------------------------------
// Server Bootstrap
// ---------------------------------------------------------------------------
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`[AS Relay] Server listening on http://0.0.0.0:${PORT}`);
  await getTelegramClient();
});
