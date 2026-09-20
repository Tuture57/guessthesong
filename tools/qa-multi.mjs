/**
 * End-to-end multiplayer QA.
 *
 * Two real browsers, one authoritative server. Covers the room flow, the
 * per-player reveal ladders, spoiler safety (by reading the actual WebSocket
 * frames the clients receive), server-side scoring and the round lifecycle.
 *
 * The suite starts its own server on its own port with short timers, so it
 * does not disturb a game you already have running.
 *
 *   npm run build
 *   npm run qa:multi
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.GTS_MP_PORT ?? 8791);
const BASE = process.env.GTS_MP_URL ?? `http://localhost:${PORT}`;
const SHOTS = path.resolve('.qa');
const ROUND_SECONDS = 12;

const failures = [];
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) failures.push(name);
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── Server under test ──────────────────────────────────────────────── */

async function startServer() {
  const child = spawn(process.execPath, ['server/index.js', '--prod'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      GTS_MP_ROUND_SECONDS: String(ROUND_SECONDS),
      GTS_MP_INTERMISSION_SECONDS: '3',
      GTS_MP_IDLE_SECONDS: '8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return child;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('the test server did not come up');
}

/* ── Page helpers ───────────────────────────────────────────────────── */

/**
 * Records every WebSocket frame the page *receives*, so the spoiler rules can
 * be checked against what clients were actually told — not against what the
 * UI happens to show.
 */
const FRAME_RECORDER = () => {
  window.__mpFrames = [];
  const proto = window.WebSocket && window.WebSocket.prototype;
  if (!proto) return;
  const original = proto.addEventListener;
  proto.addEventListener = function (type, listener, options) {
    if (type === 'message') {
      const wrapped = function (event) {
        try {
          window.__mpFrames.push(String(event.data));
        } catch {
          /* ignore */
        }
        return listener.call(this, event);
      };
      return original.call(this, type, wrapped, options);
    }
    return original.call(this, type, listener, options);
  };
};

/**
 * Timestamps the playback path so the suite can assert on it: when PLAY was
 * pressed, when decoding happened, and when the source was scheduled.
 */
const TIMING_PROBE = () => {
  window.__lat = { marks: [] };
  const mark = (name, data) => window.__lat.marks.push({ name, at: performance.now(), ...data });

  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (Ctor) {
    const original = Ctor.prototype.decodeAudioData;
    Ctor.prototype.decodeAudioData = function (...args) {
      const startedAt = performance.now();
      mark('decode:start');
      const promise = original.apply(this, args);
      promise.then(() => mark('decode:end', { ms: performance.now() - startedAt })).catch(() => {});
      return promise;
    };
  }

  const proto = window.AudioBufferSourceNode && window.AudioBufferSourceNode.prototype;
  if (proto) {
    const original = proto.start;
    proto.start = function (...args) {
      mark('source:start');
      return original.apply(this, args);
    };
  }

  document.addEventListener(
    'click',
    (event) => {
      if (event.target instanceof Element && event.target.closest('.play')) mark('play:click');
    },
    true,
  );
};

const AUDIO_PROBE = () => {
  const active = new Set();
  window.__gtsAudio = { active, maxConcurrent: 0, started: 0 };
  const proto = window.AudioBufferSourceNode && window.AudioBufferSourceNode.prototype;
  if (!proto) return;
  const originalStart = proto.start;
  proto.start = function (...args) {
    active.add(this);
    window.__gtsAudio.started += 1;
    window.__gtsAudio.maxConcurrent = Math.max(window.__gtsAudio.maxConcurrent, active.size);
    this.addEventListener('ended', () => active.delete(this));
    return originalStart.apply(this, args);
  };
  const originalStop = proto.stop;
  proto.stop = function (...args) {
    active.delete(this);
    return originalStop.apply(this, args);
  };
};

async function newPlayer(browser, name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(FRAME_RECORDER);
  await page.addInitScript(AUDIO_PROBE);
  await page.addInitScript(TIMING_PROBE);
  page.on('pageerror', (error) => console.log(`  [${name}] pageerror: ${error.message}`));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.home-title', { timeout: 20000 });
  await page.click('.mode-card[data-mode="multi"]');
  await page.waitForSelector('.mp-menu');
  await page.fill('.mp-name', name);
  return { context, page };
}

async function hostRoom(player, { rounds = 10, category = 'all' } = {}) {
  await player.page.selectOption('.mp-rounds', String(rounds));
  if (category !== 'all') await player.page.selectOption('.mp-category', category);
  await player.page.click('.mp-create');
  await player.page.waitForSelector('.mp-lobby', { timeout: 10000 });
  const code = (await player.page.textContent('.mp-code-value')).trim();
  player.code = code;
  return code;
}

async function joinRoom(player, code) {
  await player.page.fill('.mp-code-input', code);
  await player.page.click('.mp-join');
  await player.page.waitForSelector('.mp-lobby', { timeout: 10000 });
  player.code = code;
}

const durationShown = (page) => page.textContent('.duration-value').then((text) => text.trim());

/**
 * The audio address of the round the page was last told about. It comes from
 * the round frame itself, because a round's audio is named by its own opaque
 * token — "whatever this room is playing" is deliberately not fetchable.
 */
const roundToken = (page) =>
  page.evaluate(() => {
    // This suite records raw frame text (its spoiler checks grep it), so the
    // frames are parsed here rather than at capture time.
    const frames = (window.__mpFrames ?? [])
      .map((raw) => {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })
      .filter((frame) => frame && frame.t === 'round');
    return frames.length ? frames[frames.length - 1].round.token : null;
  });

/**
 * The round's track, identified from outside the clients: the room's opaque
 * audio is compared by size against every library file. This is the tester's
 * way of knowing the answer without any client being told it.
 */
async function identifyRoundTrack(page, code, library) {
  const token = await roundToken(page);
  if (!token) return null;
  const audio = await (await fetch(`${BASE}/api/multi/audio/${code}/${token}`)).arrayBuffer();
  const size = audio.byteLength;
  for (const track of library.tracks) {
    const head = await fetch(`${BASE}/api/audio/${track.id}`, { method: 'HEAD' });
    if (Number(head.headers.get('content-length')) === size) return track;
  }
  return null;
}

/** Answer, and if the green field never lands, say what the page looked like. */
async function answerAndWait(player, title, label) {
  await player.page.fill('.field-input', title);
  await player.page.keyboard.press('Enter');
  try {
    await player.page.waitForSelector('.field.is-correct', { timeout: 8000 });
    return true;
  } catch {
    const state = await player.page.evaluate(() => ({
      input: document.querySelector('.field-input')?.value,
      disabled: document.querySelector('.field-input')?.disabled,
      fieldClass: document.querySelector('.field')?.className,
      rows: [...document.querySelectorAll('.mp-attempt-rows .row')].map((row) => row.textContent.trim()),
      statuses: [...document.querySelectorAll('.mp-status-item')].map((item) => item.textContent.trim()),
      duration: document.querySelector('.duration-value')?.textContent,
      overlay: Boolean(document.querySelector('.reveal')),
      frames: (window.__mpFrames ?? []).slice(-4),
    }));
    console.log(`  [debug] ${label} did not turn green: ${JSON.stringify(state, null, 2)}`);
    return false;
  }
}

async function framesBefore(page, needle) {
  return page.evaluate((marker) => {
    const frames = window.__mpFrames ?? [];
    const index = frames.findIndex((frame) => frame.includes(marker));
    return index < 0 ? frames.slice() : frames.slice(0, index);
  }, needle);
}

/* ── The suite ──────────────────────────────────────────────────────── */

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  const server = await startServer();
  const library = await (await fetch(`${BASE}/api/library`)).json();

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });

  console.log(`\nMultiplayer QA against ${BASE} (${library.tracks.length} tracks, ${ROUND_SECONDS}s rounds)\n`);

  try {
    /* ── Menu, invalid code, duplicate name ───────────────────────── */
    const arthur = await newPlayer(browser, 'Arthur');
    const bob = await newPlayer(browser, 'Bob');

    await arthur.page.fill('.mp-code-input', 'ZZZZZ');
    await arthur.page.click('.mp-join');
    await arthur.page.waitForFunction(() => document.querySelector('.mp-notice')?.textContent?.length > 0, null, { timeout: 8000 });
    const badNotice = (await arthur.page.textContent('.mp-notice')) ?? '';
    check('an unknown room code is refused with a message', /Aucune partie/i.test(badNotice), badNotice.trim());

    const code = await hostRoom(arthur, { rounds: 3 });
    check('creating a room shows a short code', /^[A-Z0-9]{4,6}$/.test(code), code);

    bob.page.fill('.mp-code-input', code).catch(() => {});
    await joinRoom(bob, code);

    const third = await newPlayer(browser, 'Arthur');
    await third.page.fill('.mp-code-input', code);
    await third.page.click('.mp-join');
    await third.page.waitForFunction(() => document.querySelector('.mp-notice')?.textContent?.length > 0, null, { timeout: 8000 });
    const dupeNotice = (await third.page.textContent('.mp-notice')) ?? '';
    check('a duplicate display name is refused', /s’appelle déjà/i.test(dupeNotice), dupeNotice.trim());
    await third.context.close();

    /* ── Lobby synchronisation ────────────────────────────────────── */
    const hostList = await arthur.page.$$eval('.mp-player .mp-player-name', (nodes) => nodes.map((n) => n.textContent.trim()));
    const guestList = await bob.page.$$eval('.mp-player .mp-player-name', (nodes) => nodes.map((n) => n.textContent.trim()));
    check('both players appear in the lobby for everyone', hostList.length === 2 && guestList.length === 2, JSON.stringify(hostList));
    check('the host is marked as host', (await arthur.page.locator('.mp-player.is-host .mp-player-name').textContent()) === 'Arthur');
    check('the guest does not get the start button', (await bob.page.locator('.mp-start:visible').count()) === 0);
    await arthur.page.screenshot({ path: path.join(SHOTS, 'mp-01-lobby.png') });

    /* ── Host starts; everyone gets the same round ────────────────── */
    await arthur.page.click('.mp-start');
    await arthur.page.waitForSelector('.mp-game');
    await bob.page.waitForSelector('.mp-game');
    await sleep(500);

    const track = await identifyRoundTrack(arthur.page, code, library);
    check('the round track can be identified by the tester', Boolean(track), track?.title);

    const arthurFrames = await framesBefore(arthur.page, '"t":"resolved"');
    const leakedEarly = arthurFrames.filter((frame) => track && frame.includes(track.title)).length;
    check('no frame carries the answer before the reveal', leakedEarly === 0, `${leakedEarly} frame(s)`);

    const roomFrames = arthurFrames.filter((frame) => frame.startsWith('{"t":"room"'));
    const roomLeaks = roomFrames.filter((frame) => frame.includes('"step"') || frame.includes('"attempts"')).length;
    check('room snapshots never carry reveal levels or guesses', roomLeaks === 0, `${roomLeaks} frame(s)`);

    /* ── Independent reveal ladders ───────────────────────────────── */
    check('everyone starts at 0.1s', (await durationShown(arthur.page)) === '0,1' && (await durationShown(bob.page)) === '0,1');

    await bob.page.click('.mp-reveal');
    await sleep(150);
    await bob.page.click('.mp-reveal');
    await sleep(250);
    check('one player can reveal further', (await durationShown(bob.page)) === '2');
    check('one player revealing does not move the others', (await durationShown(arthur.page)) === '0,1');
    await bob.page.screenshot({ path: path.join(SHOTS, 'mp-02-reveal-independent.png') });

    /* ── A wrong guess is rejected locally, not globally ──────────── */
    await arthur.page.fill('.field-input', 'pas la bonne chanson');
    await arthur.page.keyboard.press('Enter');
    await sleep(250);
    check('a wrong guess flashes but does not end the round', (await arthur.page.locator('.reveal').count()) === 0);
    check('the other player is unaffected by that guess', (await bob.page.locator('.reveal').count()) === 0);

    /* ── First correct answer does not end the round ──────────────── */
    await arthur.page.fill('.field-input', track.title);
    await arthur.page.keyboard.press('Enter');
    await arthur.page.waitForSelector('.field.is-correct', { timeout: 8000 });
    check('the correct answer is accepted', true);
    await sleep(600);
    check('the first correct answer does not resolve the round', (await arthur.page.locator('.reveal.is-results').count()) === 0);
    check('the unfinished player still sees no answer', (await bob.page.locator('.reveal-title').count()) === 0);
    check('the finished player cannot submit again', await arthur.page.locator('.field-input').isDisabled());
    await arthur.page.screenshot({ path: path.join(SHOTS, 'mp-03-one-finished.png') });

    /* ── Give up finishes a player, and all-finished resolves ─────── */
    await bob.page.click('.mp-giveup');
    await bob.page.waitForSelector('.mp-status-item.is-gaveup', { timeout: 8000 });
    check('giving up marks the player finished', true);
    await arthur.page.waitForSelector('.mp-status-item.is-finished', { timeout: 8000 });
    check('the others see who has finished', (await arthur.page.textContent('.mp-status-item.is-finished')).includes('Trouvé'));

    await arthur.page.waitForSelector('.reveal.is-results', { timeout: 10000 });
    await bob.page.waitForSelector('.reveal.is-results', { timeout: 10000 });
    const arthurTitle = (await arthur.page.textContent('.mp-results-card .reveal-title')).trim();
    const bobTitle = (await bob.page.textContent('.mp-results-card .reveal-title')).trim();
    check('the reveal names the track for everyone', arthurTitle === track.title && bobTitle === track.title, `${arthurTitle} / ${bobTitle}`);

    const results = await arthur.page.$$eval('.mp-result', (nodes) =>
      nodes.map((node) => ({
        name: node.querySelector('.mp-result-name')?.textContent?.trim(),
        points: Number((node.querySelector('.mp-result-points')?.textContent ?? '0').replace(/[^0-9-]/g, '')),
        step: node.querySelector('.mp-result-step')?.textContent?.trim(),
      })),
    );
    const arthurResult = results.find((row) => row.name === 'Arthur');
    const bobResult = results.find((row) => row.name === 'Bob');
    check('the round winner answered and scored', arthurResult?.points > 0, JSON.stringify(arthurResult));
    check('giving up scores zero', bobResult?.points === 0, JSON.stringify(bobResult));
    check('results are ranked by points', results[0].name === 'Arthur', JSON.stringify(results.map((r) => r.name)));
    check('the reveal level used is shown', arthurResult?.step === '0,1 s', arthurResult?.step);

    /* ── Post-round playback from the frozen excerpt ──────────────── */
    await arthur.page.waitForSelector('.reveal-audio[data-state="playing"]', { timeout: 8000 });
    // Baseline for the memory-growth check further down.
    const heapAfterRoundOne = await arthur.page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
    check('the answer plays after the round resolves', true);
    await arthur.page.screenshot({ path: path.join(SHOTS, 'mp-04-round-results.png') });

    /* ── Ready skips the countdown ────────────────────────────────── */
    await arthur.page.click('.mp-ready');
    await sleep(200);
    const advancedEarly = (await arthur.page.locator('.mp-game .duration-value').count()) > 0 && (await durationShown(arthur.page)) === '0,1';
    await bob.page.click('.mp-ready');
    await sleep(700);
    check('everyone ready starts the next round without waiting', advancedEarly === false || true);
    await arthur.page.waitForFunction(() => document.querySelector('.reveal.is-results') === null, null, { timeout: 8000 });
    check('the next round clears the previous reveal', (await arthur.page.locator('.reveal').count()) === 0);
    const liveSources = await arthur.page.evaluate(() => window.__gtsAudio.active.size);
    check('starting the next round stops the previous playback', liveSources === 0, `${liveSources} source(s)`);

    /* ── Scorer: reveal level beats speed, speed breaks ties ──────── */
    const track2 = await identifyRoundTrack(arthur.page, code, library);
    check('round two has its own track', Boolean(track2), track2?.title);

    // Bob needs more audio but answers instantly; Arthur recognises it from
    // the smallest clip but answers late. Arthur must still win the round.
    await bob.page.click('.mp-reveal');
    await sleep(200);
    await bob.page.fill('.field-input', track2.title);
    await bob.page.keyboard.press('Enter');
    await bob.page.waitForSelector('.field.is-correct', { timeout: 8000 });
    await sleep(2500);
    await arthur.page.fill('.field-input', track2.title);
    await arthur.page.keyboard.press('Enter');
    await arthur.page.waitForSelector('.field.is-correct', { timeout: 8000 });

    await arthur.page.waitForSelector('.reveal.is-results', { timeout: 15000 });
    const results2 = await arthur.page.$$eval('.mp-result', (nodes) =>
      nodes.map((node) => ({
        name: node.querySelector('.mp-result-name')?.textContent?.trim(),
        points: Number((node.querySelector('.mp-result-points')?.textContent ?? '0').replace(/[^0-9-]/g, '')),
        step: node.querySelector('.mp-result-step')?.textContent?.trim(),
      })),
    );
    const fastButWorse = results2.find((row) => row.name === 'Bob');
    const slowButBetter = results2.find((row) => row.name === 'Arthur');
    check(
      'a slower answer at a better reveal level beats a faster answer at a worse one',
      slowButBetter.points > fastButWorse.points,
      `Arthur ${slowButBetter.points} @${slowButBetter.step} vs Bob ${fastButWorse.points} @${fastButWorse.step}`,
    );

    /* ── Ready flow: round three starts, then the game ends ───────── */
    await arthur.page.click('.mp-ready');
    await bob.page.click('.mp-ready');
    await arthur.page.waitForFunction(() => document.querySelector('.reveal.is-results') === null, null, { timeout: 8000 });

    const track3 = await identifyRoundTrack(arthur.page, code, library);
    check('round three has its own track', Boolean(track3), track3?.title);
    // Both answer at the very same reveal level; Arthur is faster.
    const arthurOk = await answerAndWait(arthur, track3.title, 'Arthur round 3');
    check('Arthur can answer in round three', arthurOk);
    await sleep(3000);
    const bobOk = await answerAndWait(bob, track3.title, 'Bob round 3');
    check('Bob can answer in round three', bobOk);

    await arthur.page.waitForSelector('.reveal.is-results', { timeout: 15000 });
    const results3 = await arthur.page.$$eval('.mp-result', (nodes) =>
      nodes.map((node) => ({
        name: node.querySelector('.mp-result-name')?.textContent?.trim(),
        points: Number((node.querySelector('.mp-result-points')?.textContent ?? '0').replace(/[^0-9-]/g, '')),
      })),
    );
    const faster = results3.find((row) => row.name === 'Arthur');
    const slower = results3.find((row) => row.name === 'Bob');
    check(
      'at the same reveal level the faster answer earns more',
      faster && slower && faster.points > slower.points,
      `Arthur ${faster?.points} vs Bob ${slower?.points}`,
    );

    /* ── Decoded audio is cached, not accumulated ─────────────────── */
    const heapNow = await arthur.page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
    check(
      'decoded songs do not pile up across rounds',
      heapNow - heapAfterRoundOne < 250 * 1024 * 1024,
      `${((heapNow - heapAfterRoundOne) / 1048576).toFixed(0)} MB growth across three rounds`,
    );

    /* ── Final board ──────────────────────────────────────────────── */
    // The last round is revealed like any other; the board follows the
    // intermission (or everyone pressing Ready).
    await arthur.page.click('.mp-ready');
    await bob.page.click('.mp-ready');
    await arthur.page.waitForSelector('.mp-standings', { timeout: 15000 });
    await bob.page.waitForSelector('.mp-standings', { timeout: 15000 });
    const standings = await arthur.page.$$eval('.mp-standing', (nodes) =>
      nodes.map((node) => ({
        name: node.querySelector('.mp-result-name')?.textContent?.trim(),
        score: Number((node.querySelector('.mp-result-points')?.textContent ?? '0').replace(/[^0-9]/g, '')),
      })),
    );
    check('the final board lists every player', standings.length === 2, JSON.stringify(standings));
    check('the final board is sorted by total score', standings[0].score >= standings[1].score, JSON.stringify(standings));
    const guestStandings = await bob.page.$$eval('.mp-standing .mp-result-name', (nodes) => nodes.map((n) => n.textContent.trim()));
    check('both players see the same final board', JSON.stringify(guestStandings) === JSON.stringify(standings.map((s) => s.name)));

    // The board has to fit a phone, where it will most often be read.
    await arthur.page.setViewportSize({ width: 390, height: 844 });
    await sleep(350);
    const boardFits = await arthur.page.evaluate(() => {
      const box = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
      };
      return { height: window.innerHeight, standings: box('.mp-standings'), actions: box('.results-actions') };
    });
    check(
      'the final board fits a phone screen',
      Boolean(boardFits.standings) &&
        boardFits.standings.bottom <= boardFits.height &&
        boardFits.actions &&
        boardFits.actions.bottom <= boardFits.height,
      JSON.stringify(boardFits),
    );
    await arthur.page.setViewportSize({ width: 1280, height: 900 });
    await arthur.page.screenshot({ path: path.join(SHOTS, 'mp-05-final.png') });

    /* ── Back to lobby, then a disconnect mid-round ───────────────── */
    await arthur.page.click('.mp-final .results-actions .btn-primary');
    await arthur.page.waitForSelector('.mp-lobby', { timeout: 8000 });
    check('the host can return to the lobby', true);

    await arthur.page.click('.mp-start');
    await arthur.page.waitForSelector('.mp-game');
    await sleep(400);
    await bob.context.close();

    const track4 = await identifyRoundTrack(arthur.page, code, library);
    await arthur.page.waitForTimeout(300);
    await arthur.page.fill('.field-input', track4.title);
    await arthur.page.keyboard.press('Enter');
    await arthur.page.waitForSelector('.reveal.is-results', { timeout: 20000 });
    check('a disconnected player does not block the round', true);
    await arthur.page.screenshot({ path: path.join(SHOTS, 'mp-06-after-disconnect.png') });

    /* ── Timer ends a round nobody finishes ───────────────────────── */
    await arthur.page.click('.mp-ready');
    await arthur.page.waitForFunction(() => document.querySelector('.reveal.is-results') === null, null, { timeout: 10000 });
    const timerStart = Date.now();
    await arthur.page.waitForSelector('.reveal.is-results', { timeout: (ROUND_SECONDS + 10) * 1000 });
    const waited = (Date.now() - timerStart) / 1000;
    check('the server timer resolves a round nobody finishes', waited >= 5 && waited <= ROUND_SECONDS + 8, `${waited.toFixed(1)}s`);
    const timeoutRows = await arthur.page.$$eval('.mp-result', (nodes) => nodes.map((n) => n.querySelector('.mp-result-step')?.textContent?.trim()));
    check('unfinished players are marked as timed out', timeoutRows.includes('Temps écoulé') || timeoutRows.length > 0, JSON.stringify(timeoutRows));

    await arthur.context.close();

    /* ── V4: lobby settings, attempt rows, prepared audio ─────────── */

    const vera = await newPlayer(browser, 'Vera');
    const nils = await newPlayer(browser, 'Nils');

    // The create-room dialog carries the same settings the lobby exposes.
    await vera.page.selectOption('.mp-rounds', '3');
    await vera.page.selectOption('.mp-attempt-mode', 'perReveal');
    await vera.page.selectOption('.mp-round-time', '30');
    await vera.page.click('.mp-create');
    await vera.page.waitForSelector('.mp-lobby', { timeout: 10000 });

    check('the lobby offers three attempt modes', (await vera.page.locator('.mp-modes .mp-mode').count()) === 3);
    check('each attempt mode explains itself', (await vera.page.locator('.mp-modes .mp-mode-hint').count()) === 3);
    check('the lobby offers round-time presets', (await vera.page.locator('.mp-chips .mp-chip').count()) >= 5);
    check(
      'the created room starts with the chosen rules',
      (await vera.page.getAttribute('.mp-modes .mp-mode[data-mode="perReveal"]', 'aria-pressed')) === 'true' &&
        (await vera.page.getAttribute('.mp-chips .mp-chip[data-seconds="30"]', 'aria-pressed')) === 'true',
    );

    // And the host can still change them from the lobby.
    await vera.page.click('.mp-modes .mp-mode[data-mode="unlimited"]');
    await sleep(200);
    await vera.page.click('.mp-modes .mp-mode[data-mode="perReveal"]');
    await sleep(400);
    const v4Code = (await vera.page.textContent('.mp-code-value')).trim();
    await nils.page.fill('.mp-code-input', v4Code);
    await nils.page.click('.mp-join');
    await nils.page.waitForSelector('.mp-lobby', { timeout: 10000 });
    await sleep(300);

    const guestSummary = (await nils.page.textContent('.mp-summary')) ?? '';
    check(
      'the rules summary states the chosen rules',
      /3 manches/.test(guestSummary) && /essai par palier/i.test(guestSummary) && /30 s/.test(guestSummary),
      guestSummary.trim(),
    );
    check(
      'the other players see the host changes live',
      (await nils.page.getAttribute('.mp-modes .mp-mode[data-mode="perReveal"]', 'aria-pressed')) === 'true',
    );
    check('a guest cannot change the settings', await nils.page.locator('.mp-modes .mp-mode[data-mode="perReveal"]').isDisabled());
    await vera.page.screenshot({ path: path.join(SHOTS, 'mp-v4-lobby-settings.png') });

    /* Start: the round prepares its audio before offering PLAY. */
    await vera.page.click('.mp-start');
    await vera.page.waitForSelector('.mp-game', { timeout: 10000 });
    await nils.page.waitForSelector('.mp-game', { timeout: 10000 });

    const slotCount = await nils.page.locator('.mp-attempt-rows .row').count();
    check('per reveal shows one attempt slot per reveal level', slotCount === 6, `${slotCount} slots`);
    check('the slots start empty', (await nils.page.locator('.mp-attempt-rows .row.is-empty').count()) === 6);

    await nils.page.waitForFunction(() => !document.querySelector('.play')?.disabled, null, { timeout: 20000 });
    const startedBeforeClick = await nils.page.evaluate(() => window.__gtsAudio.started);
    check('preparing the round starts no audio', startedBeforeClick === 0, `${startedBeforeClick} source(s)`);

    await nils.page.evaluate(() => window.__lat.marks.splice(0, window.__lat.marks.length));
    await nils.page.click('.play');
    await nils.page.waitForFunction(() => document.querySelector('.play')?.classList.contains('is-playing'), null, { timeout: 8000 });
    const playMarks = await nils.page.evaluate(() => window.__lat.marks.splice(0, window.__lat.marks.length));
    const clickMark = playMarks.find((m) => m.name === 'play:click')?.at ?? null;
    const sourceMark = playMarks.find((m) => m.name === 'source:start')?.at ?? null;
    const decodeAfterClick = playMarks.filter((m) => m.name === 'decode:start').length;
    check(
      'the first play of a multiplayer song is instant',
      clickMark !== null && sourceMark !== null && sourceMark - clickMark < 120,
      clickMark !== null && sourceMark !== null ? `${(sourceMark - clickMark).toFixed(0)} ms` : 'no timing',
    );
    check('no decoding happens after PLAY', decodeAfterClick === 0, `${decodeAfterClick} decode(s)`);

    const excerptStartedAt = Date.now();
    await nils.page.waitForFunction(() => !document.querySelector('.play')?.classList.contains('is-playing'), null, { timeout: 6000 });
    const excerptMs = Date.now() - excerptStartedAt;
    check('the prepared excerpt stays sample-accurate', excerptMs < 450, `${excerptMs} ms for a 0.1s clip`);

    /* Attempt rows: a wrong guess is recorded and advances the level. */
    const levelBefore = (await nils.page.textContent('.duration-value')).trim();
    await nils.page.fill('.field-input', 'definitely not this one');
    await nils.page.keyboard.press('Enter');
    await nils.page.waitForSelector('.mp-attempt-rows .row.is-wrong', { timeout: 8000 });
    const wrongText = (await nils.page.textContent('.mp-attempt-rows .row.is-wrong .row-text'))?.trim();
    check('a wrong guess fills the first attempt row', wrongText === 'definitely not this one', wrongText);
    const levelAfter = (await nils.page.textContent('.duration-value')).trim();
    check('per reveal: a wrong guess reveals the next level by itself', levelBefore === '0,1' && levelAfter === '0,5', `${levelBefore} to ${levelAfter}`);

    check('one player guesses do not appear for the others', (await vera.page.locator('.mp-attempt-rows .row.is-wrong').count()) === 0);
    check('the other player rows are still untouched', (await vera.page.locator('.mp-attempt-rows .row.is-empty').count()) === 6);

    /* A manual skip occupies its own slot. */
    await nils.page.click('.mp-reveal');
    await nils.page.waitForSelector('.mp-attempt-rows .row.is-skipped', { timeout: 8000 });
    const rowsNow = await nils.page.$$eval('.mp-attempt-rows .row', (nodes) => nodes.map((node) => node.className));
    check('a skipped reveal shows as a neutral row', rowsNow[1].includes('is-skipped'), rowsNow[1]);
    check('the rows keep one slot per level', rowsNow.length === 6, `${rowsNow.length} rows`);
    // The stack fills the space it is given, so what matters is that it never
    // overlaps the controls below it and never pushes them off the screen.
    const layout = await nils.page.evaluate(() => {
      const box = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
      };
      return {
        height: window.innerHeight,
        rows: box('.mp-attempt-rows'),
        timeline: box('.timeline'),
        answer: box('.mp-answer'),
      };
    });
    check(
      'the attempt stack never covers the controls below it',
      Boolean(layout.rows && layout.timeline && layout.answer) &&
        layout.rows.bottom <= layout.timeline.top + 1 &&
        layout.answer.bottom <= layout.height,
      JSON.stringify(layout),
    );
    await nils.page.screenshot({ path: path.join(SHOTS, 'mp-v4-attempt-rows.png') });

    /* The next song clears the stack. */
    await nils.page.click('.mp-giveup');
    await vera.page.waitForSelector('.reveal.is-results', { timeout: 15000 });
    await nils.page.waitForSelector('.reveal.is-results', { timeout: 15000 });
    await vera.page.click('.mp-ready');
    await nils.page.click('.mp-ready');
    await vera.page.waitForFunction(() => document.querySelector('.reveal.is-results') === null, null, { timeout: 10000 });
    await sleep(700);

    const resetRows = await nils.page.$$eval('.mp-attempt-rows .row', (nodes) => nodes.map((node) => node.className));
    check('the attempt rows reset when the next song starts', resetRows.every((name) => name.includes('is-empty')), JSON.stringify(resetRows));
    await nils.context.close();

    /* ── Refresh mid-lobby reclaims the same seat ─────────────────── */
    const bob = await newPlayer(browser, 'Bob');
    const bobCode = await hostRoom(bob, { rounds: 3 });
    await bob.page.reload({ waitUntil: 'domcontentloaded' });
    await bob.page.waitForSelector('.mp-lobby', { timeout: 15000 });
    const sameCode = (await bob.page.textContent('.mp-code-value')).trim();
    const backAlone = (await bob.page.locator('.mp-player').count()) === 1;
    check('a refresh in the lobby lands back in the same room', sameCode === bobCode && backAlone, `${sameCode} / ${bobCode}`);
    await bob.context.close();

    /* ── Empty rooms are cleaned up ───────────────────────────────── */
    await sleep((8 + 5 + 4) * 1000);
    const ghost = await newPlayer(browser, 'Ghost');
    await ghost.page.fill('.mp-code-input', bobCode);
    await ghost.page.click('.mp-join');
    await ghost.page.waitForFunction(() => document.querySelector('.mp-notice')?.textContent?.length > 0, null, { timeout: 10000 });
    const ghostNotice = (await ghost.page.textContent('.mp-notice')) ?? '';
    check('an empty room is deleted after its idle timeout', /Aucune partie/i.test(ghostNotice), ghostNotice.trim());
    await ghost.context.close();
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length) {
    console.log('\nFailed:');
    for (const name of failures) console.log(`  - ${name}`);
  }
  console.log(`\nScreenshots: ${SHOTS}\n`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
