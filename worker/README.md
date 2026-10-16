# ShotAPI on Cloudflare Workers

The recommended deployment. One Worker serves the public site **and** the API, and
uses Cloudflare's managed headless browser (Browser Rendering) — so there is no
Chromium binary to bundle and no server to keep alive.

```
web/index.html   →  served as static assets at /
worker/worker.js →  handles /api/screenshot and /api/health
```

## Deploy in 4 steps

```bash
cd worker
npm install

# log in to Cloudflare (opens a browser)
npx wrangler login

# local dev at http://localhost:8787
npm run dev

# ship it
npm run deploy
```

Wrangler prints your live URL, e.g. `https://shotapi.<you>.workers.dev`. Open it —
the site is live, and `https://shotapi.<you>.workers.dev/api/screenshot?url=https://example.com&download=true`
returns a full-page screenshot.

## Requirements & limits

Browser Rendering needs to be enabled on your account — it works on the **Free** plan,
with these ceilings:

| | Workers Free | Workers Paid ($5/mo) |
|---|---|---|
| Browser time | 10 minutes / day | 10 hours / month, then $0.09/hr |
| Concurrent browsers | 3 | 10+ (higher on request) |
| Browser timeout | 60s per session | 60s per session |
| REST screenshot requests | ~6 / minute | ~10 / second |

A typical screenshot uses a few seconds of browser time, so the free tier is fine for
a personal project or demo. For real traffic, the $5/mo Workers Paid plan is the
sensible step. See the official limits and pricing pages for the current numbers.

## Configuration

Everything lives in `wrangler.toml`:

- `[browser] binding = "BROWSER"` — the managed browser.
- `[assets] directory = "../web"` — the static site, served at the edge.

## Notes

- **CORS** is wide open (`*`) so the API can be called from any frontend. Tighten
  `Access-Control-Allow-Origin` in `worker.js` before going to production.
- **SSRF**: Workers can't reach private networks, and `worker.js` additionally refuses
  loopback / private / metadata hosts.
- **Rate limiting**: for public traffic, add Cloudflare's Rate Limiting binding or a
  Turnstile check in front of `/api/screenshot`.
