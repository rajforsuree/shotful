/**
 * ShotAPI — Cloudflare Worker
 *
 * Serves the public site (static assets) and a full-page screenshot API,
 * backed by Cloudflare's managed headless browser (Browser Rendering).
 *
 *   GET /api/screenshot?url=...&fullPage=true&width=1440&format=png&download=true
 *   GET /api/health
 *
 * No Chromium to bundle, no servers to run — Cloudflare provides the browser.
 */

import puppeteer from '@cloudflare/puppeteer';

const NAV_TIMEOUT_MS = 30000;
const MAX_URL_LEN = 2048;

/* ------------------------------------------------------------------ */
/* SSRF guard.                                                         */
/* Workers can't reach private networks anyway, but we still refuse    */
/* obvious internal targets so the API can't be used as a probe.       */
/* ------------------------------------------------------------------ */
const PRIVATE_V4 = /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[0-2]\d)\.)/;

function assertPublicUrl(raw) {
  if (!raw || raw.length > MAX_URL_LEN) throw new Error('Invalid URL');
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http/https URLs are allowed');

  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error('Blocked host');
  }
  // IPv4 literal in a private range
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && PRIVATE_V4.test(host)) {
    throw new Error('Blocked host (private address)');
  }
  // IPv6 literal
  if (host.includes(':') && (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80'))) {
    throw new Error('Blocked host (private address)');
  }
  return u.toString();
}

function parseOpts(src) {
  const bool = (v, d) => (v === undefined || v === '' ? d : v === true || v === 'true' || v === '1');
  const clamp = (n, lo, hi, d) => Math.min(Math.max(parseInt(n, 10) || d, lo), hi);
  return {
    fullPage: bool(src.fullPage, true),
    width: clamp(src.width, 320, 3840, 1440),
    format: src.format === 'jpeg' ? 'jpeg' : 'png',
    download: bool(src.download, false),
  };
}

function base64FromArrayBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });
}

async function screenshot(request, env) {
  // accept url from query (GET) or JSON body (POST)
  const query = Object.fromEntries(new URL(request.url).searchParams);
  let body = {};
  if (request.method === 'POST') {
    try { body = await request.json(); } catch { /* ignore */ }
  }
  const merged = { ...query, ...body };
  if (!merged.url) return json({ error: 'Missing "url"' }, 400);

  const opts = parseOpts(merged);

  let safeUrl;
  try { safeUrl = assertPublicUrl(merged.url); }
  catch (e) { return json({ error: e.message }, 422); }

  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width: opts.width, height: 900 });
    await page.goto(safeUrl, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
    // nudge lazy-loaded content into view
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise((r) => setTimeout(r, 600));
    await page.evaluate(() => window.scrollTo(0, 0));

    const buffer = await page.screenshot({
      fullPage: opts.fullPage,
      type: opts.format,
      quality: opts.format === 'jpeg' ? 85 : undefined,
    });

    if (opts.download) {
      return new Response(buffer, {
        headers: {
          'content-type': `image/${opts.format}`,
          'cache-control': 'public, max-age=300',
          ...CORS,
        },
      });
    }
    return json({
      url: safeUrl,
      format: opts.format,
      width: opts.width,
      fullPage: opts.fullPage,
      bytes: buffer.byteLength,
      base64: base64FromArrayBuffer(buffer),
    });
  } catch (err) {
    const msg = String((err && err.message) || err);
    // Surface the most common operational error clearly.
    if (msg.includes('429') || msg.toLowerCase().includes('limit')) {
      return json({ error: 'Browser time limit reached for now — try again shortly.', detail: msg }, 429);
    }
    return json({ error: 'Capture failed', detail: msg }, 502);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (pathname === '/api/health') {
      return json({ ok: true, service: 'shotapi' });
    }
    if (pathname === '/api/screenshot') {
      return screenshot(request, env);
    }

    // Everything else: serve the static site.
    return env.ASSETS.fetch(request);
  },
};
