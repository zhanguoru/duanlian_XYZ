// functions/api/messages.js




/**
 * Anonymous one-liner API (Cloudflare Pages Functions + D1)
 *
 * Endpoints:
 *   GET  /api/messages   -> latest 10
 *   POST /api/messages   -> create 1 (rate limited)
 *
 * Required bindings:
 *   env.DB (D1 binding name)
 *
 * Recommended secret:
 *   env.RATE_LIMIT_SALT (Pages project -> Settings -> Functions -> Variables and secrets)
 */

const ALLOWED_ORIGINS = new Set([
  "https://duanlian.xyz",
  "https://www.duanlian.xyz",
]);

// ---------- helpers ----------
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
  }
  // 非允许来源，不返回 CORS 头
  return {};
}


function getClientIp(request) {
  // Cloudflare canonical
  const cfip = request.headers.get("cf-connecting-ip");
  if (cfip) return cfip;

  // Common proxy header fallback
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();

  return "unknown";
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hashBuffer);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function normalizeText(s) {
  // minimal normalize: trim + collapse whitespace
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ");
}

// ---------- handler ----------
export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(request);

  // Preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Safety: ensure DB exists
  if (!env.DB) {
    return json(
      { ok: false, error: "DB binding not found (env.DB is undefined)" },
      500,
      corsHeaders
    );
  }

  // GET: latest 10
  if (request.method === "GET") {
    try {
      const { results } = await env.DB
        .prepare(
          "SELECT id, text, created_at FROM messages ORDER BY created_at DESC LIMIT 10"
        )
        .all();

      return json({ ok: true, data: results || [] }, 200, corsHeaders);
    } catch (e) {
      return json(
        { ok: false, error: "DB error on GET", detail: String(e?.message || e) },
        500,
        corsHeaders
      );
    }
  }

  // POST: create 1 + rate limit
  if (request.method === "POST") {
    try {
      // ---------- minimal rate limit (D1 only) ----------
      const WINDOW_MS = 30_000; // 30s per IP
      const ip = getClientIp(request);
      const salt = env.RATE_LIMIT_SALT || "PLEASE_SET_RATE_LIMIT_SALT";
      const ipHash = await sha256Hex(`${ip}|${salt}`);
      const now = Date.now();

      // Check last submit time
      const rlRow = await env.DB
        .prepare("SELECT last_ts FROM rate_limits WHERE ip_hash = ?")
        .bind(ipHash)
        .first();

      if (rlRow?.last_ts && now - rlRow.last_ts < WINDOW_MS) {
        const retryAfterMs = WINDOW_MS - (now - rlRow.last_ts);
        // Optional: expose Retry-After in seconds
        const retryAfterSec = Math.ceil(retryAfterMs / 1000);

        return json(
          {
            ok: false,
            error: "Too many requests",
            retry_after_ms: retryAfterMs,
          },
          429,
          {
            ...corsHeaders,
            "Retry-After": String(retryAfterSec),
          }
        );
      }

      // Upsert rate limit timestamp
      await env.DB
        .prepare(
          `
          INSERT INTO rate_limits (ip_hash, last_ts)
          VALUES (?, ?)
          ON CONFLICT(ip_hash) DO UPDATE SET last_ts=excluded.last_ts
        `
        )
        .bind(ipHash, now)
        .run();

      // ---------- parse body ----------
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400, corsHeaders);
      }

      const text = normalizeText(body?.text);

      // ---------- validation ----------
      if (!text || text.length < 1 || text.length > 50) {
        return json(
          { ok: false, error: "Text must be 1-50 chars" },
          400,
          corsHeaders
        );
      }

      // ---------- insert message ----------
      await env.DB
        .prepare("INSERT INTO messages (text, created_at) VALUES (?, ?)")
        .bind(text, now)
        .run();

      return json({ ok: true }, 200, corsHeaders);
    } catch (e) {
      return json(
        { ok: false, error: "Server error on POST", detail: String(e?.message || e) },
        500,
        corsHeaders
      );
    }
  }

  // Other methods
  return json({ ok: false, error: "Method not allowed" }, 405, corsHeaders);
}
