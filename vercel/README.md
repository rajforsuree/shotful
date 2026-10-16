# ShotAPI on Vercel

An alternative to the Cloudflare deployment, for when you want everything on Vercel.

Vercel has no managed browser, so this bundles a slim Chromium build
(`@sparticuz/chromium`) and drives it with `puppeteer-core`. Do **not** swap in the
full `puppeteer` package — it blows past Vercel's 250MB function limit.

```
public/index.html    →  static site at /
api/screenshot.js    →  serverless function at /api/screenshot
```

## Deploy

```bash
cd vercel
npm install
npx vercel          # first run links the project
npx vercel --prod   # production
```

Or push the repo to GitHub and import it in the Vercel dashboard with **Root
Directory = `vercel`**.

## Heads-up

- **Cold starts.** Each cold invocation spins up Chromium (~1–3s on top of the
  capture). Fluid compute (on by default) keeps instances warm under load.
- **Timeout.** `vercel.json` sets `maxDuration: 60`. Hobby allows up to 300s; very
  long pages may need more.
- **Bundle size.** Keep an eye on the function size — Chromium is the bulk of it.
  If you hit the limit, switch to `@sparticuz/chromium-min` and host the browser pack
  yourself, or move to a container host (Railway / Render / Fly) with the root
  `Dockerfile`.
- **Version pin.** `@sparticuz/chromium` tracks Chromium builds; bump it with
  `npm i @sparticuz/chromium@latest` when you update `puppeteer-core`.

For the trade-offs against Cloudflare, see the comparison in the root `README.md`.
