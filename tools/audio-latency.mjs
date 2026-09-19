/**
 * Audio latency measurement for multiplayer rounds.
 *
 * Answers one question with numbers instead of impressions: when the player
 * presses PLAY for a song they have not heard yet this round, where does the
 * time go — request, decode, AudioContext resume, or scheduling?
 *
 *   node tools/audio-latency.mjs [url]
 *
 * Runs against a server that already serves the built client (dev or prod).
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? process.env.GTS_URL ?? 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Page-side probe: timestamps every step of the playback path. */
const PROBE = () => {
  window.__lat = { marks: [] };
  const mark = (name, data) => window.__lat.marks.push({ name, at: performance.now(), ...data });

  // --- decodeAudioData -----------------------------------------------------
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (Ctor) {
    const original = Ctor.prototype.decodeAudioData;
    let decodeId = 0;
    Ctor.prototype.decodeAudioData = function (...args) {
      const id = (decodeId += 1);
      const startedAt = performance.now();
      mark('decode:start', { id });
      const promise = original.apply(this, args);
      promise
        .then(() => mark('decode:end', { id, ms: performance.now() - startedAt }))
        .catch(() => mark('decode:failed', { id, ms: performance.now() - startedAt }));
      return promise;
    };

    // --- AudioContext resume ----------------------------------------------
    const originalResume = Ctor.prototype.resume;
    Ctor.prototype.resume = function (...args) {
      const startedAt = performance.now();
      mark('ctx:resume:start', { state: this.state });
      const promise = originalResume.apply(this, args);
      promise.then(() => mark('ctx:resume:end', { ms: performance.now() - startedAt })).catch(() => {});
      return promise;
    };
  }

  // --- source scheduling ---------------------------------------------------
  const proto = window.AudioBufferSourceNode && window.AudioBufferSourceNode.prototype;
  if (proto) {
    const originalStart = proto.start;
    proto.start = function (...args) {
      try {
        const when = typeof args[0] === 'number' ? args[0] : 0;
        const ctx = this.context;
        mark('source:start', {
          leadSeconds: ctx ? Number((when - ctx.currentTime).toFixed(3)) : null,
          ctxState: ctx ? ctx.state : null,
        });
      } catch {
        /* measurement must never break playback */
      }
      return originalStart.apply(this, args);
    };
  }

  // --- play button press ---------------------------------------------------
  document.addEventListener(
    'click',
    (event) => {
      if (event.target instanceof Element && event.target.closest('.play')) mark('play:click');
    },
    true,
  );
};

/** Collect the resource-timing entries for the room audio stream. */
async function audioResource(page) {
  return page.evaluate(() => {
    const entry = performance
      .getEntriesByType('resource')
      .filter((item) => item.name.includes('/api/multi/audio'))
      .pop();
    if (!entry) return null;
    return {
      start: entry.startTime,
      responseStart: entry.responseStart,
      responseEnd: entry.responseEnd,
      encodedBytes: entry.encodedBodySize,
      transferBytes: entry.transferSize,
      ttfb: entry.responseStart - entry.startTime,
      download: entry.responseEnd - entry.responseStart,
    };
  });
}

/** Pull the marks collected since the last reset, relative to `origin`. */
async function marksSince(page, origin) {
  const marks = await page.evaluate(() => window.__lat.marks.splice(0, window.__lat.marks.length));
  return marks.map((m) => ({ ...m, rel: origin === null ? m.at : m.at - origin }));
}

const fmt = (value) => (value === null || value === undefined ? '—' : `${value.toFixed(0)}`);

async function measureRound(page, label, results) {
  /* How long the round spends preparing before PLAY is even offered. */
  const preloadStart = Date.now();
  let preloadMs = null;
  try {
    await page.waitForFunction(() => {
      const button = document.querySelector('.play');
      return button && !button.disabled;
    }, null, { timeout: 20000 });
    preloadMs = Date.now() - preloadStart;
  } catch {
    preloadMs = null;
  }

  /* First play of this round (the one the player waits on). */
  await page.evaluate(() => window.__lat.marks.splice(0, window.__lat.marks.length));
  await page.click('.play');
  await page.waitForFunction(() => document.querySelector('.play')?.classList.contains('is-playing'), null, { timeout: 8000 });
  await sleep(250);
  const marks = await marksSince(page, null);

  const click = marks.find((m) => m.name === 'play:click')?.at ?? null;
  const decodeEnd = marks.find((m) => m.name === 'decode:end');
  const decodeStart = marks.find((m) => m.name === 'decode:start');
  const sourceStart = marks.find((m) => m.name === 'source:start');
  const resumes = marks.filter((m) => m.name.startsWith('ctx:resume'));
  const resource = await audioResource(page);

  results.push({
    label,
    preloadMs,
    clickToStart: click && sourceStart ? sourceStart.at - click : null,
    clickToDecodeEnd: click && decodeEnd ? decodeEnd.at - click : null,
    decodeMs: decodeStart && decodeEnd ? decodeEnd.ms : null,
    decodeStartedBeforeClick: decodeStart && click ? click - decodeStart.at : null,
    resumeMs: resumes.reduce((sum, m) => sum + (m.name === 'ctx:resume:end' ? m.ms : 0), 0),
    scheduleLeadMs: sourceStart?.leadSeconds != null ? sourceStart.leadSeconds * 1000 : null,
    encodedMB: resource ? resource.encodedBytes / 1024 / 1024 : null,
    ttfbMs: resource ? resource.ttfb : null,
    downloadMs: resource ? resource.download : null,
  });

  // Let the excerpt finish so the next measurement is clean.
  await page.waitForFunction(() => !document.querySelector('.play')?.classList.contains('is-playing'), null, { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('.play.is-playing'), null, { timeout: 20000 }).catch(() => {});
}

async function main() {
  const browser = await chromium.launch({ args: ['--mute-audio'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(PROBE);
  page.on('pageerror', (error) => console.log(`  [pageerror] ${error.message}`));

  console.log(`\nAudio latency measurement against ${BASE}\n`);

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.home-title', { timeout: 20000 });
  await page.click('.mode-card[data-mode="multi"]');
  await page.waitForSelector('.mp-menu');
  await page.fill('.mp-name', 'Latency');
  await page.selectOption('.mp-rounds', '3');
  await page.click('.mp-create');
  await page.waitForSelector('.mp-lobby');
  await page.click('.mp-start');
  await page.waitForSelector('.mp-game');
  await sleep(1200); // let the round settle exactly as a player would

  const results = [];

  /* Round 1: first play, then a second play of the same song. */
  await measureRound(page, 'round 1 · first play', results);
  await page.evaluate(() => window.__lat.marks.splice(0, window.__lat.marks.length));
  await page.click('.play');
  await page.waitForFunction(() => document.querySelector('.play')?.classList.contains('is-playing'), null, { timeout: 8000 });
  await sleep(250);
  const second = await marksSince(page, null);
  const secondClick = second.find((m) => m.name === 'play:click')?.at ?? null;
  const secondStart = second.find((m) => m.name === 'source:start');
  results.push({
    label: 'round 1 · second play',
    clickToStart: secondClick && secondStart ? secondStart.at - secondClick : null,
    decodeMs: null,
    decodeStartedBeforeClick: null,
  });
  await sleep(700);

  /* Resolve round 1 quickly, then measure round 2's first play. */
  await page.click('.mp-giveup');
  await page.waitForSelector('.reveal.is-results', { timeout: 15000 });
  await page.waitForSelector('.reveal-audio[data-state="playing"]', { timeout: 10000 }).catch(() => {});
  await page.click('.mp-ready');
  await page.waitForFunction(() => document.querySelector('.reveal.is-results') === null, null, { timeout: 10000 }).catch(() => {});
  await page.waitForSelector('.mp-game .play', { timeout: 10000 });
  await sleep(1000);

  await measureRound(page, 'round 2 · first play', results);

  /* Report. */
  const header = ['measurement', 'round→ready', 'click→scheduled', 'decode after click', 'encoded MB', 'ttfb ms', 'download ms'];
  console.log(
    `  ${header[0].padEnd(26)}${header[1].padStart(14)}${header[2].padStart(17)}${header[3].padStart(19)}${header[4].padStart(13)}${header[5].padStart(10)}${header[6].padStart(13)}`,
  );
  for (const row of results) {
    console.log(
      `  ${row.label.padEnd(26)}${fmt(row.preloadMs).padStart(14)}${fmt(row.clickToStart).padStart(17)}${fmt(row.decodeMs).padStart(19)}${(row.encodedMB?.toFixed(2) ?? '—').padStart(13)}${fmt(row.ttfbMs).padStart(10)}${fmt(row.downloadMs).padStart(13)}`,
    );
  }

  const first = results.find((r) => r.label.includes('first play'));
  console.log(
    `\n  All times in ms. "click→scheduled" is what the player feels.\n` +
      `  First play of a fresh song: ${fmt(results[0].clickToStart)} ms (decode ${fmt(results[0].decodeMs)} ms, ${(results[0].encodedMB ?? 0).toFixed(1)} MB file)\n`,
  );
  void first;

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
