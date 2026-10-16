/**
 * ShotAPI — Vercel serverless function (alternative to the Cloudflare Worker).
 *
 * Vercel has no managed browser, so we bundle a slim Chromium build
 * (@sparticuz/chromium) and drive it with puppeteer-core. This fits inside
 * Vercel's 250MB function limit — do NOT use the full `puppeteer` package.
 *
 *   GET /api/screenshot?url=...&fullPage=true&width=1440&format=png&download=true
 */

const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const dns = require('dns').promises;
const net = require('net');

const NAV_TIMEOUT_MS = 25000;

const PRIVATE_V4 = /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[0-2])\d?\.)/;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return PRIVATE_V4.test(ip);
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
  }
  return true;
}

async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http/https URLs are allowed');
  const host = u.hostname;
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Blocked host');
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length) throw new Error('Could not resolve host');
  for (const { address } of addrs) if (isPrivateIp(address)) throw new Error('Blocked host (private address)');
  return u.toString();
}

const clamp = (n, lo, hi, d) => Math.min(Math.max(parseInt(n, 10) || d, lo), hi);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const src = { ...(req.query || {}), ...(req.body || {}) };
  if (!src.url) return res.status(400).json({ error: 'Missing "url"' });

  const fullPage = src.fullPage === undefined ? true : ['true', '1', true].includes(src.fullPage);
  const width = clamp(src.width, 320, 3840, 1440);
  const format = src.format === 'jpeg' ? 'jpeg' : 'png';
  const download = ['true', '1', true].includes(src.download);

  let browser;
  try {
    const safeUrl = await assertPublicUrl(src.url);

    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    const page = await browser.newPage();
    await page.setViewport({ width, height: 900 });
    await page.goto(safeUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise((r) => setTimeout(r, 600));
    await page.evaluate(() => window.scrollTo(0, 0));

    const buffer = await page.screenshot({
      fullPage,
      type: format,
      quality: format === 'jpeg' ? 85 : undefined,
    });

    if (download) {
      res.setHeader('Content-Type', `image/${format}`);
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.send(buffer);
    }
    return res.json({
      url: safeUrl,
      format,
      width,
      fullPage,
      bytes: buffer.length,
      base64: buffer.toString('base64'),
    });
  } catch (err) {
    const status = /Blocked|Invalid|http/.test(String(err.message)) ? 422 : 502;
    return res.status(status).json({ error: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
};
