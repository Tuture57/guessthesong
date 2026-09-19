/**
 * Smoke test a *deployed* copy of the game.
 *
 *   node tools/prod-smoke.mjs https://gts.example.com
 *   npm run qa:production -- https://gts.example.com
 *
 * It drives two real browsers against the public URL and does what a player
 * does: loads the page, plays an excerpt, opens a room, has a second browser
 * join it, plays one round to its reveal and reads the standings. Nothing is
 * created that outlives the run — both players leave the room at the end, and
 * an abandoned room is swept by the server on its own.
 *
 * The one thing it cannot check from here is whether a device on a different
 * network can join: that needs a real second network. Everything up to and
 * including the WebSocket handshake is checked exactly as the internet sees it,
 * which is the part DNS, certificates and the hosting proxy get wrong.
 */
import { chromium } from 'playwright';

const target = process.argv[2] ?? process.env.GTS_PRODUCTION_URL;
if (!target) {
  console.error('\n  Usage: node tools/prod-smoke.mjs https://your-domain\n');
  process.exit(2);
}
const BASE = target.replace(/\/+$/, '');

const failures = [];
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) failures.push(name);
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Records the socket URLs the page opens, keeping the readyState constants. */
const SOCKET_URL_RECORDER = () => {
  window.__wsUrls = [];
  const Original = window.WebSocket;
  function Recorded(url, protocols) {
    window.__wsUrls.push(String(url));
    return new Original(url, protocols);
  }
  Recorded.prototype = Original.prototype;
  for (const constant of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    Object.defineProperty(Recorded, constant, { value: Original[constant] });
  }
  window.WebSocket = Recorded;
};

/** True as soon as an AudioBufferSourceNode is scheduled. */
const AUDIO_PROBE = () => {
  window.__played = 0;
  const proto = window.AudioBufferSourceNode && window.AudioBufferSourceNode.prototype;
  if (!proto) return;
  const original = proto.start;
  proto.start = function (...args) {
    window.__played += 1;
    return original.apply(this, args);
  };
};

/** `GTS_INSECURE_TLS=1` accepts a self-signed certificate (staging hosts). */
const INSECURE = process.env.GTS_INSECURE_TLS === '1';

/**
 * Wait for the page to schedule `min` audio sources.
 *
 * The app fetches a song's bytes and decodes them the first time it needs
 * them, and starts a decode-ahead at the beginning of each round. Locally that
 * is tens of milliseconds; from a deployed host it is a real download on a
 * cold connection (measured on Render: 82 ms to first byte, 296 ms to the
 * whole 1.6 MB body, 642 ms to decode ≈ 1.4 s total). A fixed sleep here was
 * simply wrong for anything that is not localhost — poll instead.
 */
async function waitForSources(page, min, timeoutMs = 25000) {
  const started = Date.now();
  for (;;) {
    const count = await page.evaluate(() => window.__played);
    const elapsed = Date.now() - started;
    if (count >= min || elapsed >= timeoutMs) return { ok: count >= min, count, seconds: elapsed / 1000 };
    await sleep(250);
  }
}

async function open(browser, name) {
  const context = await browser.newContext({ ignoreHTTPSErrors: INSECURE });
  const page = await context.newPage();
  await page.addInitScript(SOCKET_URL_RECORDER);
  await page.addInitScript(AUDIO_PROBE);
  page.on('pageerror', (error) => console.log(`  [${name}] pageerror: ${error.message}`));
  const response = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.home-title', { timeout: 30000 });
  return { context, page, name, status: response?.status() ?? 0 };
}

async function enterRoom(player, code) {
  await player.page.click('.mode-card[data-mode="multi"]');
  await player.page.waitForSelector('.mp-menu');
  await player.page.fill('.mp-name', player.name);
  if (code) {
    await player.page.fill('.mp-code-input', code);
    await player.page.click('.mp-join');
  } else {
    await player.page.click('.mp-create');
  }
  await player.page.waitForSelector('.mp-lobby', { timeout: 20000 });
  return (await player.page.textContent('.mp-code-value')).trim();
}

async function main() {
  console.log(`\nProduction smoke test against ${BASE}\n`);
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });

  try {
    /* ── The page as the internet sees it ─────────────────────────── */
    console.log('Page\n');
    const host = await open(browser, 'host');
    check('the site answers over HTTPS', host.status === 200, String(host.status));
    check('the document is French', (await host.page.getAttribute('html', 'lang')) === 'fr');
    check('the wordmark rendered', /devine la chanson/i.test(await host.page.textContent('.home-title')));

    const healthResponse = await host.page.request.get(`${BASE}/api/health`);
    check('the health endpoint answers', healthResponse.ok(), String(healthResponse.status()));
    const health = await healthResponse.json().catch(() => null);
    check('the server reports itself healthy', health?.ok === true, JSON.stringify(health));
    check('a version is published', typeof health?.version === 'string', health?.version);
    check('no filesystem path is published', !/[A-Za-z]:[\\/]|\/(home|srv|var|Users)\//.test(JSON.stringify(health)), JSON.stringify(health));

    const tracks = health?.library?.tracks ?? 0;
    check('the music library was indexed on the host', tracks > 0, `${tracks} tracks`);
    check('the library folder was found', health?.library?.ready === true);

    /* ── Singleplayer: the audio really plays ─────────────────────── */
    console.log('\nSingleplayer\n');
    if (tracks > 0) {
      await host.page.click('.home-start');
      await host.page.waitForSelector('.round', { timeout: 20000 });
      await sleep(400);
      await host.page.click('.play');
      const firstPlay = await waitForSources(host.page, 1);
      check('the first excerpt plays', firstPlay.ok, `${firstPlay.count} source(s) after ${firstPlay.seconds.toFixed(1)}s`);

      const first = (await host.page.textContent('.duration-value')).trim();
      await host.page.click('.skip');
      await sleep(300);
      const second = (await host.page.textContent('.duration-value')).trim();
      check('asking for more audio lengthens the excerpt', first === '0,1' && second !== first, `${first} -> ${second}`);
      check('the listen-more button is labelled clearly', /écouter plus/i.test(await host.page.textContent('.skip')));
      await host.page.click('.play');
      const secondPlay = await waitForSources(host.page, 2);
      check('the longer excerpt plays too', secondPlay.ok, `${secondPlay.count} source(s) after ${secondPlay.seconds.toFixed(1)}s`);
      await host.page.goBack().catch(() => {});
      await host.page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await host.page.waitForSelector('.home-title');
    } else {
      check('singleplayer was skipped (no tracks on the host)', false, 'upload songs first');
    }

    /* ── Two players, one room ────────────────────────────────────── */
    console.log('\nMultiplayer\n');
    const code = await enterRoom(host, null);
    check('a room can be created', /^[A-Z0-9]{5}$/.test(code), code);

    const guest = await open(browser, 'guest');
    const guestCode = await enterRoom(guest, code);
    check('a second player can join the same room', guestCode === code, guestCode);

    const socketUrl = await host.page.evaluate(() => window.__wsUrls[0] ?? null);
    check('the socket uses the page’s own origin', socketUrl === `${BASE.replace(/^http/, 'ws')}/ws`, String(socketUrl));
    check('the socket is encrypted', String(socketUrl).startsWith('wss://'), String(socketUrl));

    await guest.page.waitForFunction(() => document.querySelectorAll('.mp-player').length === 2, null, { timeout: 8000 });
    check('both players are listed for both players', (await host.page.locator('.mp-player').count()) === 2);
    check('the room code is the same on both screens', (await guest.page.textContent('.mp-code-value')).trim() === code);

    // A guest's change must not take: the server is the authority.
    await guest.page.click('.mp-modes .mp-mode[data-mode="single"]').catch(() => {});
    await sleep(300);
    check(
      'a guest cannot change the room settings',
      (await host.page.getAttribute('.mp-modes .mp-mode[data-mode="single"]', 'aria-pressed')) !== 'true',
    );

    // The host's change must reach everyone.
    await host.page.click('.mp-chips .mp-chip[data-seconds="30"]');
    const synced = await guest.page
      .waitForFunction(() => document.querySelector('.mp-chips .mp-chip[data-seconds="30"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    check('the host’s settings reach the other player', synced);

    await host.page.click('.mp-start');
    await host.page.waitForSelector('.mp-game', { timeout: 20000 });
    await guest.page.waitForSelector('.mp-game', { timeout: 20000 });
    check('the round starts for both players', true);

    const sameSong = await Promise.all(
      [host, guest].map((player) => player.page.evaluate(() => document.querySelector('.mp-attempt-rows') !== null)),
    );
    check('both players get a playable round', sameSong.every(Boolean));
    check('the standings are not shown before a round resolves', (await host.page.locator('.mp-board-row:visible').count()) === 0);

    await host.page.click('.play');
    const roomPlay = await waitForSources(host.page, 1);
    check('the room’s clip plays', roomPlay.ok, `${roomPlay.count} source(s) after ${roomPlay.seconds.toFixed(1)}s`);

    /* Both give up so the round resolves at once, whatever the room’s timer. */
    await guest.page.click('.mp-giveup');
    await host.page.click('.mp-giveup');
    const revealed = await host.page
      .waitForSelector('.reveal.is-results', { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    check('the round resolves and the answer is revealed', revealed);
    if (revealed) {
      check('the title is shown in French chrome', /manche/i.test(await host.page.textContent('.reveal-kicker')));
      await sleep(600);
      const rows = await host.page.locator('.mp-board-row:visible').count();
      check('the standings appear once a round has resolved', rows === 2, `${rows} rows`);
    }

    /* ── A player closes the tab ──────────────────────────────────── */
    /*
     * Mid-game there is no "leave" button — the real thing a player does is
     * close the tab. The room has to carry on for whoever is left, and the
     * empty seat has to come back if they return.
     */
    console.log('\nDisconnect\n');
    await guest.context.close();
    await sleep(1500);
    check('the room survives a player closing the tab', (await host.page.locator('.mp-status-item').count()) === 2);
    check('the game is still on screen for the player who stayed', (await host.page.locator('.mp-game').count()) === 1);

    /*
     * A dropped socket is noticed by the platform's proxy, not instantly: an
     * abruptly closed tab took ~10 s to surface through Render's edge, against
     * well under a second on localhost. Poll rather than pick a sleep.
     */
    const closedAt = Date.now();
    let gone = false;
    for (let i = 0; i < 70 && !gone; i += 1) {
      await sleep(500);
      const status = await host.page.locator('.mp-status').innerText().catch(() => '');
      gone = /déconnecté/i.test(status);
    }
    check('the player who left is shown as gone', gone, `${((Date.now() - closedAt) / 1000).toFixed(1)}s to notice`);

    const rejoined = await browser.newContext({ ignoreHTTPSErrors: INSECURE });
    const backPage = await rejoined.newPage();
    await backPage.goto(BASE, { waitUntil: 'domcontentloaded' });
    await sleep(500);
    check('nothing was left on the server that blocks a fresh visit', (await backPage.locator('.home-title').count()) === 1);
    await rejoined.close();

    await host.context.close();
  } finally {
    await browser.close();
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length) {
    console.log('\nFailed:');
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  }
  console.log('\nNot covered here (needs a second network or the hosting panel):');
  console.log('  - joining from a device on another network');
  console.log('  - a real platform restart mid-game');
  console.log('  - logs, environment variables and the run folder in the Manager\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
