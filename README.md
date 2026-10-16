# Shotful

**Screenshot any website — full page, one call.**

A Cloudflare Pages site with a single API endpoint, `/api/screenshot`, backed by
Cloudflare's managed headless browser (Browser Rendering). Paste a URL in the
browser, or call the endpoint from your own code.

![Shotful](docs/preview.png)

## Structure

```
public/
  index.html              the site  →  served at /
  _routes.json            only /api/* invokes a Function
functions/
  api/screenshot.js       GET /api/screenshot
  api/health.js           GET /api/health
wrangler.toml             Pages config + browser binding
```

## Deploy

### A. Connect the repo (dashboard)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Pick this repository.
3. **Build command:** leave empty.
4. **Build output directory:** `public`.
5. **Save and Deploy.**

Then attach the browser: **Settings → Functions → Bindings → Add → Browser Rendering**,
and name the binding **`BROWSER`**.

Your site is live at `https://<project>.pages.dev`.

### B. Wrangler CLI

```bash
npm install
npx wrangler pages project create shotful     # first time only
npx wrangler pages deploy
```

## The browser binding — please read

`functions/api/screenshot.js` needs `env.BROWSER`, which comes from the
`[browser]` binding in `wrangler.toml`:

```toml
[browser]
binding = "BROWSER"
```

Two things worth knowing:

- **Browser Rendering is a Workers feature.** It works from Pages Functions, but
  it is not the documented, first-class path — if a Git-connected build does not
  pick up the binding from `wrangler.toml`, add it by hand in the dashboard
  (Settings → Functions → Bindings → Browser Rendering → name it `BROWSER`).
- **There is no local browser mode.** `wrangler pages dev` will run the site, but
  screenshots only work once deployed (or on a preview deployment). This is a
  Cloudflare limitation, not a bug here.

If Pages ever refuses the binding, the same `functions/` code runs unchanged on a
Worker — but then the domain is `workers.dev`, not `pages.dev`.

## API

```
GET /api/screenshot?url=https://example.com&download=true
```

| param      | default | notes                              |
|------------|---------|------------------------------------|
| `url`      | —       | required, `http(s)` only           |
| `fullPage` | `true`  | `false` = viewport only            |
| `width`    | `1440`  | 320–3840                           |
| `format`   | `png`   | `png` or `jpeg`                    |
| `download` | `false` | `true` = raw image, `false` = JSON |

```bash
# save a screenshot to a file
curl "https://<project>.pages.dev/api/screenshot?url=https://example.com&download=true" -o shot.png
```

Returns JSON (with a base64 image) by default, or the raw image when
`download=true`. `POST` with a JSON body works too.

## Notes

- **Limits:** the free plan allows 10 browser-minutes per day (3 concurrent, 60s
  per session). Paid ($5/mo) gives 10 browser-hours/month.
- **SSRF:** loopback, private and metadata hosts are refused.
- **CORS** is open (`*`). Tighten `Access-Control-Allow-Origin` in
  `functions/api/screenshot.js` for production.
- **Public traffic:** add Cloudflare's Rate Limiting or a Turnstile check in front
  of `/api/screenshot`.

## License

[MIT](LICENSE) © Rajesh Paswan
