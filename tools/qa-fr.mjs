/**
 * QA for the two things V6 added: the French interface, and the live standings.
 *
 * Two halves:
 *
 *   Language — every screen the player can reach is walked and its *chrome*
 *   read back: buttons, labels, headings, notices. Track titles and artist
 *   names are excluded, because the library is the player's and may be in any
 *   language; everything the game itself says must be French.
 *
 *   Standings — the board is checked against the server's own numbers. The
 *   frames each client receives are recorded, so "the board shows 4 980" can be
 *   compared with "the server said 4 980", and "the round's score is not
 *   leaked" can be checked against what actually crossed the wire.
 *
 *   npm run build
 *   npm run qa:fr
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.GTS_FR_PORT ?? 8793);
const BASE = process.env.GTS_FR_URL ?? `http://localhost:${PORT}`;
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
  throw new Error(`server did not come up on ${BASE}`);
}

/* ── Page probes ────────────────────────────────────────────────────── */

/**
 * Records every frame the page receives on its WebSocket, so the test can
 * compare what the board renders with what the server actually said.
 */
const FRAME_RECORDER = () => {
  window.__mpFrames = [];
  const proto = window.WebSocket && window.WebSocket.prototype;
  if (!proto) return;
  /*
   * Wrap the prototype, never the constructor: the app reads `WebSocket.OPEN`
   * to decide whether it may send, and a replacement function has no OPEN
   * constant — which silently turns every send into a no-op.
   */
  const original = proto.addEventListener;
  proto.addEventListener = function (type, listener, options) {
    if (type !== 'message') return original.call(this, type, listener, options);
    const wrapped = function (event) {
      try {
        window.__mpFrames.push(JSON.parse(String(event.data)));
      } catch {
        /* not JSON — nothing to record */
      }
      return listener.call(this, event);
    };
    return original.call(this, type, wrapped, options);
  };
};

/**
 * The visible chrome of the current screen.
 *
 * Text inside elements that carry library content — titles, artists, player
 * names, room codes — is left out: those are data, not copy, and they are
 * allowed to be in any language the player's music happens to be in.
 */
const READ_CHROME = () => {
  const CONTENT = [
    '.reveal-title',
    '.reveal-artist',
    '.suggestion-title',
    '.suggestion-artist',
    '.results-row',
    '.mp-result-name',
    '.mp-board-name',
    '.mp-player-name',
    '.mp-status-name',
    '.mp-code-value',
    '.mp-code-chip',
    'input',
    'code',
  ].join(',');

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const parts = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.trim();
    if (!text) continue;
    const parent = node.parentElement;
    if (!parent || parent.closest(CONTENT)) continue;
    const style = getComputedStyle(parent);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    if (!parent.getClientRects().length) continue;
    parts.push(text);
  }
  return parts.join(' \n ');
};

/* ── French screening ───────────────────────────────────────────────── */

/*
 * Words that only exist in the English UI this game used to have — each one
 * has a French counterpart the interface now uses instead. Words French and
 * English share (score, menu, pause, code, audio, final, second) are left out
 * on purpose: flagging them would flag correct French.
 */
const ENGLISH = [
  'play',
  'played',
  'playing',
  'round',
  'rounds',
  'streak',
  'ready',
  'waiting',
  'create',
  'join',
  'leave',
  'next',
  'skip',
  'skipped',
  'guess',
  'guesses',
  'guessed',
  'song',
  'songs',
  'track',
  'tracks',
  'library',
  'host',
  'away',
  'winner',
  'wins',
  'results',
  'correct',
  'wrong',
  'retry',
  'offline',
  'loading',
  'scanning',
  'search',
  'answer',
  'player',
  'players',
  'attempt',
  'attempts',
  'unlimited',
  'custom',
  'settings',
  'copy',
  'copied',
  'start',
  'back',
  'room',
  'time',
  'category',
  'found',
  'gave',
  'disconnected',
  'again',
  'your',
  'the',
  'and',
  'with',
  'from',
  'nothing',
  'something',
  'loading…',
];

const ENGLISH_RE = new RegExp(`(^|[^a-z])(${ENGLISH.join('|')})([^a-z]|$)`, 'i');

function findEnglish(text) {
  const hits = new Set();
  for (const line of text.split('\n')) {
    const match = ENGLISH_RE.exec(line);
    if (match) hits.add(match[2].toLowerCase());
  }
  return [...hits];
}

/* ── Geometry helpers ───────────────────────────────────────────────── */

const BOXES = (selectors) => {
  const out = {};
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (!element) {
      out[selector] = null;
      continue;
    }
    const rect = element.getBoundingClientRect();
    out[selector] = { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right) };
  }
  out.__viewport = { width: window.innerWidth, height: window.innerHeight };
  out.__scrollWidth = document.documentElement.scrollWidth;
  return out;
};

/* ── Multiplayer helpers ────────────────────────────────────────────── */

async function newPlayer(browser, name, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.addInitScript(FRAME_RECORDER);
  page.on('pageerror', (error) => console.log(`  [${name}] pageerror: ${error.message}`));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.home-title', { timeout: 20000 });
  return { context, page, name };
}

async function openMenu(player) {
  if (await player.page.locator('.mp-menu').count()) return;
  await player.page.click('.mode-card[data-mode="multi"]');
  await player.page.waitForSelector('.mp-menu');
  await player.page.fill('.mp-name', player.name);
}

async function hostRoom(player, { rounds = 3 } = {}) {
  await openMenu(player);
  await player.page.selectOption('.mp-rounds', String(rounds));
  await player.page.click('.mp-create');
  await player.page.waitForSelector('.mp-lobby', { timeout: 10000 });
  player.code = (await player.page.textContent('.mp-code-value')).trim();
  return player.code;
}

async function joinRoom(player, code) {
  await openMenu(player);
  await player.page.fill('.mp-code-input', code);
  await player.page.click('.mp-join');
  await player.page.waitForSelector('.mp-lobby', { timeout: 10000 });
}

/** The board as the page renders it. */
const readBoard = (page) =>
  page.$$eval('.mp-board-row', (rows) =>
    rows.map((row) => ({
      rank: Number(row.querySelector('.mp-board-rank')?.textContent ?? '0'),
      name: row.querySelector('.mp-board-name')?.textContent?.trim() ?? '',
      score: Number((row.querySelector('.mp-board-score')?.textContent ?? '0').replace(/[^0-9]/g, '')),
      you: row.classList.contains('is-you'),
    })),
  );

/** The last totals the server sent in a `resolved` frame. */
const serverTotals = (page) =>
  page.evaluate(() => {
    const resolved = [...(window.__mpFrames ?? [])].reverse().find((frame) => frame.t === 'resolved');
    if (!resolved) return null;
    return resolved.results.map((result) => ({ name: result.name, score: result.totalScore }));
  });

/** Totals the server has acknowledged in `room` frames, in sorted order. */
const roomTotals = (page) =>
  page.evaluate(() => {
    const room = [...(window.__mpFrames ?? [])].reverse().find((frame) => frame.t === 'room');
    if (!room) return null;
    return [...room.room.players]
      .map((player) => ({ name: player.name, score: player.score }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  });

/** Answer correctly using the server's own view of the round's track. */
async function identifyRoundTrack(code, library) {
  const audio = await (await fetch(`${BASE}/api/multi/audio/${code}`)).arrayBuffer();
  const size = audio.byteLength;
  for (const track of library.tracks) {
    const head = await fetch(`${BASE}/api/audio/${track.id}`, { method: 'HEAD' });
    if (Number(head.headers.get('content-length')) === size) return track;
  }
  return null;
}

async function answer(player, title) {
  await player.page.fill('.field-input', title);
  await player.page.keyboard.press('Enter');
  await player.page.waitForSelector('.field.is-correct', { timeout: 10000 });
}

/** Wait for the round overlay to disappear: the next round has started. */
const waitForNextRound = (page) =>
  page.waitForFunction(() => document.querySelector('.reveal.is-results') === null, null, { timeout: 20000 });

/* ── The suite ──────────────────────────────────────────────────────── */

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  const server = await startServer();
  const library = await (await fetch(`${BASE}/api/library`)).json();
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });

  const language = new Set();

  try {
    /* ── The document itself ──────────────────────────────────────── */
    console.log('\nDocument\n');
    const document_ = await browser.newPage();
    await document_.goto(BASE, { waitUntil: 'domcontentloaded' });
    check('the page is declared French', (await document_.getAttribute('html', 'lang')) === 'fr');
    check('the title is French', /devine la chanson/i.test(await document_.title()), await document_.title());
    const description = await document_.getAttribute('meta[name="description"]', 'content');
    check('the description is French', !findEnglish(description ?? '').length, description ?? '(none)');

    /* ── Home ─────────────────────────────────────────────────────── */
    console.log('\nHome\n');
    await document_.waitForSelector('.home-title');
    await sleep(600);
    await document_.screenshot({ path: path.join(SHOTS, 'fr-01-home.png') });
    const homeText = await document_.evaluate(READ_CHROME);
    const homeEnglish = findEnglish(homeText);
    check('the home screen is French', homeEnglish.length === 0, homeEnglish.join(', '));
    check('the wordmark is French', /devine la chanson/i.test(await document_.textContent('.home-title')));
    check('the solo card is French', (await document_.textContent('.mode-card[data-mode="single"] .mode-card-label')).trim() === 'Solo');
    await document_.close();

    /* ── Menu, lobby, and the long French strings on a phone ──────── */
    console.log('\nMenu and lobby\n');
    const host = await newPlayer(browser, 'Arthur');
    await openMenu(host);
    await sleep(200);
    const menuText = await host.page.evaluate(READ_CHROME);
    const menuEnglish = findEnglish(menuText);
    check('the multiplayer menu is French', menuEnglish.length === 0, menuEnglish.join(', '));
    check('the create button is French', /créer la partie/i.test(await host.page.textContent('.mp-create')));
    check('the join button is French', /rejoindre/i.test(await host.page.textContent('.mp-join')));

    const phone = await newPlayer(browser, 'Margaux', { width: 375, height: 667 });
    await openMenu(phone);
    for (const viewport of [
      { width: 375, height: 667 },
      { width: 390, height: 844 },
      { width: 1366, height: 768 },
    ]) {
      await phone.page.setViewportSize(viewport);
      await sleep(250);
      const box = await phone.page.evaluate(BOXES, ['.mp-create', '.mp-join', '.mp-code-input']);
      const tag = `${viewport.width}x${viewport.height}`;
      check(`${tag}: the create button is reachable`, box['.mp-create'] && box['.mp-create'].bottom <= box.__viewport.height, JSON.stringify(box['.mp-create']));
      check(`${tag}: the join button is reachable`, box['.mp-join'] && box['.mp-join'].bottom <= box.__viewport.height, JSON.stringify(box['.mp-join']));
    }
    await phone.context.close();

    const code = await hostRoom(host);
    const guest = await newPlayer(browser, 'Bob');
    await joinRoom(guest, code);

    check('the room code is still the server’s', (await host.page.textContent('.mp-code-value')).trim() === code);

    /* The longest French copy in the product lives in the lobby. */
    for (const viewport of [
      { width: 375, height: 667 },
      { width: 390, height: 844 },
      { width: 1366, height: 768 },
      { width: 1440, height: 900 },
    ]) {
      await guest.page.setViewportSize(viewport);
      await sleep(250);
      const box = await guest.page.evaluate(BOXES, ['.mp-start', '.mp-lobby-actions', '.mp-modes', '.mp-settings']);
      const tag = `${viewport.width}x${viewport.height}`;
      check(`${tag}: the lobby fits without sideways scroll`, box.__scrollWidth <= viewport.width, `${box.__scrollWidth} > ${viewport.width}`);
      check(
        `${tag}: the lobby keeps its room code on screen`,
        box['.mp-settings'] && box['.mp-settings'].top >= 0 && box['.mp-settings'].top < viewport.height,
        JSON.stringify(box['.mp-settings']),
      );
    }
    await guest.page.setViewportSize({ width: 1280, height: 900 });

    const lobbyText = await guest.page.evaluate(READ_CHROME);
    const lobbyEnglish = findEnglish(lobbyText);
    check('the lobby is French', lobbyEnglish.length === 0, lobbyEnglish.join(', '));

    /* Attempt-mode hints are the longest strings the lobby has to hold. */
    const modeHints = await guest.page.$$eval('.mp-mode-hint', (nodes) => nodes.map((node) => node.textContent.trim()));
    check('the attempt modes are described in French', modeHints.every((hint) => !findEnglish(hint).length), modeHints.join(' | '));
    check(
      'the attempt-mode hints stay on one line each',
      (await guest.page.$$eval('.mp-mode', (nodes) => nodes.map((node) => node.scrollWidth <= node.clientWidth + 1))).every(Boolean),
    );
    await guest.page.screenshot({ path: path.join(SHOTS, 'fr-02-lobby.png') });

    /* ── Round one: the board must say nothing yet ────────────────── */
    console.log('\nStandings — before the first round resolves\n');
    await host.page.click('.mp-start');
    await host.page.waitForSelector('.mp-game');
    await guest.page.waitForSelector('.mp-game');
    await sleep(400);

    check('no standings are shown before a single round is played', (await host.page.locator('.mp-board-row').count()) === 0);
    check('the board says why', /après la première manche/i.test(await host.page.textContent('.mp-board-empty')));
    check('the board cannot be opened when there is nothing in it', await host.page.locator('.mp-board-head').isDisabled());
    check('the game screen is French', findEnglish(await host.page.evaluate(READ_CHROME)).length === 0);

    const track1 = await identifyRoundTrack(code, library);
    check('the tester identified the round’s song', Boolean(track1));

    const duringRound = await roomTotals(host.page);
    check(
      'the room view carries only completed-round totals',
      Boolean(duringRound) && duringRound.every((player) => player.score === 0),
      JSON.stringify(duringRound),
    );

    await answer(host, track1.title);
    await host.page.waitForSelector('.reveal.is-results', { timeout: ROUND_SECONDS * 1000 + 8000 });
    await sleep(500);

    /* ── After the first resolve ──────────────────────────────────── */
    console.log('\nStandings — after round one\n');
    const board1 = await readBoard(host.page);
    const totals1 = await serverTotals(host.page);
    check('the standings appear once a round has resolved', board1.length === 2, JSON.stringify(board1));
    check(
      'the standings match the totals the server sent',
      board1.every((row) => totals1.find((total) => total.name === row.name)?.score === row.score),
      `${JSON.stringify(board1)} vs ${JSON.stringify(totals1)}`,
    );
    check(
      'the standings are in the final scoreboard’s order',
      board1.every((row, index) => index === 0 || board1[index - 1].score >= row.score),
      JSON.stringify(board1.map((row) => row.score)),
    );
    check('your own row is marked', board1.some((row) => row.you));
    check('the standings are visible, not folded away', await host.page.locator('.mp-board-row:visible').count() === 2);

    await guest.page.waitForSelector('.reveal.is-results', { timeout: ROUND_SECONDS * 1000 + 12000 });
    const guestBoard = await readBoard(guest.page);
    check(
      'everyone sees the same standings',
      JSON.stringify(guestBoard.map((row) => `${row.name}:${row.score}`)) === JSON.stringify(board1.map((row) => `${row.name}:${row.score}`)),
      JSON.stringify(guestBoard),
    );

    /* ── Round two: the board must freeze while the round runs ────── */
    await waitForNextRound(host.page);
    await sleep(500);
    console.log('\nStandings — during round two\n');
    const frozen = await readBoard(host.page);
    check(
      'the standings do not move during a round',
      JSON.stringify(frozen.map((row) => row.score)) === JSON.stringify(board1.map((row) => row.score)),
      JSON.stringify(frozen),
    );
    check('no in-round points are invented', frozen.every((row) => Number.isFinite(row.score)));

    const track2 = await identifyRoundTrack(code, library);
    check('round two has its own song', track2 && track2.id !== track1.id);
    await answer(guest, track2.title);
    await guest.page.waitForSelector('.reveal.is-results', { timeout: ROUND_SECONDS * 1000 + 8000 });
    await sleep(500);

    const board2 = await readBoard(guest.page);
    const totals2 = await serverTotals(guest.page);
    const before2 = new Map(board1.map((row) => [row.name, row.score]));
    check(
      'the standings move after the second round',
      board2.some((row) => before2.get(row.name) !== row.score),
      JSON.stringify(board2),
    );
    check(
      'the standings still match the server’s totals',
      board2.every((row) => totals2.find((total) => total.name === row.name)?.score === row.score),
      `${JSON.stringify(board2)} vs ${JSON.stringify(totals2)}`,
    );

    /* ── The final board must be the same data ────────────────────── */
    console.log('\nStandings — the last round\n');
    /* Both players give up on the last song: it resolves at once, and the
       board behind the reveal is then the end-of-match ranking. The final
       screen has to reproduce it exactly. */
    const track3 = await identifyRoundTrack(code, library);
    check('the last round has its own song', Boolean(track3));
    await guest.page.click('.mp-giveup');
    await host.page.click('.mp-giveup');
    await host.page.waitForSelector('.reveal.is-results', { timeout: 12000 });
    await sleep(400);
    const liveBeforeEnd = await readBoard(host.page);
    await host.page.click('.mp-ready').catch(() => {});
    await host.page.waitForSelector('.mp-final', { timeout: 30000 });

    const finalRows = await host.page.$$eval('.mp-standing', (rows) =>
      rows.map((row) => ({
        name: row.querySelector('.mp-result-name')?.textContent?.trim() ?? '',
        score: Number((row.querySelector('.mp-result-points')?.textContent ?? '0').replace(/[^0-9]/g, '')),
      })),
    );
    check('the final scoreboard is still there', finalRows.length === 2, JSON.stringify(finalRows));
    check(
      'the final scoreboard is in the same order as the standings were',
      finalRows.every((row, index) => index === 0 || finalRows[index - 1].score >= row.score),
      JSON.stringify(finalRows.map((row) => row.score)),
    );
    check(
      'the live standings after the last round are the final scoreboard',
      JSON.stringify(finalRows.map((row) => `${row.name}:${row.score}`)) ===
        JSON.stringify(liveBeforeEnd.map((row) => `${row.name}:${row.score}`)),
      `${JSON.stringify(liveBeforeEnd)} vs ${JSON.stringify(finalRows)}`,
    );
    const roomAtEnd = await roomTotals(host.page);
    check(
      'the final scoreboard is the room’s own totals',
      Boolean(roomAtEnd) && finalRows.every((row) => roomAtEnd.find((total) => total.name === row.name)?.score === row.score),
      `${JSON.stringify(finalRows)} vs ${JSON.stringify(roomAtEnd)}`,
    );

    const finalText = await host.page.evaluate(READ_CHROME);
    check('the final screen is French', findEnglish(finalText).length === 0, findEnglish(finalText).join(', '));
    await host.page.screenshot({ path: path.join(SHOTS, 'fr-03-final.png') });

    /* ── A phone: the standings must not cost the game any room ───── */
    console.log('\nStandings on a phone\n');
    await host.context.close();
    await guest.context.close();

    const solo = await newPlayer(browser, 'Emma', { width: 390, height: 844 });
    const solo2 = await newPlayer(browser, 'Nils', { width: 390, height: 844 });
    const code2 = await hostRoom(solo);
    await joinRoom(solo2, code2);
    await solo.page.click('.mp-start');
    await solo.page.waitForSelector('.mp-game');
    await sleep(600);

    for (const viewport of [
      { width: 375, height: 667 },
      { width: 390, height: 844 },
      { width: 1366, height: 768 },
    ]) {
      await solo.page.setViewportSize(viewport);
      await sleep(250);
      const box = await solo.page.evaluate(BOXES, ['.mp-board', '.play', '.timeline', '.field-input', '.mp-reveal', '.mp-giveup']);
      const tag = `${viewport.width}x${viewport.height}`;
      const height = viewport.height;
      /* Either the board is a column beside the game (wide) or a line above
         it (phone) — never on top of it. */
      const board = box['.mp-board'];
      const timeline = box['.timeline'];
      check(
        `${tag}: the standings never overlap the play area`,
        Boolean(board && timeline) && (board.left >= timeline.right - 1 || board.bottom <= timeline.top + 1),
        JSON.stringify({ board, timeline }),
      );
      for (const selector of ['.play', '.timeline', '.field-input', '.mp-reveal', '.mp-giveup']) {
        check(
          `${tag}: ${selector} is still on screen`,
          box[selector] && box[selector].top >= 0 && box[selector].bottom <= height,
          JSON.stringify(box[selector]),
        );
      }
      check(`${tag}: nothing overflows sideways`, box.__scrollWidth <= viewport.width, `${box.__scrollWidth} > ${viewport.width}`);
    }
    await solo.page.setViewportSize({ width: 375, height: 667 });
    await sleep(200);
    await solo.page.screenshot({ path: path.join(SHOTS, 'fr-04-phone-board.png') });
    await solo.page.click('.mp-board-head');
    await sleep(300);
    const openBox = await solo.page.evaluate(BOXES, ['.mp-board-list', '.field-input', '.play']);
    check(
      'opening the standings pushes nothing off the screen',
      openBox['.field-input'] && openBox['.field-input'].bottom <= 667 && openBox['.play'].bottom <= 667,
      JSON.stringify(openBox),
    );
    await solo.page.screenshot({ path: path.join(SHOTS, 'fr-05-phone-board-open.png') });

    /* Every French string the multiplayer screens use, collected once. */
    for (const text of [homeText, menuText, lobbyText, finalText]) {
      for (const word of findEnglish(text)) language.add(word);
    }
    check('no English word survived the walkthrough', language.size === 0, [...language].join(', '));

    await solo.context.close();
    await solo2.context.close();

    /* ── Singleplayer, in French too ──────────────────────────────── */
    console.log('\nSingleplayer\n');
    const soloPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await soloPage.goto(BASE, { waitUntil: 'domcontentloaded' });
    await soloPage.waitForSelector('.home-title');
    await soloPage.click('.home-start');
    await soloPage.waitForSelector('.round');
    await sleep(300);
    const roundText = await soloPage.evaluate(READ_CHROME);
    check('the singleplayer round is French', findEnglish(roundText).length === 0, findEnglish(roundText).join(', '));
    check('the listen-more button says what it does', /écouter plus/i.test(await soloPage.textContent('.skip')), await soloPage.textContent('.skip'));
    check('the timeline shows a French decimal', (await soloPage.textContent('.duration-value')).trim() === '0,1');
    check('the play button is labelled in French', /écouter l’extrait/i.test(await soloPage.getAttribute('.play', 'aria-label')));

    await soloPage.click('.skip');
    await sleep(200);
    const rowText = await soloPage.textContent('.rows .row.is-skipped');
    check('a lengthened excerpt is not called a skip', !/skip/i.test(rowText), rowText.trim());
    check('the attempt row is French', !findEnglish(rowText).length, rowText.trim());
    await soloPage.screenshot({ path: path.join(SHOTS, 'fr-06-solo-round.png') });
    await soloPage.close();
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length) {
    console.log('\nFailed:');
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  }
  console.log(`\nScreenshots: ${SHOTS}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
