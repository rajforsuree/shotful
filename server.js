/**
 * Website Screenshot API
 * POST /screenshot  { url, fullPage, width, format, blockAds }
 * GET  /screenshot?url=...&fullPage=true&format=png   -> returns the image directly
 *
 * Stack: Express + puppeteer-core (system Chromium) + jimp (stitching long pages)
 */

const express = require('express');
const puppeteer = require('puppeteer-core');
const dns = require('dns').promises;
const net = require('net');
const path = require('path');
const Jimp = require('jimp');

const PORT = process.env.PORT || 3000;
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium';
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 3);
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 30000);
// Chromium can't render a single texture taller than ~16384px; above this we tile+stitch.
const MAX_SINGLE_CANVAS = 16000;
const TILE_HEIGHT = 2000;

const app = express();
app.use(express.json({ limit: '16kb' }));
// Serve the little demo UI (public/index.html) at the root.
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/* Concurrency queue: a browser context is heavy, so cap how many run */
/* at once. Extra requests wait their turn instead of crashing the box. */
/* ------------------------------------------------------------------ */
let running = 0;
const waiters = [];
function acquire() {
  return new Promise((resolve) => {
    if (running < MAX_CONCURRENCY) { running++; resolve(); }
    else waiters.push(resolve);
  });
}
function release() {
  running--;
  const next = waiters.shift();
  if (next) { running++; next(); }
}

/* ------------------------------------------------------------------ */
/* SSRF protection: only allow public http(s) hosts.                  */
/* Blocks localhost, private ranges, link-local, metadata endpoints.  */
/* ------------------------------------------------------------------ */
const BLOCKED_V4 = [
  [/^0\./, 'this-network'],
  [/^10\./, 'private'],
  [/^127\./, 'loopback'],
  [/^169\.254\./, 'link-local / cloud metadata'],
  [/^172\.(1[6-9]|2\d|3[01])\./, 'private'],
  [/^192\.168\./, 'private'],
  [/^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./, 'carrier-grade NAT'],
];
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return BLOCKED_V4.some(([re]) => re.test(ip));
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    return low === '::1' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80');
  }
  return true; // unknown -> treat as unsafe
}
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }
  const host = u.hostname;
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Blocked host');
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length) throw new Error('Could not resolve host');
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new Error('Blocked host (private address)');
  }
  return u.toString();
}

/* ------------------------------------------------------------------ */
/* Browser lifecycle                                                   */
/* ------------------------------------------------------------------ */
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        '--disable-gpu',
        // If your host needs an egress proxy, pass it via PROXY_SERVER env:
        ...(process.env.PROXY_SERVER ? [`--proxy-server=${process.env.PROXY_SERVER}`] : []),
      ],
    });
  }
  return browserPromise;
}

/* Scroll the whole page so lazy-loaded images/content actually appear. */
async function autoScroll(page, maxHeight) {
  await page.evaluate(async (cap) => {
    await new Promise((resolve) => {
      let y = 0;
      const step = () => {
        y += 1000;
        window.scrollTo(0, y);
        if (y < document.body.scrollHeight && y < cap) setTimeout(step, 120);
        else resolve();
      };
      step();
    });
    window.scrollTo(0, 0);
  }, maxHeight);
}

/* Hide sticky/fixed headers so they don't repeat on every stitched tile. */
async function hideFixedElements(page) {
  await page.evaluate(() => {
    document.querySelectorAll('*').forEach((el) => {
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') el.style.visibility = 'hidden';
    });
  });
}

async function capture(url, opts) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: opts.width, height: opts.viewportHeight, deviceScaleFactor: opts.scale });
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    );
    if (opts.blockAds) {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const t = req.resourceType();
        if (t === 'media' || t === 'font') return req.abort();
        req.continue();
      });
    }

    await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
    await autoScroll(page, MAX_SINGLE_CANVAS + opts.viewportHeight);

    const pageHeight = await page.evaluate(() =>
      Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
    );

    // Case 1: normal page (or viewport-only shot) -> single screenshot.
    if (!opts.fullPage || pageHeight <= MAX_SINGLE_CANVAS) {
      const buf = await page.screenshot({
        type: opts.format,
        fullPage: opts.fullPage,
        quality: opts.format === 'jpeg' ? opts.quality : undefined,
      });
      return { buffer: buf, height: opts.fullPage ? pageHeight : opts.viewportHeight, stitched: false };
    }

    // Case 2: very long page -> capture in tiles and stitch vertically.
    await hideFixedElements(page);
    const tiles = [];
    for (let y = 0; y < pageHeight; y += TILE_HEIGHT) {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await new Promise((r) => setTimeout(r, 250));
      const buf = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: opts.width, height: Math.min(TILE_HEIGHT, pageHeight - y) },
      });
      tiles.push(buf);
    }
    const stitched = await stitch(tiles, opts.width);
    const finalBuf = opts.format === 'jpeg'
      ? await stitched.quality(opts.quality).getBufferAsync(Jimp.MIME_JPEG)
      : await stitched.getBufferAsync(Jimp.MIME_PNG);
    return { buffer: finalBuf, height: pageHeight, stitched: true };
  } finally {
    await page.close().catch(() => {});
  }
}

async function stitch(tileBuffers, width) {
  const images = await Promise.all(tileBuffers.map((b) => Jimp.read(b)));
  const totalH = images.reduce((s, im) => s + im.bitmap.height, 0);
  const out = new Jimp(width, totalH);
  let y = 0;
  for (const im of images) {
    out.composite(im, 0, y);
    y += im.bitmap.height;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */
function parseOpts(src) {
  const b = (v, d) => (v === undefined ? d : v === true || v === 'true' || v === '1');
  return {
    fullPage: b(src.fullPage, true),
    width: Math.min(Math.max(parseInt(src.width) || 1440, 320), 3840),
    viewportHeight: Math.min(Math.max(parseInt(src.viewportHeight) || 900, 200), 2160),
    scale: Math.min(Math.max(parseFloat(src.scale) || 1, 1), 2),
    format: src.format === 'jpeg' ? 'jpeg' : 'png',
    quality: Math.min(Math.max(parseInt(src.quality) || 85, 1), 100),
    blockAds: b(src.blockAds, false),
  };
}

app.get('/health', (_req, res) => res.json({ ok: true, running, queued: waiters.length }));

async function handle(req, res) {
  const rawUrl = req.body.url || req.query.url;
  if (!rawUrl) return res.status(400).json({ error: 'Missing "url"' });
  const opts = parseOpts({ ...req.query, ...req.body });

  await acquire();
  try {
    const safeUrl = await assertPublicUrl(rawUrl);
    const { buffer, height, stitched } = await capture(safeUrl, opts);

    if (req.query.download === 'true' || req.body.download) {
      res.set('Content-Type', `image/${opts.format}`);
      res.set('Content-Disposition', `inline; filename="screenshot.${opts.format}"`);
      return res.send(buffer);
    }
    res.json({
      url: safeUrl,
      format: opts.format,
      width: opts.width,
      height,
      stitched,
      bytes: buffer.length,
      // For a real service, upload `buffer` to S3/R2 and return a signed URL here.
      base64: buffer.toString('base64'),
    });
  } catch (err) {
    res.status(422).json({ error: String(err.message || err) });
  } finally {
    release();
  }
}

app.post('/screenshot', handle);
app.get('/screenshot', handle);

if (require.main === module) {
  app.listen(PORT, () => console.log(`Screenshot API on :${PORT} (concurrency=${MAX_CONCURRENCY})`));
}

module.exports = { app, capture, parseOpts, assertPublicUrl };
