# Security

God's Eye View is a local-first client for **public** data. It is built for exploration, demos, and learning — not as a hardened production service. This document explains the security model so you can run it safely and report issues responsibly.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for anything exploitable.

- Use GitHub's [private vulnerability reporting](https://github.com/bilawalsidhu/gods-eye-view/security/advisories/new) (Security tab → "Report a vulnerability"), or
- Reach the maintainer directly via the contact on the GitHub profile.

Include repro steps and impact. We'll acknowledge, investigate, and credit you (if you'd like) once a fix ships.

## How secrets are handled

The golden rule: **secret-bearing API keys stay on the server side.** The dev/preview server (Vite middleware in `vite.config.js`) brokers requests that need private credentials, so the browser never receives those long-lived secrets. Google Maps and Cesium ion are the two deliberate client-side exceptions described below.

| Key | Where it lives | How the browser uses it |
|-----|----------------|--------------------------|
| `OPENAI_API_KEY` | Server only | Browser fetches a short-lived **ephemeral** Realtime session token from `/api/realtime/token`; the real key never ships |
| `AISSTREAM_API_KEY` | Server only | Server holds the AISStream websocket; browser polls the same-origin `/api/ais-live` cache |
| OpenSky OAuth (`OPENSKY_CLIENT_ID/SECRET`) | Server only | Server mints + refreshes the token behind `/api/opensky` |
| `WIGLE_API_NAME` / `WIGLE_API_TOKEN` | Server only | Server does the Basic-Auth WiGLE query; browser fetches the same-origin `/api/wigle/search` cache |
| `TAK_CLIENT_CERT_PATH` / `TAK_CLIENT_KEY_PATH` / `TAK_CLIENT_KEY_PASSPHRASE` | Server only (local file paths, never uploaded) | Server holds the one mutual-TLS TAK Server connection; browser polls the same-origin `/api/tak/events` cache |
| `GOOGLE_MAPS_SERVER_API_KEY` (optional, #33) | Server only | Server calls Places (`/api/google/nearby-places`, `/api/google/text-search`) and the Street View fallback with this key; falls back to `GOOGLE_MAPS_API_KEY` when unset |

### Two deliberately client-side keys — restrict them

These are designed to be used directly in the browser (like a Mapbox public token). They are injected into the client bundle via Vite's `define`, so they **will** be visible in browser devtools. Scope and restrict them rather than trying to hide them:

1. **Google Maps API key** — loads the Photorealistic 3D Tiles and the browser-side geocoder in the browser. **Restrict it** (HTTP referrer + API restriction to Map Tiles API + Geocoding API only) in the Google Cloud Console. An unrestricted key in a public deployment can be abused and billed to you.
2. **Cesium ion token** (`CESIUM_ION_TOKEN`, optional — only for the Bing world-imagery map stacks) — used as `Cesium.Ion.defaultAccessToken` client-side. Use a public **`assets:read`** token with **URL restrictions** for any hosted deployment.

> The Vite `define` block in `vite.config.js` controls exactly what reaches the client: only these two keys plus two non-secret CCTV feature flags. Everything else stays server-side.

**Places and Street View never needed to be on that list** (#33): they're called from the server-side proxies in the table above, using `GOOGLE_MAPS_SERVER_API_KEY` when set. Splitting it from the browser-exposed key means each key's Google Cloud restriction can actually match what it does — the browser key referrer-restricted to Map Tiles/Geocoding, the server key IP-restricted (never a referrer, since it never leaves your server) to Places/Street View — instead of one key that has to be either over-permissioned or broken for one of its two jobs. A single shared `GOOGLE_MAPS_API_KEY` still works if you don't split them; it just has to cover all four APIs.

Never commit real keys. `.env` is gitignored; only `.env.example` (placeholder names) is tracked. On macOS the launcher reads keys from the Keychain; on other platforms use env vars or a local `.env`.

## Server-side proxy hardening

The data proxies in `vite.config.js` are written so the browser cannot turn the server into an open relay:

- **No arbitrary-URL fetching.** The CCTV frame/media proxies fetch only server-registered camera URLs — clients cannot pass an upstream URL to fetch. Those registered URLs are themselves checked: rejected at load time and again at fetch time if they're not a plausible public http(s) destination (no loopback/private/link-local/multicast literal, no `.local`/`localhost`), then DNS-resolved and pinned to the checked address so a rebinding DNS answer can't redirect the connection after the check. The GBFS proxy (already host/path-allowlisted) refuses any redirect outright rather than following it unchecked. Other proxies target fixed upstream hosts.
- **Radio is not an audio relay.** `/api/radio/stations` contacts only allowlisted Radio Browser HTTPS hosts and paths, rejects redirects, rejects any hostname with a loopback/private/link-local/metadata/non-public A or AAAA result, and pins each TLS connection to a validated address. It returns normalized public HTTPS stream URLs; `/api/radio/click/:uuid` applies the same destination policy and accepts only station IDs from the current bounded catalog. The browser then connects directly to the broadcaster after an explicit playback action, so the broadcaster sees the listener's IP address. GEV never proxies, caches, records, or redistributes audio.
- **Bounded high-risk paths.** Request bodies and high-volume or attacker-influenced upstream responses are capped where that boundary matters — the CCTV media proxy counts streamed bytes rather than trusting a declared length, and applies idle/duration timeouts so a stalled or held-open upstream connection can't run forever — and network paths use explicit timeouts or other bounded lifecycles appropriate to the feed. A client's `Range` header on the CCTV media proxy is validated (single satisfiable byte range, no multi-range, no absurd offsets) before being forwarded, never passed through raw.
- **Sanitized public failures.** Proxy handlers return controlled error messages instead of credentials or raw internal details.
- **Coalesced OAuth refresh** and cached successful responses only (OpenSky).
- **Redacted debug logging, enforced server-side.** The voice debug log (`.gev-logs/`, gitignored) strips API keys, bearer tokens, client secrets, and image data URLs before writing. The browser redacts first, but `/api/realtime/debug-log` re-applies the same redaction itself and rejects any payload that isn't a recognized event shape — a direct POST bypassing the app can't write arbitrary data. The endpoint is also per-IP rate-limited, and the log file rotates once it reaches 20 MB instead of growing without bound.

## Network exposure — the operator threat model

The dev server is a **key broker**: every server-side key above is spendable by anyone who can send HTTP requests to it. That shapes the defaults:

- **Local-only by default.** `./scripts/dev-fresh.sh` (and the Vite config itself) bind to `localhost`, so only your machine can reach the server — and only local names are accepted (`allowedHosts` stays restricted, which also blunts DNS-rebinding tricks).
- **LAN exposure is an explicit opt-in**: `HOST=0.0.0.0 ./scripts/dev-fresh.sh`. The launcher prints a prominent warning plus your LAN URL. Understand what opting in means: **every device on that network can drive the proxies and spend your OpenAI / Google / OpenSky / AISStream / TomTom / FIRMS quota** for as long as the server runs. Do this only on networks you trust.
- **The Rayhunter proxy (`/api/rayhunter/*`) is a deliberate, narrower exception to "no arbitrary-URL fetching" above**: its whole point is reaching a device address YOU configure (your own Rayhunter hotspot on your local network), not a fixed host. Same LAN-exposure tradeoff applies one level down: if you've opted into `HOST=0.0.0.0`, anyone on that network can direct this proxy at any address your machine can reach, not just your Rayhunter — it still refuses the cloud-metadata address (`169.254.169.254`) outright, but it is not a general SSRF defense.
- **The RTL-SDR tap proxy (`/api/rtlsdr/*`, #57) is the same exception, same tradeoff**: it reaches whatever `host:port` you configure for your own dump1090/readsb receiver, refuses the cloud-metadata address the same way, and is not a general SSRF defense either.
- **The GTFS-Realtime tap proxy (`/api/gtfs-rt/*`, #70) is a full-URL exception, hardened like the CCTV media proxy instead**: unlike the two taps above, there's no single fixed device this reaches — it's BYOS (bring your own transit-agency feed URL), a genuinely arbitrary operator-configured URL. It reuses the CCTV proxy's SSRF hardening (URL-shape check, DNS resolution, and pinning the connection to the resolved address so a later DNS answer can't redirect it) rather than the narrower host:port-only check the personal-device taps use.
- **App-level throttles (default-on):** `GEV_RATELIMIT_OPENAI_PER_MIN` (default 30/min/IP) and `GEV_RATELIMIT_GOOGLE_PER_MIN` (default 60/min/IP, also covers the CCTV frame proxy's Street View fallback) cap the cost-bearing endpoints per client IP per minute (over-limit requests receive a sanitized `429`). They apply out of the box; set either to `0` to explicitly opt out for a trusted local-only setup. They are **per-IP, process-local, in-memory guards** — they reset on restart and are **not billing caps**.
- **Provider-side budgets are the real backstop.** For hard spend protection, configure limits where the money is: OpenAI platform usage limits, Google Cloud budget alerts + per-API quotas, and equivalent controls for any other keyed provider.

## Scope & expectations

- The Vite server is a **development/preview** server. If you expose it beyond localhost, put it behind your own auth/proxy and review the bindings (see the threat model above).
- All data shown is from **public** sources. See [DATA_SOURCES.md](DATA_SOURCES.md). Respect each provider's terms and rate limits.
- The voice agent receives feed-sourced text (place names, callsigns) as scene context. It is instructed to act only via a fixed set of app-control tools and not to execute arbitrary instructions found in data, but treat model output as untrusted and keep the tool surface limited.

## Responsible use

This is an interface for signals that are **already public**. Use it accordingly: respect privacy, follow data providers' terms, and don't represent public-data inference as authoritative intelligence.
