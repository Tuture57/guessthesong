/**
 * Focused diagnosis of the three checks the production smoke test failed on
 * against the live Render deployment. Measures rather than assumes.
 *
 *   node tools/diag-render.mjs https://guessthesong-7c6q.onrender.com
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] ?? 'https://guessthesong-7c6q.onrender.com').replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Times the singleplayer first-play path: fetch, decode, scheduled. */
const AUDIO_TIMELINE = () => {
  window.__audio = { scheduled: 0, marks: [] };
  const mark = (name, extra = {}) => window.__audio.marks.push({ name, at: Math.round(performance.now()), ...extra });

  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (Ctor) {
    const originalDecode = Ctor.prototype.decodeAudioData;
    Ctor.prototype.decodeAudioData = function (...args) {
      const started = performance.now();
      mark('decode:start');
      const promise = originalDecode.apply(this, args);
      promise.then(() => mark('decode:end', { ms: Math.round(performance.now() - started) })).catch(() => {});
      return promise;
    };
  }

  const proto = window.AudioBufferSourceNode && window.AudioBufferSourceNode.prototype;
  if (proto) {
    const originalStart = proto.start;
    proto.start = function (...args) {
      window.__audio.scheduled += 1;
      mark('source:start');
      return originalStart.apply(this, args);
    };
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const url = String(args[0]);
    if (!/\/api\/audio\//.test(url)) return originalFetch.apply(this, args);
    const started = performance.now();
    mark('fetch:start', { url: url.replace(/^https?:\/\/[^/]+/, '') });
    return originalFetch.apply(this, args).then((response) => {
      mark('fetch:headers', { ms: Math.round(performance.now() - started) });
      return response;
    });
  };

  // The response body size, so the transfer duration can be separated from decode.
  const originalArrayBuffer = Response.prototype.arrayBuffer;
  Response.prototype.arrayBuffer = function (...args) {
    const started = performance.now();
    return originalArrayBuffer.apply(this, args).then((buf) => {
      if (window.__audio.marks.some((m) => m.name === 'fetch:start')) {
        mark('fetch:body', { ms: Math.round(performance.now() - started), bytes: buf.byteLength });
      }
      return buf;
    });
  };
};

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });

/* ── 1. Singleplayer: how long does the first excerpt actually take? ──── */
console.log('\n1. Singleplayer first play\n');
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.addInitScript(AUDIO_TIMELINE);
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.home-title', { timeout: 60000 });

const clickAt = Date.now();
await page.click('.home-start');
await page.waitForSelector('.round');
await sleep(400);
await page.click('.play');

// Poll instead of assuming a fixed wait.
let waited = null;
for (let i = 0; i < 60; i += 1) {
  await sleep(250);
  const n = await page.evaluate(() => window.__audio.scheduled);
  if (n > 0) {
    waited = Date.now() - clickAt;
    break;
  }
}
const timeline = await page.evaluate(() => window.__audio.marks);
console.log(`   scheduled: ${waited === null ? 'NEVER (60 x 250ms = 15s)' : `yes, after ~${(waited / 1000).toFixed(1)}s from the PLAY click`}`);
for (const m of timeline) console.log(`     ${m.name}${m.ms !== undefined ? ` +${m.ms}ms` : ''}${m.bytes ? ` (${(m.bytes / 1048576).toFixed(1)} MB)` : ''}`);
if (waited === null) console.log('   => the audio never started: this is a real defect, not a slow network');

const spinner = await page.locator('.play.is-loading').count();
console.log(`   play button showed its loading state at the end: ${spinner > 0}`);

/* ── 2. Disconnect visibility ─────────────────────────────────────────── */
console.log('\n2. Disconnect visibility\n');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.home-title');
await page.click('.mode-card[data-mode="multi"]');
await page.waitForSelector('.mp-menu');
await page.fill('.mp-name', 'Anchor');
await page.click('.mp-create');
await page.waitForSelector('.mp-lobby', { timeout: 30000 });
const code = (await page.textContent('.mp-code-value')).trim();

const guestCtx = await browser.newContext();
const guest = await guestCtx.newPage();
await guest.goto(BASE, { waitUntil: 'domcontentloaded' });
await guest.waitForSelector('.home-title');
await guest.click('.mode-card[data-mode="multi"]');
await guest.waitForSelector('.mp-menu');
await guest.fill('.mp-name', 'Leaver');
await guest.fill('.mp-code-input', code);
await guest.click('.mp-join');
await guest.waitForSelector('.mp-lobby', { timeout: 30000 });
console.log(`   room ${code}: two players joined`);

await page.click('.mp-start');
await page.waitForSelector('.mp-game', { timeout: 30000 });
await guest.waitForSelector('.mp-game', { timeout: 30000 });
console.log('   round started for both');

const closedAt = Date.now();
await guestCtx.close();

let goneAfter = null;
for (let i = 0; i < 60; i += 1) {
  await sleep(500);
  const text = (await page.locator('.mp-status').innerText().catch(() => '')) ?? '';
  if (/déconnecté/i.test(text)) {
    goneAfter = Date.now() - closedAt;
    break;
  }
}
console.log(`   the remaining player was told "Déconnecté" after: ${goneAfter === null ? 'NEVER (30s)' : `${(goneAfter / 1000).toFixed(1)}s`}`);
const statusText = await page.locator('.mp-status').innerText().catch(() => '(none)');
console.log(`   status strip now reads: ${JSON.stringify(statusText.replace(/\n/g, ' | '))}`);

await browser.close();
