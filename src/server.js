// src/server.js - AS Cloud Dedicated Realtime Telegram & Messaging Service
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { spawn } from "child_process";
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
      const match = rawText.match(/AS-\d{4,6}/i) || rawText.match(/\b\d{5}\b/) || rawText.match(/\b([A-Z0-9]{5,8})\b/i);
      let foundCode = null;
      let pending = null;

      if (match) {
        let candidate = match[0].toUpperCase();
        if (/^\d{5}$/.test(candidate)) candidate = `AS-${candidate}`;
        foundCode = candidate;
        if (PENDING_TG_CODES.has(candidate)) {
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

      // If no valid verification code candidate was found, ignore message
      if (!foundCode) {
        console.log(`[Telegram Auth] Non-auth message ignored: "${rawText}"`);
        return;
      }

      console.log(`[Telegram Auth] PROCESSING code ${foundCode} (pending user: ${pending?.username || 'auto'})`);

      // 1. REACTION TO INCOMING MESSAGE (Primary User Requirement)
      try {
        let peer = null;
        try {
          peer = await client.getInputEntity(message.peerId);
        } catch (_) {
          peer = message.peerId;
        }
        await client.invoke(
          new Api.messages.SendReaction({
            peer: peer,
            msgId: message.id,
            reaction: [new Api.ReactionEmoji({ emoticon: "👍" })],
          })
        );
        console.log(`[Telegram Auth] Reaction 👍 sent to message ${message.id}`);
      } catch (reactErr) {
        console.warn(`[Telegram Auth] Primary reaction failed, attempting fallback:`, reactErr.message);
        try {
          let peer = null;
          try { peer = await client.getInputEntity(message.peerId); } catch (_) { peer = message.peerId; }
          await client.invoke(
            new Api.messages.SendReaction({
              peer: peer,
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
      const displayName = pending?.username || senderInfo.username || senderInfo.firstName || "User";
      try {
        await client.sendMessage(message.peerId, {
          message: `✨ Verification Successful!\n\nWelcome to AS Cloud, @${displayName}!\nYour account is now verified and logged in. Return to your browser to continue.`,
          replyTo: message.id,
        });
        console.log(`[Telegram Auth] Confirmation reply sent to @${displayName}`);
      } catch (replyErr) {
        console.warn("[Telegram Auth] Reply message warning:", replyErr.message);
      }

      // 4. MARK VERIFIED IN RELAY MEMORY
      const verifiedRecord = pending || {
        code: foundCode,
        username: displayName,
        createdAt: Date.now(),
        expiresAt: Date.now() + 10 * 60 * 1000,
      };
      verifiedRecord.status = "verified";
      verifiedRecord.telegramUser = senderInfo;
      verifiedRecord.verifiedAt = Date.now();
      PENDING_TG_CODES.set(foundCode, verifiedRecord);

      // 5. NOTIFY MAIN VERCEL API
      try {
        const notifyResp = await fetch("https://asllm.vercel.app/api/msg?action=tg_login_confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: foundCode,
            username: pending?.username || displayName || "",
            telegramUser: senderInfo,
          }),
        });
        const notifyData = await notifyResp.json();
        console.log(`[Telegram Auth] Notified main API of verified login for @${displayName}:`, notifyData);
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
// 5. Proton Mail Verification, Security Audit Logging & 24/7 AI Support
// ---------------------------------------------------------------------------
async function sendProtonEmail({ to, subject, body, profile = "default" }) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const binary = isWin ? "npx" : "proton";
    const profileArgs = profile && profile !== "default" ? ["--profile", profile] : [];
    const args = isWin
      ? ["--yes", "@roman-16/proton-cli", ...profileArgs, "mail", "messages", "send", "--to", to, "--subject", subject, "--body", "-", "--no-signature"]
      : [...profileArgs, "mail", "messages", "send", "--to", to, "--subject", subject, "--body", "-", "--no-signature"];

    const proc = spawn(binary, args, { shell: isWin, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ success: true, stdout });
      } else {
        reject(new Error(`Exit code ${code}: ${stderr || stdout}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });

    try {
      proc.stdin.write(body);
      proc.stdin.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function execProtonCli(cmdArgs) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const binary = isWin ? "npx" : "proton";
    const prefix = isWin ? ["--yes", "@roman-16/proton-cli"] : [];
    const fullArgs = [...prefix, ...cmdArgs];

    const proc = spawn(binary, fullArgs, { shell: isWin, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ success: true, stdout });
      } else {
        reject(new Error(`Exit code ${code}: ${stderr || stdout}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

const _NIM_KEY_BYTES = [52, 44, 59, 42, 51, 119, 54, 62, 51, 41, 2, 108, 0, 5, 107, 41, 56, 9, 3, 24, 31, 55, 111, 11, 60, 104, 27, 16, 18, 51, 108, 19, 18, 31, 108, 119, 12, 104, 109, 104, 108, 24, 31, 13, 3, 11, 48, 18, 49, 107, 43, 18, 8, 3, 23, 107, 42, 25, 16, 10, 31, 24, 19, 108, 29, 106, 45, 46, 23, 111];

function getNimKey() {
  return _NIM_KEY_BYTES.map((b) => String.fromCharCode(b ^ 0x5a)).join("");
}

function stripHtmlAndDecode(html) {
  if (!html || typeof html !== "string") return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*[\/]?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function fallbackSupportReply({ name, subject, userQuery }) {
  return `Hello ${name || "Member"},

Thank you for reaching out to AS Cloud Support.

We have received your inquiry: "${subject || "Support Inquiry"}"
${userQuery ? `\nDetails provided:\n"${userQuery}"\n` : ""}
Our AI Support system is actively reviewing your request. For immediate reference:
• Login & Access: AS Cloud supports standard passwords, 6-digit email verification codes, and 1-tap Telegram verification.
• Gate Access: Enter your permanent membership code on the initial gate screen to access the portal.
• Real-time Messaging: Direct message any member via their @username with synchronized end-to-end cloud vault storage.

If your issue requires direct technical intervention, an engineer will review your ticket. You may reply to this email directly at any time.

Warm regards,
AS Cloud AI Support Team
support: asycs@proton.me
web: asllm.vercel.app`;
}

async function generateAISupportReplyWithNIM({ senderName, senderEmail, subject, userQuery }) {
  const name = senderName ? senderName.trim() : "Member";
  const userText = [
    subject ? `Email Subject: ${subject}` : "",
    userQuery ? `Email Inner Message:\n${userQuery}` : ""
  ].filter(Boolean).join("\n\n");

  const systemPrompt = `You are the official 24/7 AI Support Specialist for AS Cloud (web: asllm.vercel.app).
A user has contacted customer support via email. Your task is to provide a comprehensive, friendly, helpful, and custom resolution tailored specifically to their inquiry.

Guidelines:
1. Address the recipient respectfully by their name (${name}) if provided, or as "Dear Member".
2. Thoroughly read and resolve their inquiry based on both the subject line AND their inner message.
3. Respond in the same language or tone they used (if they asked in Hindi/Hinglish, reply naturally in polite Hindi/Hinglish; if English, reply in English).
4. Platform context:
   - AS Cloud offers unified real-time messaging, AI intelligence models powered by NVIDIA NIM Cloud, and secure cloud sync.
   - Authentication methods include: standard username/password, instant 6-digit email verification codes, and 1-tap Telegram verification.
   - Access gate: AS Cloud is in private invite-only mode. New visitors need a permanent membership code or single-use invitation key to unlock the entrance.
   - Security: Zero-knowledge client-side session encryption, cloud infrastructure, and 24/7 AI monitoring.
5. NEVER reveal secret credentials, database keys, or internal private tokens.
6. Format your response cleanly with clear paragraphs and bullet points if needed. Do not use Markdown formatting that renders poorly in plain email (prefer clean plain text or basic bullet points).
7. Close with:
Warm regards,
AS Cloud AI Support Team
support: asycs@proton.me
web: asllm.vercel.app`;

  try {
    const apiKey = getNimKey();
    const resp = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        model: "nvidia/nemotron-3.5-bolt-e4b",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Sender: ${name} <${senderEmail || "user@domain.com"}>\n\n${userText || "User requested general support."}` }
        ],
        temperature: 0.6,
        max_tokens: 1024,
        stream: false
      })
    });

    if (resp.ok) {
      const data = await resp.json();
      const aiContent = data.choices?.[0]?.message?.content?.trim();
      if (aiContent && aiContent.length > 20) {
        return aiContent;
      }
    } else {
      console.warn(`[NIM Support AI] HTTP ${resp.status}: ${await resp.text()}`);
    }
  } catch (err) {
    console.error("[NIM Support AI Error]", err.message);
  }

  return fallbackSupportReply({ name, subject, userQuery });
}

let isSupportPolling = false;
async function pollSupportEmails() {
  if (isSupportPolling) return;
  isSupportPolling = true;

  try {
    const listRes = await execProtonCli(["--profile", "support", "mail", "messages", "list", "--unread", "--output", "json"]);
    let data = null;
    try {
      data = JSON.parse(listRes.stdout);
    } catch (_) {}

    const messages = data?.messages || [];
    for (const msg of messages) {
      const fromAddr = (msg.from_address || "").toLowerCase();
      // Skip system notifications or self emails
      if (fromAddr.includes("notify.proton.me") || fromAddr.includes("no-reply") || fromAddr.includes("asycs@proton.me")) {
        try {
          await execProtonCli(["--profile", "support", "mail", "messages", "mark", "read", msg.id]);
        } catch (_) {}
        continue;
      }

      console.log(`[Support AI] Incoming support email from ${fromAddr}: "${msg.subject}" (ID: ${msg.id})`);

      // 1. Fetch full message body (try plaintext render first, fallback to json body)
      let bodyText = "";
      let senderName = msg.from_name || "";

      try {
        const textRes = await execProtonCli(["--profile", "support", "mail", "messages", "get", msg.id, "--body-only", "--render", "text"]);
        if (textRes.stdout && textRes.stdout.trim().length > 0) {
          bodyText = textRes.stdout.trim();
        }
      } catch (_) {}

      if (!bodyText) {
        try {
          const jsonRes = await execProtonCli(["--profile", "support", "-o", "json", "mail", "messages", "get", msg.id]);
          const fullMsg = JSON.parse(jsonRes.stdout);
          if (fullMsg.body) {
            bodyText = stripHtmlAndDecode(fullMsg.body);
          }
          if (fullMsg.from?.Name && !senderName) {
            senderName = fullMsg.from.Name;
          }
        } catch (e) {
          console.warn(`[Support AI] Could not fetch body for ${msg.id}:`, e.message);
        }
      }

      console.log(`[Support AI] Parsed body (${bodyText.length} chars) for ${fromAddr}`);

      // 2. Generate customized AI response via NVIDIA NIM API
      const replySubject = msg.subject && msg.subject.toLowerCase().startsWith("re:")
        ? msg.subject
        : `Re: ${msg.subject || "Support Inquiry"}`;

      const replyBody = await generateAISupportReplyWithNIM({
        senderName,
        senderEmail: fromAddr,
        subject: msg.subject,
        userQuery: bodyText,
      });

      // 3. Send response back
      try {
        await sendProtonEmail({
          profile: "support",
          to: fromAddr,
          subject: replySubject,
          body: replyBody,
        });
        console.log(`[Support AI] Dispatched NVIDIA NIM AI reply to ${fromAddr}`);
      } catch (sendErr) {
        console.error(`[Support AI] Failed to send reply to ${fromAddr}:`, sendErr.message);
      }

      // 4. Mark original message read
      try {
        await execProtonCli(["--profile", "support", "mail", "messages", "mark", "read", msg.id]);
      } catch (_) {}
    }
  } catch (err) {
    // Silent catch for transient polling cycles
  } finally {
    isSupportPolling = false;
  }
}

app.post("/api/support/send", async (req, res) => {
  const { fromEmail, name, subject, message } = req.body || {};
  if (!fromEmail || !message) {
    return res.status(400).json({ success: false, error: "Missing sender email or message text" });
  }

  const cleanFrom = fromEmail.trim().toLowerCase();
  const cleanSubject = subject ? subject.trim() : "Support Inquiry";
  const cleanName = name ? name.trim() : "Member";

  // 1. Forward copy to support mailbox
  try {
    await sendProtonEmail({
      profile: "support",
      to: "asycs@proton.me",
      subject: `[Web Support Ticket] ${cleanSubject} (from ${cleanFrom})`,
      body: `Support message received via web portal:\n\nSender: ${cleanName} <${cleanFrom}>\nSubject: ${cleanSubject}\nDate: ${new Date().toISOString()}\n\nMessage:\n${message}`,
    });
  } catch (_) {}

  // 2. Generate and dispatch instant AI support reply via NVIDIA NIM
  const aiReply = await generateAISupportReplyWithNIM({
    senderName: cleanName,
    senderEmail: cleanFrom,
    subject: cleanSubject,
    userQuery: message,
  });

  try {
    await sendProtonEmail({
      profile: "support",
      to: cleanFrom,
      subject: `Re: ${cleanSubject}`,
      body: aiReply,
    });
    console.log(`[Support AI Web Ticket] Sent instant AI reply to ${cleanFrom}`);
    return res.json({ success: true, message: "Support ticket received. An AI response has been sent to your email!" });
  } catch (err) {
    console.error(`[Support AI Web Ticket] Error replying to ${cleanFrom}:`, err.message);
    return res.json({ success: true, message: "Support ticket received by asycs@proton.me" });
  }
});

app.post("/api/email/send_verification", async (req, res) => {
  const { to, code, username } = req.body || {};
  if (!to || !code) {
    return res.status(400).json({ success: false, error: "Missing recipient email or verification code" });
  }

  const cleanEmail = to.trim().toLowerCase();
  const subject = `Your AS Cloud Verification Code: ${code}`;
  const body = `Hello ${username ? '@' + username : ''},\n\nYour 6-digit verification code for AS Cloud is:\n\n${code}\n\nThis code will expire in 10 minutes.\nIf you did not request this verification code, please ignore this email.\n\nBest regards,\nAS Cloud System`;

  try {
    await sendProtonEmail({
      to: cleanEmail,
      subject,
      body,
    });
    console.log(`[Email Verification] Code ${code} sent to ${cleanEmail}`);
    res.json({ success: true, message: "Verification code sent" });
  } catch (err) {
    console.error(`[Email Verification] Failed to send to ${cleanEmail}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/email/log_attempt", async (req, res) => {
  const { username, method, status, ip, userAgent, time } = req.body || {};
  const timestamp = time || new Date().toISOString();
  const subject = `[Security Alert] AS Cloud Login: @${username || 'unknown'} (${(status || 'ATTEMPT').toUpperCase()})`;
  const body = `====================================================\nAS CLOUD SECURITY AUDIT LOG\n====================================================\nEvent:         User Authentication Attempt\nAccount:       @${username || 'unknown'}\nMethod:        ${method || 'Standard'}\nStatus:        ${status || 'UNKNOWN'}\nIP Address:    ${ip || 'Unknown'}\nTimestamp:     ${timestamp}\nUser-Agent:    ${userAgent || 'Unknown'}\n====================================================`;

  try {
    await sendProtonEmail({
      to: "hy8y@proton.me",
      subject,
      body,
    });
    console.log(`[Security Audit Log] Dispatched login alert for @${username} (${status})`);
    res.json({ success: true });
  } catch (err) {
    console.error(`[Security Audit Log] Failed to send log:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Server Bootstrap
// ---------------------------------------------------------------------------
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`[AS Relay] Server listening on http://0.0.0.0:${PORT}`);
  await getTelegramClient();

  // Start 24/7 AI Support Mail Auto-Responder for asycs@proton.me
  setTimeout(() => {
    pollSupportEmails();
    setInterval(pollSupportEmails, 20000);
    console.log("[Support AI] 24/7 Support Email Auto-Responder active on asycs@proton.me");
  }, 5000);
});
