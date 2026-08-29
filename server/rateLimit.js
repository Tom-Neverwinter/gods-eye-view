/**
 * Per-IP rate limiting shared by the dev-server API proxies. Extracted out of
 * vite.config.js (#41 — security-sensitive middleware split out of the
 * 7k+ line config) so it can be reviewed, tested, and imported on its own.
 * @module server/rateLimit
 */

/**
 * Minimal fixed-window per-key rate limiter for the dev proxies. Not a hard
 * security boundary (dev-only), just a backstop so a runaway client can't hammer
 * the public Overpass / OSRM mirrors or exhaust this process.
 */
const RATE_LIMITER_MAX_KEYS = 2000;
export function makeRateLimiter({ windowMs, max, globalMax }) {
  const hits = new Map(); // key -> number[] (timestamps within window)
  let globalTimes = []; // all hits in window, for the global backstop
  return function allow(key) {
    const now = Date.now();
    globalTimes = globalTimes.filter((t) => now - t < windowMs);
    if (globalMax && globalTimes.length >= globalMax) return false; // global backstop
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(now);
    hits.set(key, recent);
    globalTimes.push(now);
    // Hard key cap so a key-rotating caller can't grow the map without bound.
    if (hits.size > RATE_LIMITER_MAX_KEYS) {
      const oldest = hits.keys().next().value;
      if (oldest !== undefined) hits.delete(oldest);
    }
    if (hits.size > 256) {
      for (const [k, v] of hits) {
        if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
      }
    }
    return true;
  };
}

/**
 * Per-IP rate limiter for the cost-bearing API proxies (OpenAI / Google).
 * DEFAULT-ON (#16/#17/#18/#19): an unset env var uses `defaultMax`, not
 * unlimited — this is a key-brokering process, and an exposed deployment
 * that forgot to configure a limiter should still have a backstop. An
 * explicit `0` (or any non-positive/non-numeric value) is the deliberate
 * opt-OUT for a trusted local-only setup, returning `null` so the caller
 * skips the check entirely. A positive integer N (env or default) enables a
 * fixed 60s window of N requests/IP (built lazily once, then reused so its
 * per-IP window state persists across requests). The global backstop is set
 * to a generous multiple of the per-IP cap so a single host can't starve the
 * rest.
 *
 * @param {string|undefined} envValue - Raw env value (requests/min/IP).
 * @param {number} defaultMax - Cap used when envValue is unset/empty.
 * @returns {((key:string)=>boolean)|null} An `allow(key)` fn, or null when unlimited.
 */
export function makeCostRateLimiter(envValue, defaultMax) {
  const max = envValue === undefined || envValue === '' ? defaultMax : Number(envValue);
  if (!Number.isFinite(max) || max <= 0) return null; // explicit 0/garbage -> opt out (unlimited)
  return makeRateLimiter({ windowMs: 60_000, max: Math.floor(max), globalMax: Math.floor(max) * 20 });
}
/** Default per-IP cap (requests/min) when GEV_RATELIMIT_OPENAI_PER_MIN is unset. */
const OPENAI_RATELIMIT_DEFAULT_PER_MIN = 30;
/** Default per-IP cap (requests/min) when GEV_RATELIMIT_GOOGLE_PER_MIN is unset. */
const GOOGLE_RATELIMIT_DEFAULT_PER_MIN = 60;
// Built LAZILY on first request, NOT at module load: `.env` values are applied to process.env later
// (the plugin config hook calls loadEnv → process.env, AFTER this module is imported), so reading
// process.env here at import time would always see them unset and silently apply the wrong default
// (or miss an explicit opt-out) even when configured via .env. Building on first request (like the
// OPENAI_API_KEY reads) sees the loaded env; the result is cached so the limiter's per-IP window
// state persists. `null` = unlimited (explicit opt-out only).
let _openAiRateLimiter; // undefined = not built yet; null = unlimited; fn = active limiter
let _googleRateLimiter;
/** OpenAI cost endpoints (realtime/token + hud-summary). Default-on (30/min/IP). */
export function openAiRateLimiter() {
  if (_openAiRateLimiter === undefined) {
    _openAiRateLimiter = makeCostRateLimiter(process.env.GEV_RATELIMIT_OPENAI_PER_MIN, OPENAI_RATELIMIT_DEFAULT_PER_MIN);
  }
  return _openAiRateLimiter;
}
/** Google cost endpoints (nearby-places, text-search, CCTV Street View fallback). Default-on (60/min/IP). */
export function googleRateLimiter() {
  if (_googleRateLimiter === undefined) {
    _googleRateLimiter = makeCostRateLimiter(process.env.GEV_RATELIMIT_GOOGLE_PER_MIN, GOOGLE_RATELIMIT_DEFAULT_PER_MIN);
  }
  return _googleRateLimiter;
}

/**
 * Client key for rate limiting. Uses the real socket peer address only — we do
 * NOT trust X-Forwarded-For (client-controlled; a rotating value would mint fresh
 * quota and grow the limiter map). This is a localhost dev proxy, so the socket
 * address is the real client.
 */
export function clientKey(req) {
  return String(req.socket?.remoteAddress || 'local');
}

/**
 * Apply an opt-in limiter to a request, writing a 429 when over the cap.
 * When `limiter` is null (unlimited, the default) this is a no-op returning
 * `true`, so the handler proceeds exactly as before.
 *
 * @param {((key:string)=>boolean)|null} limiter
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {boolean} True if the request may proceed; false if a 429 was sent.
 */
export function enforceOptInRateLimit(limiter, req, res) {
  if (!limiter) return true; // unlimited (default) — no behavior change
  if (limiter(clientKey(req))) return true;
  res.statusCode = 429;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Retry-After', '5');
  res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
  return false;
}
