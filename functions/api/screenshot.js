/**
 * GET /api/screenshot?url=…&fullPage=true&width=1440&format=png&download=true
 *
 * Cloudflare Pages Function. Takes a full-page screenshot using Cloudflare's
 * managed headless browser (Browser Rendering), bound as env.BROWSER.
 */

import puppeteer from '@cloudflare/puppeteer';

const NAV_TIMEOUT_MS = 30000;
const MAX_URL_LEN = 2048;

/* ---- SSRF guard ---------------------------------------------------- */
/* Pages Functions can't reach private networks anyway, but we still     */
/* refuse obvious internal targets so the endpoint can't be a probe.    */
const PRIVATE_V4 = /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[0-2])\d?\.)/;

function assertPublicUrl(raw) {
  if (!raw || raw.length > MAX_URL_LEN) throw new Error('Invalid URL');
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http/https URLs are allowed');

  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) throw new Error('Blocked host');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && PRIVATE_V4.test(host)) throw new Error('Blocked host (private address)');
  if (host.includes(':') && (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80'))) {
    throw new Error('Blocked host (private address)');
  }
  return u.toString();
}

/* ---- helpers ------------------------------------------------------- */
const clamp = (n, lo, hi, d) => Math.min(Math.max(parseInt(n, 10) || d, lo), hi);
const bool = (v, d) => (v === undefined || v === '' ? d : v === true || v === 'true' || v === '1');

function base64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });

/* ---- the work ------------------------------------------------------ */
async function handle({ request, env }) {
  const query = Object.fromEntries(new URL(request.url).searchParams);
  let body = {};
  if (request.method === 'POST') { try { body = await request.json(); } catch { /* ignore */ } }
  const src = { ...query, ...body };

  if (!src.url) return json({ error: 'Missing "url"' }, 400);

  const fullPage = bool(src.fullPage, true);
  const width = clamp(src.width, 320, 3840, 1440);
  const format = src.format === 'jpeg' ? 'jpeg' : 'png';
  const download = bool(src.download, false);

  let safeUrl;
  try { safeUrl = assertPublicUrl(src.url); }
  catch (e) { return json({ error: e.message }, 422); }

  if (!env.BROWSER) return json({ error: 'Browser binding not configured' }, 500);

  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width, height: 900 });
    await page.goto(safeUrl, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
    // pull lazy-loaded content into view, then return to the top
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise((r) => setTimeout(r, 600));
    await page.evaluate(() => window.scrollTo(0, 0));

    const buffer = await page.screenshot({
      fullPage,
      type: format,
      quality: format === 'jpeg' ? 85 : undefined,
    });

    if (download) {
      return new Response(buffer, {
        headers: { 'content-type': `image/${format}`, 'cache-control': 'public, max-age=300', ...CORS },
      });
    }
    return json({ url: safeUrl, format, width, fullPage, bytes: buffer.byteLength, base64: base64(buffer) });
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (msg.includes('429') || msg.toLowerCase().includes('limit')) {
      return json({ error: 'Browser time limit reached for now — try again shortly.', detail: msg }, 429);
    }
    return json({ error: 'Capture failed', detail: msg }, 502);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export const onRequestGet = handle;
export const onRequestPost = handle;
export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });
