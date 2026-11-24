const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const target = process.env.TARGET_URL;
const outDir = process.env.OUT_DIR || 'fb_capture';
fs.mkdirSync(outDir, { recursive: true });

function safeName(input, fallback) {
  const cleaned = String(input || '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180);
  return cleaned || fallback;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    viewport: { width: 1440, height: 1800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });

  const page = await context.newPage();
  const mediaResponses = [];
  const responseLog = [];
  page.on('response', async (response) => {
    try {
      const headers = await response.allHeaders();
      const ct = (headers['content-type'] || '').toLowerCase();
      const len = Number(headers['content-length'] || 0);
      const rec = { url: response.url(), status: response.status(), contentType: ct, contentLength: len };
      if (ct.includes('image/') || ct.includes('video/') || /\.mp4(?:\?|$)|fbcdn/i.test(response.url())) mediaResponses.push(rec);
      if (/graphql|marketplace|share|photo|video/i.test(response.url())) responseLog.push(rec);
    } catch (_) {}
  });

  const consoleLines = [];
  page.on('console', msg => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => consoleLines.push(`[pageerror] ${err.message}`));

  let gotoError = null;
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90000 });
  } catch (err) {
    gotoError = err.message;
  }
  await page.waitForTimeout(8000);

  const clickLabels = [
    'Allow all cookies', 'Allow essential and optional cookies', 'Only allow essential cookies',
    'Decline optional cookies', 'Not now', 'Close', 'Continue without logging in'
  ];
  for (const label of clickLabels) {
    try {
      const el = page.getByRole('button', { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).first();
      if (await el.isVisible({ timeout: 1200 })) {
        await el.click({ timeout: 3000 });
        await page.waitForTimeout(1200);
      }
    } catch (_) {}
  }

  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 1100);
    await page.waitForTimeout(900);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1200);

  const finalUrl = page.url();
  const title = await page.title().catch(() => '');
  const visibleText = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
  const html = await page.content().catch(() => '');
  const meta = await page.evaluate(() => Array.from(document.querySelectorAll('meta')).map(m => ({
    name: m.getAttribute('name'), property: m.getAttribute('property'), content: m.getAttribute('content')
  })).filter(x => x.content));
  const images = await page.evaluate(() => Array.from(document.images).map((img, i) => ({
    index: i,
    src: img.currentSrc || img.src,
    alt: img.alt || '',
    width: img.naturalWidth || 0,
    height: img.naturalHeight || 0,
    displayedWidth: img.getBoundingClientRect().width,
    displayedHeight: img.getBoundingClientRect().height
  })).filter(x => x.src));
  const videos = await page.evaluate(() => Array.from(document.querySelectorAll('video')).map((v, i) => ({
    index: i, src: v.currentSrc || v.src || '', poster: v.poster || '', duration: Number.isFinite(v.duration) ? v.duration : null
  })));
  const anchors = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map(a => ({ href: a.href, text: (a.innerText || '').trim() })).filter(x => x.href));

  const summary = { target, gotoError, finalUrl, title, meta, images, videos, anchors, mediaResponses, responseLog };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, 'visible_text.txt'), visibleText);
  fs.writeFileSync(path.join(outDir, 'page.html'), html);
  fs.writeFileSync(path.join(outDir, 'browser_console.txt'), consoleLines.join('\n'));
  await page.screenshot({ path: path.join(outDir, 'page_full.png'), fullPage: true }).catch(() => {});
  await page.screenshot({ path: path.join(outDir, 'page_top.png'), fullPage: false }).catch(() => {});

  const candidates = [];
  for (const img of images) {
    if (img.width >= 400 && img.height >= 400) candidates.push({ type: 'image', url: img.src, score: img.width * img.height });
  }
  for (const m of meta) {
    if (/^(og:image|twitter:image)$/i.test(m.property || m.name || '')) candidates.push({ type: 'image', url: m.content, score: 1e12 });
    if (/^(og:video|og:video:url|og:video:secure_url|twitter:player:stream)$/i.test(m.property || m.name || '')) candidates.push({ type: 'video', url: m.content, score: 1e12 });
  }
  for (const v of videos) {
    if (v.src) candidates.push({ type: 'video', url: v.src, score: 1e12 });
    if (v.poster) candidates.push({ type: 'image', url: v.poster, score: 1e11 });
  }
  for (const r of mediaResponses) {
    if (r.contentType.includes('video') || /\.mp4(?:\?|$)/i.test(r.url)) candidates.push({ type: 'video', url: r.url, score: r.contentLength || 0 });
    else if (r.contentType.includes('image')) candidates.push({ type: 'image', url: r.url, score: r.contentLength || 0 });
  }

  const deduped = [];
  const seen = new Set();
  for (const c of candidates.sort((a, b) => b.score - a.score)) {
    if (!c.url || seen.has(c.url)) continue;
    seen.add(c.url);
    deduped.push(c);
  }
  fs.writeFileSync(path.join(outDir, 'media_candidates.json'), JSON.stringify(deduped, null, 2));

  let imgN = 0, vidN = 0;
  for (const c of deduped.slice(0, 80)) {
    try {
      const res = await context.request.get(c.url, { timeout: 45000, failOnStatusCode: false });
      if (!res.ok()) continue;
      const headers = res.headers();
      const ct = (headers['content-type'] || '').toLowerCase();
      const body = await res.body();
      if (body.length < 15000) continue;
      let ext = '';
      if (ct.includes('jpeg')) ext = '.jpg';
      else if (ct.includes('png')) ext = '.png';
      else if (ct.includes('webp')) ext = '.webp';
      else if (ct.includes('gif')) ext = '.gif';
      else if (ct.includes('mp4')) ext = '.mp4';
      else if (c.type === 'video') ext = '.mp4';
      else ext = '.bin';
      const prefix = c.type === 'video' ? `video_${String(++vidN).padStart(2, '0')}` : `image_${String(++imgN).padStart(2, '0')}`;
      fs.writeFileSync(path.join(outDir, prefix + ext), body);
    } catch (_) {}
  }

  try {
    execFileSync('yt-dlp', ['--no-playlist', '--write-info-json', '--write-thumbnail', '-o', path.join(outDir, 'ytdlp_%(title).80B_%(id)s.%(ext)s'), target], { stdio: 'pipe', timeout: 180000 });
  } catch (err) {
    fs.writeFileSync(path.join(outDir, 'ytdlp_error.txt'), String(err.stderr || err.message || err));
  }

  await browser.close();
  console.log(JSON.stringify({ finalUrl, title, images: images.length, videos: videos.length, downloadedImages: imgN, downloadedVideos: vidN }, null, 2));
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
