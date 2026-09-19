/**
 * Visual inspection helper: walks the app through its screens (singleplayer
 * and a two-player room) and writes screenshots to .shots/ for review.
 *
 *   node server/index.js --prod
 *   node tools/shots.mjs
 */
import { chromium, devices } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.GTS_URL ?? 'http://localhost:8787';
const OUT = path.resolve('.shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const library = await (await fetch(`${BASE}/api/library`)).json();
const titles = library.tracks.map((t) => t.title);

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`  · ${name}.png`);
}

/* ── Singleplayer ─────────────────────────────────────────────────── */

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.home-title', { timeout: 15000 });
await page.waitForFunction(() => !document.querySelector('.chip')?.textContent?.includes('Chargement'));
await sleep(300);
await shot(page, '01-home');

await page.setViewportSize({ width: 390, height: 844 });
await sleep(200);
await shot(page, '02-home-mobile');
await page.setViewportSize({ width: 1440, height: 900 });

await page.click('.home-start');
await page.waitForSelector('.round');
await sleep(600);
await shot(page, '03-round');

await page.fill('.field-input', 'un mauvais titre');
await page.keyboard.press('Enter');
await page.fill('.field-input', 'encore un mauvais titre');
await page.keyboard.press('Enter');
await sleep(250);
await shot(page, '04-round-wrong');

for (let i = 0; i < 2; i += 1) {
  await page.click('.skip');
  await sleep(120);
}
await shot(page, '05-round-reveal-more');

await page.click('.play');
await sleep(250);
await shot(page, '06-round-playing');
await sleep(1600);

for (let i = 0; i < 4; i += 1) {
  await page.click('.skip');
  await sleep(90);
}
await page.waitForSelector('.reveal');
await sleep(900);
await shot(page, '07-reveal');

await page.click('.reveal-next');
await sleep(500);
await shot(page, '08-round-second');

await page.setViewportSize({ width: 390, height: 844 });
await sleep(300);
await shot(page, '09-round-mobile');
await page.close();

/* ── Multiplayer ──────────────────────────────────────────────────── */

const host = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await host.goto(BASE, { waitUntil: 'domcontentloaded' });
await host.waitForSelector('.home-title');
await sleep(400);
await host.click('.mode-card[data-mode="multi"]');
await host.waitForSelector('.mp-menu');
await host.fill('.mp-name', 'Arthur');
await sleep(200);
await shot(host, '10-mp-menu');

await host.click('.mp-create');
await host.waitForSelector('.mp-lobby');
await sleep(400);
const code = (await host.textContent('.mp-code-value'))?.trim();
console.log(`  room code: ${code}`);
await shot(host, '11-mp-lobby-host');

const guest = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await guest.goto(BASE, { waitUntil: 'domcontentloaded' });
await guest.waitForSelector('.home-title');
await guest.click('.mode-card[data-mode="multi"]');
await guest.waitForSelector('.mp-menu');
await guest.fill('.mp-name', 'Bob');
await guest.fill('.mp-code-input', code);
await guest.click('.mp-join');
await guest.waitForSelector('.mp-lobby');
await sleep(400);
await shot(host, '12-mp-lobby-two');
await shot(guest, '13-mp-lobby-guest');

await host.click('.mp-start');
await host.waitForSelector('.mp-game');
await guest.waitForSelector('.mp-game');
await sleep(1200);
await shot(host, '14-mp-round');
await shot(guest, '15-mp-round-guest');

// Guest reveals more; host does not — the levels must stay independent.
await guest.click('.mp-reveal');
await guest.click('.mp-reveal');
await sleep(300);
await shot(guest, '16-mp-round-guest-revealed');

// Identify the round's track from outside the clients, then answer it.
async function identify(code) {
  const audio = await (await fetch(`${BASE}/api/multi/audio/${code}`)).arrayBuffer();
  for (const track of library.tracks) {
    const head = await fetch(`${BASE}/api/audio/${track.id}`, { method: 'HEAD' });
    if (Number(head.headers.get('content-length')) === audio.byteLength) return track;
  }
  return null;
}

const roundTrack = await identify(code);
await host.fill('.field-input', roundTrack.title);
await host.keyboard.press('Enter');
await host.waitForSelector('.field.is-correct', { timeout: 8000 });
await sleep(400);
await shot(host, '17-mp-host-finished');
await shot(guest, '18-mp-guest-sees-status');

// Guest gives up so the round can resolve for everyone.
await guest.click('.mp-giveup');
await host.waitForSelector('.reveal.mp-results, .reveal.is-results', { timeout: 15000 });
await sleep(1200);
await shot(host, '19-mp-round-results');
await shot(guest, '20-mp-round-results-guest');

await host.click('.mp-ready');
await guest.click('.mp-ready');
await sleep(3000);
await shot(host, '21-mp-round-two');
await guest.close();
await host.close();

/* ── Multiplayer results ──────────────────────────────────────────── */

const quick = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await quick.goto(BASE, { waitUntil: 'domcontentloaded' });
await quick.waitForSelector('.home-title');
await quick.click('.mode-card[data-mode="multi"]');
await quick.fill('.mp-name', 'Solo');
await quick.selectOption('.mp-rounds', '5');
await quick.click('.mp-create');
await quick.waitForSelector('.mp-lobby');
await quick.click('.mp-start');
await quick.waitForSelector('.mp-game');
await sleep(600);
await shot(quick, '22-mp-solo-round');
await quick.close();

/* ── V4: configurable room, attempt rows ──────────────────────────── */

const v4 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await v4.goto(BASE, { waitUntil: 'domcontentloaded' });
await v4.waitForSelector('.home-title');
await v4.click('.mode-card[data-mode="multi"]');
await v4.waitForSelector('.mp-menu');
await v4.fill('.mp-name', 'Arthur');
await v4.selectOption('.mp-rounds', '10');
await v4.selectOption('.mp-attempt-mode', 'perReveal');
await v4.selectOption('.mp-round-time', '45');
await v4.click('.mp-create');
await v4.waitForSelector('.mp-lobby');
await sleep(400);
await shot(v4, '23-mp-lobby-settings');

await v4.setViewportSize({ width: 390, height: 844 });
await sleep(300);
await shot(v4, '24-mp-lobby-mobile');
await v4.setViewportSize({ width: 1440, height: 900 });

await v4.click('.mp-start');
await v4.waitForSelector('.mp-game');
await v4.waitForFunction(() => !document.querySelector('.play')?.disabled, null, { timeout: 20000 }).catch(() => {});
await sleep(300);
await shot(v4, '25-mp-round-perreveal');

// Wrong guess, auto-reveal, then a skip: three different row states.
await v4.fill('.field-input', 'tell me - Kanii');
await v4.keyboard.press('Enter');
await v4.waitForSelector('.mp-attempt-rows .row.is-wrong', { timeout: 8000 });
await sleep(350);
await shot(v4, '26-mp-row-wrong');

await v4.fill('.field-input', 'Good Feeling - Flo Rida');
await v4.keyboard.press('Enter');
await sleep(500);
await v4.click('.mp-reveal');
await sleep(400);
await shot(v4, '27-mp-rows-mixed');

await v4.setViewportSize({ width: 390, height: 844 });
await sleep(300);
await shot(v4, '28-mp-round-mobile');
await v4.close();

await browser.close();
console.log(`\nScreenshots in ${OUT}\n`);
