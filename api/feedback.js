const ALLOWED_ORIGINS = new Set([
  "https://parallelife.origo-cn.com",
  "https://june-mengjun.github.io",
  "http://localhost:8765",
  "null",
]);

const IMPROVE_VALUES = new Set([
  "wilder_quiz",
  "more_like_me",
  "sharper_roast",
  "cooler_visual",
  "smoother_share",
  "shorter_flow",
]);

const SHARE_VALUES = new Set(["yes", "maybe", "no", ""]);
const REDIS_KEY = "parallelife:feedback";

function allowOrigin(req) {
  const origin = req.headers.origin || "";
  return ALLOWED_ORIGINS.has(origin) ? origin : "https://parallelife.origo-cn.com";
}

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", allowOrigin(req));
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Cache-Control", "no-store");
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(5, Math.round(number)));
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanMultiline(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizePayload(input) {
  const improveParts = Array.isArray(input.improve_parts)
    ? input.improve_parts.filter((item) => IMPROVE_VALUES.has(item))
    : [];
  const shareIntent = SHARE_VALUES.has(input.share_intent) ? input.share_intent : "";

  return {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    submitted_at: cleanText(input.submitted_at || new Date().toISOString(), 40),
    idea_score: clampScore(input.idea_score),
    version_score: clampScore(input.version_score),
    improve_parts: [...new Set(improveParts)],
    share_intent: shareIntent,
    message_text: cleanMultiline(input.message_text, 1000),
    species: cleanText(input.species, 40),
    deviation: Math.max(0, Math.min(100, Math.round(Number(input.deviation) || 0))),
    record_card: cleanText(input.record_card, 80),
    page_url: cleanText(input.page_url, 300),
  };
}

async function redis(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error("missing_upstash_env");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(data.error || `upstash_${response.status}`);
  }

  return data.result;
}

function toCsv(rows) {
  const headers = [
    "created_at",
    "idea_score",
    "version_score",
    "improve_parts",
    "share_intent",
    "message_text",
    "species",
    "deviation",
    "record_card",
    "page_url",
  ];
  const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [headers.join(","), ...rows.map((row) => headers.map((key) => escape(row[key])).join(","))].join("\n");
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function handlePost(req, res) {
  const input = await readJsonBody(req);
  const payload = normalizePayload(input);
  payload.user_agent = cleanText(req.headers["user-agent"], 300);

  await redis(["LPUSH", REDIS_KEY, JSON.stringify(payload)]);
  await redis(["LTRIM", REDIS_KEY, "0", "9999"]);

  res.status(200).json({ ok: true, id: payload.id });
}

async function handleGet(req, res) {
  const expected = process.env.ADMIN_TOKEN || "";
  const header = req.headers.authorization || "";

  if (!expected || header !== `Bearer ${expected}`) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  const rawRows = await redis(["LRANGE", REDIS_KEY, "0", String(limit - 1)]);
  const rows = (rawRows || [])
    .map((item) => {
      try {
        return JSON.parse(item);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (req.query.format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=parallelife-feedback.csv");
    res.status(200).send(toCsv(rows));
    return;
  }

  res.status(200).json({ ok: true, rows });
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    if (req.method === "POST") {
      await handlePost(req, res);
      return;
    }

    if (req.method === "GET") {
      await handleGet(req, res);
      return;
    }

    res.status(405).json({ ok: false, error: "method_not_allowed" });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || "server_error",
    });
  }
}
