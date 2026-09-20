/**
 * Multiplayer audio synchronisation — real browsers, real buffers.
 *
 * The one thing a multiplayer round must never do is let two players hear
 * different tracks, or let a reveal name a song other than the one that was
 * played. Neither is visible in a screenshot, so this suite fingerprints the
 * audio itself: every `AudioBufferSourceNode.start` is tapped, the samples it
 * was handed are hashed, and the hash is compared against the file of the
 * track the server revealed for that round.
 *
 * The tap also records the `offset` argument — the position the excerpt was
 * taken from — which turns "everyone hears the same excerptStart, but each
 * player chooses their own length" into a measured fact.
 *
 * Two browser contexts play two consecutive games in the *same room*: round
 * numbers restart, so a cache keyed on them is exercised the way a rematch
 * exercises it. Player B reloads between the games, the cheapest way to make
 * the two players' caches differ — the exact shape of the reported bug.
 *
 *   npm run build
 *   npm run qa:sync
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.GTS_SYNC_PORT ?? 8795);
const BASE = process.env.GTS_SYNC_URL ?? `http://localhost:${PORT}`;
const INTERMISSION = 4;
const ROUND_SECONDS = 30;

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
      GTS_MP_INTERMISSION_SECONDS: String(INTERMISSION),
      GTS_MP_IDLE_SECONDS: '120',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

  for (let i = 0; i < 80; i += 1) {
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

/* ── Page probes ────────────────────────────────────────────────────── */

/** Every WebSocket frame the page receives, parsed: rounds and reveals. */
const FRAME_RECORDER = () => {
  window.__mpFrames = [];
  const proto = window.WebSocket && window.WebSocket.prototype;
  if (!proto) return;
  const original = proto.addEventListener;
  proto.addEventListener = function (type, listener, options) {
    if (type === 'message') {
      const wrapped = function (event) {
        try {
          window.__mpFrames.push(JSON.parse(String(event.data)));
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
 * The audio tap. `start(when, offset, duration)` is the moment a slice of a
 * decoded buffer is handed to the audio hardware, so it is the earliest point
 * at which "which song is this player hearing, and from where" is knowable.
 */
const AUDIO_TAP = () => {
  /** A content fingerprint: 512 strata across the first channel. */
  window.__sigOf = (buffer) => {
    const data = buffer.getChannelData(0);
    const stride = Math.max(1, Math.floor(data.length / 512));
    let hash = 2166136261;
    const fold = (value) => {
      hash ^= value & 0xffff;
      hash = Math.imul(hash, 16777619);
      hash ^= (value >>> 16) & 0xffff;
      hash = Math.imul(hash, 16777619);
    };
    for (let i = 0; i < data.length; i += stride) fold(Math.round(data[i] * 4000) & 0xffff);
    fold(Math.round(buffer.duration * 1000) & 0xffffff);
    fold(Math.round(buffer.sampleRate) & 0xffff);
    return (hash >>> 0).toString(16).padStart(8, '0');
  };

  window.__tap = { plays: [] };
  const proto = window.AudioBufferSourceNode && window.AudioBufferSourceNode.prototype;
  if (!proto) return;
  const original = proto.start;
  proto.start = function (when, offset, duration) {
    try {
      if (this.buffer) {
        window.__tap.plays.push({
          sig: window.__sigOf(this.buffer),
          offset: typeof offset === 'number' ? offset : 0,
          length: typeof duration === 'number' ? duration : null,
          seconds: this.buffer.duration,
          at: performance.now(),
        });
      }
    } catch {
      /* the tap must never break playback */
    }
    return original.apply(this, arguments);
  };
};

/* ── Page helpers ───────────────────────────────────────────────────── */

async function openPlayer(browser, name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(FRAME_RECORDER);
  await page.addInitScript(AUDIO_TAP);
  page.on('pageerror', (error) => console.log(`  [${name}] pageerror: ${error.message}`));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.home-title', { timeout: 20000 });
  await page.click('.mode-card[data-mode="multi"]');
  await page.waitForSelector('.mp-menu');
  await page.fill('.mp-name', name);
  return { name, context, page };
}

/** The newest received frame of a kind, optionally filtered by a body string. */
const latestFrame = (page, type, body = 'return true;') =>
  page.evaluate(
    ([wanted, source]) => {
      const test = new Function('frame', source);
      const found = [...(window.__mpFrames ?? [])].filter((entry) => entry.t === wanted && test(entry));
      return found.length ? found[found.length - 1] : null;
    },
    [type, body],
  );

const drainTap = (page) => page.evaluate(() => window.__tap.plays.splice(0, window.__tap.plays.length));
const resetFrames = (page) => page.evaluate(() => { window.__mpFrames.length = 0; });

/** PLAY, then wait for the audio hardware to actually be handed a buffer. */
async function playAndCapture(player) {
  await drainTap(player.page);
  await player.page.click('.play');
  for (let i = 0; i < 100; i += 1) {
    const plays = await player.page.evaluate(() => window.__tap.plays.slice());
    if (plays.length) return plays[0];
    await sleep(100);
  }
  return null;
}

/** The fingerprint of one library file, decoded once in a scratch page. */
const fingerprint = (page, id, cache) => {
  if (cache[id]) return Promise.resolve(cache[id]);
  return page
    .evaluate(async (url) => {
      const ctx = window.__sigCtx ?? (window.__sigCtx = new AudioContext());
      const bytes = await (await fetch(url)).arrayBuffer();
      const buffer = await ctx.decodeAudioData(bytes);
      return window.__sigOf(buffer);
    }, `/api/audio/${id}`)
    .then((sig) => {
      cache[id] = sig;
      return sig;
    });
};

const waitForRound = (player, number) =>
  player.page.waitForFunction(
    (wanted) => {
      const rounds = (window.__mpFrames ?? []).filter((entry) => entry.t === 'round');
      return rounds.length > 0 && rounds[rounds.length - 1].round.number >= wanted;
    },
    number,
    { timeout: 25000 },
  );

/* ── The round loop ─────────────────────────────────────────────────── */

/**
 * One round: everyone reveals to their own level, then everyone listens.
 * Returns what each player was handed, and the round the server announced.
 */
async function playRound(players, number, levels) {
  for (const player of players) await waitForRound(player, number);

  await Promise.all(
    players.map(async (player, index) => {
      for (let i = 0; i < levels[index]; i += 1) {
        await player.page.click('.mp-reveal');
        await sleep(120);
      }
    }),
  );

  const round = await latestFrame(players[0].page, 'round');
  const heard = await Promise.all(players.map((player) => playAndCapture(player)));
  return { excerptStart: round.round.excerptStart, heard, round };
}

/** Wrong guess then give up: the round resolves without anyone scoring. */
async function bowOut(player) {
  await player.page.fill('.field-input', 'ce n’est pas ça');
  await player.page.keyboard.press('Enter');
  await sleep(150);
  await player.page.click('.mp-giveup');
}

/* ── The suite ──────────────────────────────────────────────────────── */

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const scratch = await (await browser.newContext()).newPage();
  await scratch.addInitScript(AUDIO_TAP);
  await scratch.goto(BASE, { waitUntil: 'domcontentloaded' });
  const signatures = {};

  console.log(`\nMultiplayer audio synchronisation against ${BASE}\n`);

  try {
    const arthur = await openPlayer(browser, 'Arthur');
    const bob = await openPlayer(browser, 'Bob');
    const players = [arthur, bob];

    /* ── Game one ─────────────────────────────────────────────────── */
    await arthur.page.selectOption('.mp-rounds', '3');
    await arthur.page.click('.mp-create');
    await arthur.page.waitForSelector('.mp-lobby', { timeout: 10000 });
    const code = (await arthur.page.textContent('.mp-code-value')).trim();
    await bob.page.fill('.mp-code-input', code);
    await bob.page.click('.mp-join');
    await bob.page.waitForSelector('.mp-lobby', { timeout: 10000 });
    // Clear the log while still in the lobby: the first round's frame is sent
    // in the same breath as the screen change.
    for (const player of players) await resetFrames(player.page);
    await arthur.page.click('.mp-start');
    await arthur.page.waitForSelector('.mp-game');

    // Reveal levels per player, in clicks: 0.1s/2s, then 0.5s/8s, then 4s/15s.
    const LEVELS = [
      [0, 2],
      [1, 4],
      [3, 5],
    ];

    const rounds = [];
    for (let number = 1; number <= 3; number += 1) {
      const phase = await playRound(players, number, LEVELS[number - 1]);
      await Promise.all(players.map((player) => bowOut(player)));
      await arthur.page.waitForSelector('.reveal.is-results', { timeout: 15000 });
      const resolved = await latestFrame(arthur.page, 'resolved', `return frame.round.number === ${number};`);

      // The reveal's own playback, tapped as well.
      await sleep(700);
      const revealPlays = await arthur.page.evaluate(() => window.__tap.plays.slice());
      await drainTap(arthur.page);

      rounds.push({ number, ...phase, track: resolved?.round.track ?? null, revealPlays });

      await arthur.page.click('.mp-ready');
      await bob.page.click('.mp-ready');
      await arthur.page.waitForFunction(() => document.querySelector('.reveal.is-results') === null, null, { timeout: 20000 });
      await sleep(250);
    }

    const gameOne = await report('round', rounds, signatures, scratch);

    /* ── Rematch in the same room, with a reload on one side ──────── */
    console.log('\n  — rematch in the same room, one player reloaded —\n');
    await arthur.page.click('.btn.btn-primary');
    await arthur.page.waitForSelector('.mp-lobby', { timeout: 15000 });
    await arthur.page.waitForSelector('.mp-lobby', { timeout: 15000 });

    await bob.page.reload({ waitUntil: 'domcontentloaded' });
    await bob.page.waitForSelector('.mp-lobby', { timeout: 25000 });
    await sleep(500);

    for (const player of players) await resetFrames(player.page);
    await arthur.page.click('.mp-start');
    await arthur.page.waitForSelector('.mp-game');
    await bob.page.waitForSelector('.mp-game', { timeout: 15000 });

    const rematch = [];
    for (let number = 1; number <= 2; number += 1) {
      const phase = await playRound(players, number, number === 1 ? [0, 1] : [2, 3]);
      await Promise.all(players.map((player) => bowOut(player)));
      await arthur.page.waitForSelector('.reveal.is-results', { timeout: 15000 });
      const resolved = await latestFrame(arthur.page, 'resolved', `return frame.round.number === ${number};`);
      await drainTap(arthur.page);
      rematch.push({ number, ...phase, track: resolved?.round.track ?? null });

      await arthur.page.click('.mp-ready');
      await bob.page.click('.mp-ready');
      if (number < 2) {
        await arthur.page.waitForFunction(() => document.querySelector('.reveal.is-results') === null, null, { timeout: 20000 });
        await sleep(250);
      }
    }

    const gameTwo = await report('rematch round', rematch, signatures, scratch);

    /* ── Cross-game facts ─────────────────────────────────────────── */
    check(
      'the rematch opens on a different song than the first game did',
      gameOne[0].track?.id !== gameTwo[0].track?.id,
      `${gameOne[0].track?.title} then ${gameTwo[0].track?.title}`,
    );
    const starts = [...gameOne, ...gameTwo].map((round) => round.excerptStart);
    check(
      'excerpt starts vary from round to round',
      new Set(starts.map((value) => value.toFixed(3))).size > 1,
      starts.map((value) => value.toFixed(3)).join(', '),
    );

    await arthur.context.close();
    await bob.context.close();
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length) {
    console.log('\nFailed:');
    for (const name of failures) console.log(`  - ${name}`);
    process.exitCode = 1;
  }
}

/**
 * The three audio facts of a round, checked for every player: the revealed
 * track is what they heard, the excerpt began where the server said, and the
 * two players were on different excerpt lengths while starting together.
 */
async function report(label, rounds, signatures, scratch) {
  const out = [];
  for (const round of rounds) {
    const expected = round.track ? await fingerprint(scratch, round.track.id, signatures) : null;
    const [arthur, bob] = round.heard;
    const both = (predicate) => Boolean(arthur) && Boolean(bob) && predicate(arthur) && predicate(bob);

    check(
      `${label} ${round.number}: both players hear the revealed track`,
      Boolean(expected) && both((play) => play.sig === expected),
      `revealed ${round.track?.title} [${expected}] · Arthur ${arthur?.sig} · Bob ${bob?.sig}`,
    );
    check(
      `${label} ${round.number}: both players start at the server's excerptStart`,
      both((play) => Math.abs(play.offset - round.excerptStart) < 0.05),
      `server ${round.excerptStart} · Arthur ${arthur?.offset} · Bob ${bob?.offset}`,
    );
    check(
      `${label} ${round.number}: the two players are on different excerpt lengths`,
      both(() => true) && Math.abs((arthur.length ?? 0) - (bob.length ?? 0)) > 0.001,
      `${arthur?.length}s vs ${bob?.length}s`,
    );
    if (round.revealPlays) {
      const revealSig = round.revealPlays.find((play) => play.length === null)?.sig;
      check(
        `${label} ${round.number}: the reveal replays the same track`,
        revealSig === expected,
        `reveal ${revealSig} · expected ${expected}`,
      );
    }
    out.push({ ...round, expected });
  }
  return out;
}

await main();
