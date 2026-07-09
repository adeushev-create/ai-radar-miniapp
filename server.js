/* AI-News — сервер для Telegram Mini App (Railway)
 * Отдаёт мини-апку, хранит лайки, принимает обновления новостей,
 * запоминает подписчиков бота и умеет рассылать им утренние сообщения. */
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// Постоянное хранилище: Railway Volume (если подключён) или локальная папка
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const NEWS_FILE = path.join(DATA_DIR, "news.json");
const VOTES_FILE = path.join(DATA_DIR, "votes.json");
const SUBS_FILE = path.join(DATA_DIR, "subs.json");
const BUNDLED_NEWS = path.join(__dirname, "news.json");

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const BOT_TOKEN = process.env.BOT_TOKEN; // токен бота из BotFather (для рассылки)
const APP_LINK = process.env.APP_LINK || "https://t.me/news_AI_deysh_bot/ai_news";

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj));
}

/* ---------- Telegram API ---------- */
async function tg(method, params) {
  if (!BOT_TOKEN) return { ok: false, description: "no BOT_TOKEN" };
  try {
    const r = await fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params)
    });
    return await r.json();
  } catch (e) {
    return { ok: false, description: String(e) };
  }
}

/* ---------- Новости ---------- */
app.get("/api/news", (req, res) => {
  const news = readJson(NEWS_FILE, null) || readJson(BUNDLED_NEWS, { items: [] });
  res.json(news);
});

/* ---------- Лайки: votes.json = { uid: { itemId: 1|-1 } } ---------- */
let votes = readJson(VOTES_FILE, {});
let flushTimer = null;
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; writeJson(VOTES_FILE, votes); }, 500);
}
function aggregates() {
  const agg = {};
  for (const uid of Object.keys(votes)) {
    for (const [id, v] of Object.entries(votes[uid])) {
      if (!agg[id]) agg[id] = { up: 0, down: 0 };
      if (v === 1) agg[id].up++; else if (v === -1) agg[id].down++;
    }
  }
  return agg;
}

app.get("/api/votes", (req, res) => res.json(aggregates()));

app.post("/api/vote", (req, res) => {
  const { uid, id, v } = req.body || {};
  if (!uid || !id || ![1, -1, 0].includes(v)) return res.status(400).json({ error: "bad request" });
  if (String(uid).length > 64 || String(id).length > 64) return res.status(400).json({ error: "too long" });
  if (!votes[uid]) votes[uid] = {};
  if (v === 0) delete votes[uid][id]; else votes[uid][id] = v;
  scheduleFlush();
  res.json({ ok: true, agg: aggregates()[id] || { up: 0, down: 0 } });
});

/* ---------- Подписчики бота ---------- */
let subs = readJson(SUBS_FILE, {}); // chat_id -> { name, ts }

// Вебхук Telegram: /start подписывает, /stop отписывает
app.post("/tg-webhook", async (req, res) => {
  res.json({ ok: true }); // отвечаем сразу, Telegram не любит ждать
  if (ADMIN_TOKEN && req.get("X-Telegram-Bot-Api-Secret-Token") !== ADMIN_TOKEN) return;
  const msg = req.body && req.body.message;
  if (!msg || !msg.chat) return;
  const chatId = String(msg.chat.id);
  const text = (msg.text || "").trim().toLowerCase();

  if (text.startsWith("/stop")) {
    delete subs[chatId];
    writeJson(SUBS_FILE, subs);
    await tg("sendMessage", { chat_id: chatId, text: "Ок, больше не буду писать по утрам. Вернуться — /start" });
    return;
  }
  const isNew = !subs[chatId];
  subs[chatId] = { name: msg.chat.first_name || msg.chat.title || "", ts: Date.now() };
  writeJson(SUBS_FILE, subs);
  await tg("sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: isNew
      ? "Привет! Я AI-News 🛰️\n\nКаждое утро приношу свежие новости нейросетей — по-русски и простым языком, пока другие ещё гуглят, что такое «инференс».\n\nЛента с карточками и лайками — тут: " + APP_LINK + "\n\nОтписаться от утренних сообщений — /stop"
      : "Ты уже в деле 😎 Лента тут: " + APP_LINK
  });
});

// Рассылка (для утренней задачи): GET /api/broadcast?token=...&data=<base64url текста>
app.get("/api/broadcast", async (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) return res.status(403).json({ error: "forbidden" });
  let text;
  try { text = Buffer.from(String(req.query.data || ""), "base64url").toString("utf8"); } catch {}
  if (!text) return res.status(400).json({ error: "no text" });
  const ids = Object.keys(subs);
  let sent = 0, failed = 0;
  for (const chatId of ids) {
    const r = await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text, disable_web_page_preview: true });
    if (r.ok) sent++; else { failed++; if (r.error_code === 403) { delete subs[chatId]; } }
    await new Promise(r2 => setTimeout(r2, 50)); // не спешим, лимиты Telegram
  }
  writeJson(SUBS_FILE, subs);
  res.json({ ok: true, sent, failed, subscribers: Object.keys(subs).length });
});

app.get("/api/subs", (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) return res.status(403).json({ error: "forbidden" });
  res.json({ subscribers: Object.keys(subs).length });
});

/* ---------- Приём свежих новостей кусками ----------
 * GET /api/ingest?token=...&tag=2026-07-10&seq=1&total=12&data=<base64url> */
const chunks = {}; // tag -> { total, parts, ts }

app.get("/api/ingest", (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) return res.status(403).json({ error: "forbidden" });
  const { tag, seq, total, data } = req.query;
  const s = parseInt(seq, 10), t = parseInt(total, 10);
  if (!tag || !data || !s || !t || s < 1 || s > t || t > 500) return res.status(400).json({ error: "bad chunk" });

  const now = Date.now();
  for (const k of Object.keys(chunks)) if (now - chunks[k].ts > 36e5) delete chunks[k];
  if (!chunks[tag]) chunks[tag] = { total: t, parts: {}, ts: now };
  chunks[tag].parts[s] = data;
  chunks[tag].ts = now;

  const got = Object.keys(chunks[tag].parts).length;
  if (got < t) return res.json({ ok: true, received: got, total: t });

  try {
    let b64 = "";
    for (let i = 1; i <= t; i++) b64 += chunks[tag].parts[i];
    const news = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    if (!Array.isArray(news.items) || !news.items.length) throw new Error("no items");
    writeJson(NEWS_FILE, news);
    delete chunks[tag];
    return res.json({ ok: true, saved: true, items: news.items.length });
  } catch (e) {
    delete chunks[tag];
    return res.status(422).json({ error: "assemble failed: " + e.message });
  }
});

app.get("/api/health", (req, res) => {
  const news = readJson(NEWS_FILE, null) || readJson(BUNDLED_NEWS, { items: [] });
  res.json({ ok: true, items: news.items.length, updated: news.updated || null, bot: !!BOT_TOKEN, subscribers: Object.keys(subs).length });
});

/* ---------- Статика ---------- */
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("AI-News mini app on :" + PORT);
  // Автонастройка вебхука, чтобы бот видел /start
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (BOT_TOKEN && domain) {
    const r = await tg("setWebhook", {
      url: "https://" + domain + "/tg-webhook",
      secret_token: ADMIN_TOKEN || undefined,
      allowed_updates: ["message"]
    });
    console.log("setWebhook:", JSON.stringify(r));
  }
});
