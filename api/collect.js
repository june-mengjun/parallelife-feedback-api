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
const MATCH_VALUES = new Set(["too_real", "close", "not_me", "parallel_me", ""]);
const REDIS_KEY = "parallelife:feedback";

function setCors(req, res) {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS.has(origin) ? origin : "https://parallelife.origo-cn.com");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(5, Math.round(number)));
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanMultiline(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizePayload(input) {
  const improveParts = Array.isArray(input.improve_parts)
    ? input.improve_parts.filter((item) => IMPROVE_VALUES.has(item))
    : [];
  const shareIntent = SHARE_VALUES.has(input.share_intent) ? input.share_intent : "";
  const matchLevel = MATCH_VALUES.has(input.match_level) ? input.match_level : "";

  return {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    submitted_at: cleanText(input.submitted_at || new Date().toISOString(), 40),
    match_level: matchLevel,
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
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) throw new Error("missing_upstash_env");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error || `upstash_${response.status}`);
  return data.result;
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  try {
    const raw = req.query.d || "";
    if (!raw) {
      res.status(400).json({ ok: false, error: "missing_payload" });
      return;
    }

    const input = JSON.parse(raw);
    const payload = normalizePayload(input);
    payload.user_agent = cleanText(req.headers["user-agent"], 300);
    payload.via = "collect";

    await redis(["LPUSH", REDIS_KEY, JSON.stringify(payload)]);
    await redis(["LTRIM", REDIS_KEY, "0", "9999"]);

    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.status(200).send(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>`);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "server_error" });
  }
}
