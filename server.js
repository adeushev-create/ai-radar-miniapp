/* AI-Радар — сервер для Telegram Mini App (Railway)
 * Отдаёт мини-апку, хранит лайки и принимает обновления новостей. */
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
const BUNDLED_NEWS = path.join(__dirname, "news.json");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj));
}

/* ---------- Новости ---------- */
app.get("/api/news", (req, res) => {
  const news = readJson(NEWS_FILE, null) || readJson(BUNDLED_NEWS, { items: [] });
  res.json(news);
});

/* ---------- Лайки ----------
 * votes.json: { "<uid>": { "<itemId>": 1 | -1 } } */
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

/* ---------- Приём свежих новостей (для утренней задачи Claude) ----------
 * Данные приходят GET-запросами кусками:
 *   /api/ingest?token=...&tag=2026-07-10&seq=1&total=12&data=<base64url-кусок>
 * Когда все куски на месте — собираем, проверяем JSON и сохраняем. */
const chunks = {}; // tag -> { total, parts: { seq: data }, ts }

app.get("/api/ingest", (req, res) => {
  const token = process.env.ADMIN_TOKEN;
  if (!token || req.query.token !== token) return res.status(403).json({ error: "forbidden" });

  const { tag, seq, total, data } = req.query;
  const s = parseInt(seq, 10), t = parseInt(total, 10);
  if (!tag || !data || !s || !t || s < 1 || s > t || t > 500) return res.status(400).json({ error: "bad chunk" });

  // подчистить старые незавершённые загрузки (старше часа)
  const now = Date.now();
  for (const k of Object.keys(chunks)) if (now - chunks[k].ts > 36e5) delete chunks[k];

  if (!chunks[tag]) chunks[tag] = { total: t, parts: {}, ts: now };
  chunks[tag].parts[s] = data;
  chunks[tag].ts = now;

  const got = Object.keys(chunks[tag].parts).length;
  if (got < t) return res.json({ ok: true, received: got, total: t });

  // все куски собраны
  try {
    let b64 = "";
    for (let i = 1; i <= t; i++) b64 += chunks[tag].parts[i];
    const json = Buffer.from(b64, "base64url").toString("utf8");
    const news = JSON.parse(json);
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
  res.json({ ok: true, items: news.items.length, updated: news.updated || null });
});

/* ---------- Статика ---------- */
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("AI-Radar mini app on :" + PORT));
