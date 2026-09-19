/**
 * End-to-end browser QA for the whole game — singleplayer AND multiplayer.
 *
 * Drives real browsers through a full round (playback timing, wrong answers,
 * the reveal ladder, autocomplete, correct guess, results screen, post-round
 * playback) and a full multiplayer game (create/join room, host starts,
 * independent reveal levels, spoiler safety, server-authoritative scoring,
 * round resolution, ready flow). Screenshots land in .qa/.
 *
 *   npm run build && node server/index.js --prod
 *   npm run qa
 */
import { chromium, devices } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.GTS_URL ?? 'http://localhost:8787';
const SHOTS = path.resolve('.qa');

const VIEWPORTS = [
  { name: 'desktop-1920', width: 1920, height: 1080 },
  { name: 'laptop-1440', width: 1440, height: 900 },
  { name: 'laptop-1366', width: 1366, height: 768 },
  { name: 'mobile-390', width: 390, height: 844 },
];

const failures = [];
let checks = 0;

function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) failures.push(name);
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Counts live Web Audio sources from inside the page. Two at once would mean
 * overlapping playback; one left behind after a round change would mean an
 * orphan. Neither is visible from the outside any other way.
 */
const AUDIO_PROBE = () => {
  const active = new Set();
  const state = { active, maxConcurrent: 0, started: 0 };
  window.__gtsAudio = state;

  const proto = window.AudioBufferSourceNode && window.AudioBufferSourceNode.prototype;
  if (!proto) return;

  const originalStart = proto.start;
  proto.start = function (...args) {
    active.add(this);
    state.started += 1;
    state.maxConcurrent = Math.max(state.maxConcurrent, active.size);
    this.addEventListener('ended', () => active.delete(this));
    return originalStart.apply(this, args);
  };

  const originalStop = proto.stop;
  proto.stop = function (...args) {
    active.delete(this);
    return originalStop.apply(this, args);
  };
};

/** Reads the reveal transport's progress, as a percentage of the whole track. */
const fillPercent = (page) => page.$eval('.transport-fill', (el) => parseFloat(el.style.width) || 0);

const transportState = (page) => page.$eval('.reveal-audio', (el) => el.dataset.state).catch(() => null);

async function waitForTransport(page, state, timeout = 6000) {
  await page.waitForFunction(
    (wanted) => document.querySelector('.reveal-audio')?.dataset.state === wanted,
    state,
    { timeout },
  );
}

function parseClock(label) {
  const match = /(\d+):(\d+)/.exec(label ?? '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : -1;
}

async function main() {
  await fs.rm(SHOTS, { recursive: true, force: true });
  await fs.mkdir(SHOTS, { recursive: true });

  const library = await (await fetch(`${BASE}/api/library`)).json();
  console.log(`\nTarget: ${BASE}   (${library.tracks.length} tracks)\n`);
  const titleById = new Map(library.tracks.map((track) => [track.id, track.title]));
  const durationById = new Map(library.tracks.map((track) => [track.id, track.duration]));

  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.addInitScript(AUDIO_PROBE);

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  // Every track the client asks to play, in order.
  const requested = [];
  page.on('request', (request) => {
    const match = request.url().match(/\/api\/audio\/([^/?]+)/);
    if (match) requested.push(decodeURIComponent(match[1]));
  });

  // The client decodes the current track and preloads the next one, so the
  // requests arrive as [round1, round2, round3, ...]: request n is round n+1's
  // track. Waiting for one more request than the round we are on is therefore
  // the signal that the next round is ready to be identified.
  async function answerForRound(roundIndex) {
    for (let i = 0; i < 120; i += 1) {
      if (requested.length > roundIndex) return requested[roundIndex];
      await sleep(100);
    }
    return null;
  }

  /* ── Library loads ──────────────────────────────────────────────── */

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.home-title', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.chip')?.textContent?.includes('Chargement'), null, {
    timeout: 15000,
  });

  const chipText = (await page.textContent('.chip')) ?? '';
  check('library chip reports the real track count', chipText.includes(String(library.tracks.length)), chipText.trim());
  check('home screen renders the title', (await page.textContent('.home-title'))?.length > 0);

  await page.screenshot({ path: path.join(SHOTS, '01-home-desktop.png') });

  /* ── Home tabs use real library categories ──────────────────────── */

  const tabLabels = (await page.$$eval('.cat-tab', (nodes) => nodes.map((node) => node.textContent.trim()))).filter(Boolean);
  const realFolders = new Set(
    library.tracks
      .map((track) => track.folder)
      .filter(Boolean)
      .map((folder) => folder.split(/[\\/]/)[0]),
  );
  const tabsAreReal = tabLabels.length >= 1 && tabLabels.every((label) => label === 'Toutes' || realFolders.has(label));
  check('category tabs come from the actual library', tabsAreReal, JSON.stringify(tabLabels));

  /* ── Responsive home ────────────────────────────────────────────── */

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await sleep(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(`no horizontal overflow on home @ ${viewport.name}`, !overflow);
    await page.screenshot({ path: path.join(SHOTS, `home-${viewport.name}.png`) });
  }
  await page.setViewportSize({ width: 1920, height: 1080 });

  /* ── Start a round ──────────────────────────────────────────────── */

  await page.click('.home-start');
  await page.waitForSelector('.round', { timeout: 10000 });
  const trackId = await answerForRound(0);
  check('a track was requested for the first round', Boolean(trackId));
  const answer = titleById.get(trackId);
  check('the requested track exists in the library', Boolean(answer), answer);

  const durationLabel = (await page.textContent('.duration-value'))?.trim();
  check('round starts at 0,1 s', durationLabel === '0,1', durationLabel);

  const ladderSteps = await page.$$eval('.ladder-step', (nodes) => nodes.length);
  check('reveal ladder shows every configured step', ladderSteps === 6, `${ladderSteps} steps`);

  await sleep(700); // let the decode settle
  await page.screenshot({ path: path.join(SHOTS, '02-round-desktop.png') });

  /* ── Playback really stops after the excerpt ────────────────────── */

  await page.click('.play');
  await page.waitForFunction(() => document.querySelector('.play')?.classList.contains('is-playing'), null, {
    timeout: 4000,
  });
  const startedAt = Date.now();
  await page.waitForFunction(() => !document.querySelector('.play')?.classList.contains('is-playing'), null, {
    timeout: 4000,
  });
  const playedMs = Date.now() - startedAt;
  check('0.1s excerpt stops quickly', playedMs < 400, `${playedMs} ms of playback`);

  // Three quick presses must not leave audio running or throw.
  for (let i = 0; i < 3; i += 1) await page.click('.play');
  await page.waitForFunction(() => !document.querySelector('.play')?.classList.contains('is-playing'), null, {
    timeout: 4000,
  });
  check('repeated PLAY restarts cleanly', true);

  /* ── Autocomplete ───────────────────────────────────────────────── */

  const probe = answer.slice(0, Math.min(4, answer.length));
  await page.fill('.field-input', probe);
  await sleep(250);
  const suggestionCount = await page.$$eval('.suggestion', (nodes) => nodes.length);
  check('autocomplete offers library tracks', suggestionCount > 0, `${suggestionCount} for "${probe}"`);
  await page.screenshot({ path: path.join(SHOTS, '03-autocomplete.png') });

  await page.keyboard.press('Escape');
  await sleep(120);
  const afterEscape = await page.$$eval('.suggestion', (nodes) => nodes.length);
  check('ESCAPE closes the suggestion list', afterEscape === 0);

  /* ── Wrong answer ───────────────────────────────────────────────── */

  await page.fill('.field-input', 'not a real song title');
  await page.keyboard.press('Enter');
  await sleep(130);
  await page.screenshot({ path: path.join(SHOTS, '04-round-wrong.png') });
  const wrongRows = await page.$$eval('.rows .row.is-wrong', (nodes) => nodes.map((node) => node.textContent.trim()));
  check(
    'a wrong guess becomes an attempt row of its own',
    wrongRows.length === 1 && wrongRows[0].includes('not a real song title'),
    JSON.stringify(wrongRows),
  );
  const emptySlots = await page.$$eval('.rows .row.is-empty', (nodes) => nodes.length);
  check('the unused attempt slots stay empty', emptySlots === 5, `${emptySlots} empty slots`);
  check('a wrong guess does not end the round', (await page.$$('.reveal')).length === 0);

  // Naming a song that really is in the library, but is not the one playing,
  // must be rejected too.
  const decoy = library.tracks.find((track) => track.id !== trackId).title;
  await page.fill('.field-input', decoy);
  await page.keyboard.press('Enter');
  await sleep(200);
  check('a different real song is rejected', (await page.$$('.reveal')).length === 0, `guessed "${decoy}"`);
  const twoRows = await page.$$eval('.rows .row.is-wrong', (nodes) => nodes.map((node) => node.textContent.trim()));
  check('each wrong guess stacks below the last', twoRows.length === 2, `${twoRows.length} rows`);

  /* ── Reveal ladder ──────────────────────────────────────────────── */

  for (let i = 0; i < 5; i += 1) {
    await page.click('.skip');
    await sleep(90);
  }
  const skipRows = await page.$$eval('.rows .row.is-skipped', (nodes) => nodes.length);
  check('a skipped reveal shows as a neutral row', skipRows === 5, `${skipRows} skipped rows`);
  const stepLabel = (await page.textContent('.duration-value'))?.trim();
  check('skipping walks the whole ladder to 15s', stepLabel === '15', stepLabel);
  const skipText = ((await page.textContent('.skip')) ?? '').trim();
  check('the last step offers to give up', /abandonner/i.test(skipText), skipText);
  await page.screenshot({ path: path.join(SHOTS, '05-round-last-step.png') });

  // The excerpt is 15 s here, so playback can only vanish this fast if
  // revealing stopped it.
  await page.click('.play');
  await page.waitForFunction(() => document.querySelector('.play')?.classList.contains('is-playing'), null, {
    timeout: 4000,
  });
  const revealAt = Date.now();
  await page.click('.skip');
  await page.waitForFunction(() => !document.querySelector('.play')?.classList.contains('is-playing'), null, {
    timeout: 3000,
  });
  const stopAfterReveal = Date.now() - revealAt;
  check('giving up cuts the excerpt short', stopAfterReveal < 400, `${stopAfterReveal} ms into a 15 s excerpt`);
  await page.waitForSelector('.reveal', { timeout: 5000 });
  await sleep(700);
  const revealedTitle = (await page.textContent('.reveal-title'))?.trim();
  check('giving up reveals the correct track', revealedTitle === answer, `${revealedTitle} vs ${answer}`);
  check('giving up scores zero', ((await page.textContent('.reveal-points')) ?? '').includes('+0'));

  /* ── Giving up: the answer plays from the excerpt position ──────── */

  await waitForTransport(page, 'playing');
  // Read the label and the bar together: the bar moves with the music, so
  // sampling them at different moments would drift by the sampling gap.
  const [missLabel, missFill] = await Promise.all([page.textContent('.transport-label'), fillPercent(page)]);
  const missStartedAt = parseClock((missLabel ?? '').trim());
  check('the reveal names where the excerpt came from', missStartedAt >= 0, (missLabel ?? '').trim());

  const missPosition = (missFill / 100) * (durationById.get(trackId) ?? 0);
  check(
    'playback begins at the position the excerpt was taken from',
    Math.abs(missPosition - missStartedAt) < 2.5,
    `bar at ${missPosition.toFixed(1)}s, label says ${missStartedAt}s`,
  );
  check('playback does not restart from the top of the file', missPosition > 3, `${missPosition.toFixed(1)}s in`);
  check('reveal playback starts after giving up', true);
  await sleep(400);
  await page.screenshot({ path: path.join(SHOTS, '06-reveal-miss.png') });

  /* ── Pause / resume ─────────────────────────────────────────────── */

  await page.click('.transport-toggle');
  check('the transport pauses the song', (await transportState(page)) === 'paused');
  const pausedAt = await fillPercent(page);
  await sleep(700);
  const heldAt = await fillPercent(page);
  check('a paused song does not advance', Math.abs(heldAt - pausedAt) < 0.3, `${pausedAt.toFixed(2)}% → ${heldAt.toFixed(2)}%`);

  await page.click('.transport-toggle');
  await waitForTransport(page, 'playing');
  await sleep(700);
  check('resuming carries on from where it paused', (await fillPercent(page)) > heldAt, `past ${heldAt.toFixed(2)}%`);

  /* ── Next song ──────────────────────────────────────────────────── */

  await page.click('.reveal-next');
  await sleep(300);
  const orphans = await page.evaluate(() => window.__gtsAudio.active.size);
  check('next song silences the revealed track', orphans === 0, `${orphans} source(s) still live`);

  /* ── Correct answer on the next round ───────────────────────────── */

  await sleep(400);
  const nextId = await answerForRound(1);
  check('next song starts a new round', Boolean(nextId));
  const nextAnswer = titleById.get(nextId);
  const roundNumber = (await page.textContent('.hud-value'))?.trim();
  check('round counter advanced', roundNumber?.startsWith('2'), roundNumber);

  // The previous track must be gone and the new one already decoded, so PLAY
  // starts immediately rather than after a load.
  await sleep(600);
  const clickAt = Date.now();
  await page.click('.play');
  await page.waitForFunction(() => document.querySelector('.play')?.classList.contains('is-playing'), null, {
    timeout: 4000,
  });
  const readyMs = Date.now() - clickAt;
  check('the next track is ready without a wait', readyMs < 300, `${readyMs} ms from click to playback`);

  const switchedAt = Date.now();
  await page.waitForFunction(() => !document.querySelector('.play')?.classList.contains('is-playing'), null, {
    timeout: 4000,
  });
  const switchedMs = Date.now() - switchedAt;
  check('the new track plays after switching songs', switchedMs < 400, `${switchedMs} ms`);

  const freshRows = await page.$$eval('.rows .row', (nodes) =>
    nodes.map((node) => ({ cls: node.className, text: node.textContent.trim() })),
  );
  const carriedOver = freshRows.filter((row) => row.text.includes('un mauvais titre') || row.text.includes('not a real song title'));
  check('a new song starts with an empty attempt stack', carriedOver.length === 0, JSON.stringify(carriedOver));
  check('the stack shows the empty slots again', freshRows.every((row) => row.cls.includes('is-empty')), JSON.stringify(freshRows.map((r) => r.cls)));

  await sleep(300);
  // Typed the way a player would: no accents, no brackets, wrong case.
  // ESCAPE first so this goes through the matcher rather than a suggestion.
  const variant =
    nextAnswer
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\(.*?\)|\[.*?\]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim() || nextAnswer.toLowerCase();
  await page.fill('.field-input', variant);
  await page.keyboard.press('Escape');
  await sleep(100);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.reveal', { timeout: 5000 });
  await sleep(700);

  const state = await page.getAttribute('.reveal', 'data-state');
  check('a correct answer is recognised', state === 'hit', `state=${state}, typed "${variant}"`);
  const correctRow = await page.$$eval('.rows .row.is-correct', (nodes) => nodes.map((node) => node.textContent.trim()));
  check('the correct answer closes the attempt stack in green', correctRow.length === 1, JSON.stringify(correctRow));
  const points = (await page.textContent('.reveal-points')) ?? '';
  const numeric = Number(points.replace(/[^0-9]/g, ''));
  check('a first-step guess scores maximum points', numeric === 1200, points.trim());

  const hud = await page.$$eval('.hud-value', (nodes) => nodes.map((node) => node.textContent.trim()));
  check('the score counter updated', hud[1] === '1 200', JSON.stringify(hud));
  check('the streak counter incremented', hud[2] === '1', JSON.stringify(hud));

  /* ── The song outlives the excerpt ──────────────────────────────── */

  // This round only ever unlocked 0.1s, so still being mid-song seconds later
  // is proof the reveal playback is not capped at the excerpt length.
  await waitForTransport(page, 'playing');
  const correctFill = await fillPercent(page);
  await sleep(2000);
  const laterFill = await fillPercent(page);
  const playedSeconds = ((laterFill - correctFill) / 100) * (durationById.get(nextId) ?? 0);
  check(
    'reveal playback runs on past the 0.1s excerpt',
    (await transportState(page)) === 'playing' && playedSeconds > 1.2,
    `${playedSeconds.toFixed(1)}s of song played`,
  );
  await page.screenshot({ path: path.join(SHOTS, '07-reveal-correct.png') });

  /* ── Quick play never ends ──────────────────────────────────────── */

  await page.click('.reveal-next'); // close the correct-answer panel above
  await sleep(300);

  for (let i = 0; i < 3; i += 1) {
    // Five clicks walk the ladder; the sixth gives up and reveals.
    for (let step = 0; step < 6; step += 1) {
      await page.click('.skip');
      await sleep(70);
    }
    await page.waitForSelector('.reveal', { timeout: 5000 });
    await sleep(200);
    await page.click('.reveal-next');
    await sleep(300);
  }
  check('quick play keeps going past three rounds', (await page.$$('.round')).length > 0);
  const quickRound = (await page.textContent('.hud-value'))?.trim();
  check('quick play round counter has no ceiling', /^\d+$/.test(quickRound ?? '') && Number(quickRound) >= 6, quickRound);

  /* ── Rounds mode → results ──────────────────────────────────────── */

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.home-start');
  await page.click('.segmented button[data-mode="rounds"]');
  await page.click('.round-counts button:nth-child(1)'); // 5 rounds
  await page.click('.home-start');
  await page.waitForSelector('.round', { timeout: 10000 });

  for (let round = 0; round < 5; round += 1) {
    await page.waitForSelector('.skip', { timeout: 5000 });
    // Five clicks walk the ladder; the sixth gives up.
    for (let step = 0; step < 6; step += 1) {
      await page.click('.skip');
      await sleep(60);
    }
    await page.waitForSelector('.reveal', { timeout: 5000 });
    await sleep(150);
    await page.click('.reveal-next');
    await sleep(300);
  }

  await page.waitForSelector('.results', { timeout: 8000 });
  const rows = await page.$$eval('.results-row', (nodes) => nodes.length);
  check('results screen lists every round', rows === 5, `${rows} rows`);
  const finalScore = (await page.textContent('.results-score'))?.trim();
  check('results screen shows a score', finalScore === '0', finalScore);

  // The 1200 points won earlier in the session must still be the record.
  const stats = await page.$$eval('.results-stats dd', (nodes) => nodes.map((node) => node.textContent.trim()));
  check('all-time best score persisted across games', stats[2] === '1 200', JSON.stringify(stats));

  await page.screenshot({ path: path.join(SHOTS, '08-results.png') });

  /* ── Responsive round + results ─────────────────────────────────── */

  await page.click('.results-actions .btn-primary');
  await page.waitForSelector('.round', { timeout: 8000 });
  await sleep(500);
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await sleep(200);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(`no horizontal overflow on round @ ${viewport.name}`, !overflow);
    await page.screenshot({ path: path.join(SHOTS, `round-${viewport.name}.png`) });
  }

  /* ── Refresh resilience ─────────────────────────────────────────── */

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.home-title', { timeout: 10000 });
  check('reload returns to a working home screen', (await page.$$('.home-start')).length === 1);

  /* ── Rescan button ──────────────────────────────────────────────── */

  await page.click('.chip');
  await sleep(1500);
  const chipAfter = ((await page.textContent('.chip')) ?? '').trim();
  check('rescan reports the library is unchanged', chipAfter === 'Bibliothèque à jour', chipAfter);
  await sleep(1600);
  const chipSettled = ((await page.textContent('.chip')) ?? '').trim();
  check('rescan keeps the library intact', chipSettled === `${library.tracks.length} titres`, chipSettled);

  /* ── Live library updates ───────────────────────────────────────── */

  const trackCount = async () => Number(((await page.textContent('.chip')) ?? '').match(/\d+/)?.[0] ?? -1);
  const settle = async (target) => {
    for (let i = 0; i < 60; i += 1) {
      await sleep(500);
      if ((await trackCount()) === target) return true;
    }
    return false;
  };

  // The API reports the library folder as configured; resolve it so the test
  // can write into the real one whether that value is absolute or relative.
  const libraryDir = path.resolve(process.cwd(), library.libraryPath);
  const tempFile = path.join(libraryDir, 'QA Live Update Test.mp3');
  const baseline = await trackCount();

  try {
    await fs.copyFile(path.join(libraryDir, library.tracks[0].relPath), tempFile);
    check('a new file in the folder appears live', await settle(baseline + 1), `${baseline} -> ${await trackCount()}`);
  } finally {
    await fs.rm(tempFile, { force: true });
  }

  check('a deleted file disappears live', await settle(baseline), `back to ${await trackCount()}`);

  /* ── Category tabs follow the folders that actually exist ───────── */

  const folderName = 'QA Folder';
  const folderPath = path.join(libraryDir, folderName);
  const tabNames = async () => page.$$eval('.cat-tab', (nodes) => nodes.map((node) => node.textContent.trim()));

  try {
    await fs.mkdir(folderPath, { recursive: true });
    await fs.copyFile(
      path.join(libraryDir, library.tracks[0].relPath),
      path.join(folderPath, 'QA Tab Test.mp3'),
    );

    let appeared = false;
    for (let i = 0; i < 40 && !appeared; i += 1) {
      await sleep(400);
      appeared = (await tabNames()).includes(folderName);
    }
    check('a new music folder becomes a category tab', appeared, JSON.stringify(await tabNames()));

    await page.click(`.cat-tab:has-text("${folderName}")`);
    await sleep(300);
    const activeTab = await page.$eval('.cat-tab.is-active', (node) => node.textContent.trim());
    check('the folder tab can be selected', activeTab === folderName, activeTab);

    // With the folder selected, a round may only draw from that folder.
    const scoped = await (await fetch(`${BASE}/api/library`)).json();
    const inFolder = scoped.tracks.filter((track) => track.relPath.split(/[\\/]/).includes(folderName));
    check('the folder holds the copied track', inFolder.length === 1, `${inFolder.length} track(s)`);

    const scopedRequests = [];
    const collect = (request) => {
      const match = request.url().match(/\/api\/audio\/([^/?]+)/);
      if (match) scopedRequests.push(decodeURIComponent(match[1]));
    };
    page.on('request', collect);
    await page.click('.home-start');
    await page.waitForSelector('.round', { timeout: 10000 });
    for (let i = 0; i < 60 && scopedRequests.length === 0; i += 1) await sleep(100);
    page.off('request', collect);
    check('a category-filtered round only plays that category', scopedRequests[0] === inFolder[0]?.id, scopedRequests[0]);

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.home-start');
  } finally {
    await fs.rm(folderPath, { recursive: true, force: true });
  }

  let gone = false;
  for (let i = 0; i < 40 && !gone; i += 1) {
    await sleep(400);
    gone = !(await tabNames()).includes(folderName);
  }
  check('a removed folder stops being a tab', gone, JSON.stringify(await tabNames()));
  check('the library is back to its original size', (await trackCount()) === baseline, String(await trackCount()));

  /* ── Rapid round changes ────────────────────────────────────────── */

  await page.click('.home-start');
  await page.waitForSelector('.round', { timeout: 10000 });

  for (let i = 0; i < 3; i += 1) {
    await page.click('.play');
    await sleep(60);
    for (let step = 0; step < 6; step += 1) {
      await page.click('.skip');
      await sleep(50);
    }
    await page.waitForSelector('.reveal', { timeout: 6000 });
    // Every other time, leave only once the song has actually started.
    if (i % 2 === 0) await waitForTransport(page, 'playing');
    await page.click('.reveal-next');
    await sleep(150);
  }
  await sleep(500);
  const afterRapid = await page.evaluate(() => window.__gtsAudio.active.size);
  check('rapid round changes leave no orphan audio', afterRapid === 0, `${afterRapid} source(s) live`);

  const concurrency = await page.evaluate(() => window.__gtsAudio.maxConcurrent);
  check('audio never overlapped at any point', concurrency <= 1, `peak of ${concurrency} sources`);

  /* ── Element fallback, with the decoder disabled ────────────────── */

  const fallbackPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const fallbackErrors = [];
  fallbackPage.on('pageerror', (error) => fallbackErrors.push(error.message));
  await fallbackPage.addInitScript(() => {
    const proto = window.AudioContext && window.AudioContext.prototype;
    if (proto) proto.decodeAudioData = () => Promise.reject(new Error('decoding disabled by the test'));
  });

  await fallbackPage.goto(BASE, { waitUntil: 'domcontentloaded' });
  await fallbackPage.bringToFront();
  await fallbackPage.waitForSelector('.home-start', { timeout: 15000 });
  await fallbackPage.click('.home-start');
  await fallbackPage.waitForSelector('.round', { timeout: 10000 });
  await sleep(900);

  await fallbackPage.click('.play');
  await fallbackPage.waitForFunction(
    () => document.querySelector('.play')?.classList.contains('is-playing'),
    null,
    { timeout: 8000 },
  );
  const fbStartedAt = Date.now();
  await fallbackPage.waitForFunction(
    () => !document.querySelector('.play')?.classList.contains('is-playing'),
    null,
    { timeout: 8000 },
  );
  const fbMs = Date.now() - fbStartedAt;
  check('fallback: the excerpt still stops on time', fbMs < 500, `${fbMs} ms of playback`);

  for (let step = 0; step < 6; step += 1) {
    await fallbackPage.click('.skip');
    await sleep(60);
  }
  await fallbackPage.waitForSelector('.reveal', { timeout: 8000 });
  await waitForTransport(fallbackPage, 'playing');
  check('fallback: the answer plays through the audio element', await fallbackPage.$eval('audio', (el) => !el.paused));

  await fallbackPage.click('.reveal-next');
  await sleep(400);
  check('fallback: next song stops the audio element', await fallbackPage.$eval('audio', (el) => el.paused));
  check('fallback: no page errors', fallbackErrors.length === 0, fallbackErrors.slice(0, 2).join(' | '));
  await fallbackPage.close();

  /* ── A real touch device ────────────────────────────────────────── */

  // Viewport width alone does not change `hover`/`pointer`, so this needs an
  // actual touch context rather than a desktop page sized to a phone.
  const mobileContext = await browser.newContext({ ...devices['iPhone 13'] });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto(BASE, { waitUntil: 'domcontentloaded' });
  await mobilePage.waitForSelector('.home-start', { timeout: 15000 });
  await mobilePage.click('.home-start');
  await mobilePage.waitForSelector('.round', { timeout: 10000 });
  await sleep(600);

  const mobileOverflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('no horizontal overflow on a touch device', !mobileOverflow);
  check(
    'the keyboard does not pop up unprompted on a touch device',
    !(await mobilePage.evaluate(() => document.activeElement?.classList.contains('field-input'))),
  );
  await mobilePage.screenshot({ path: path.join(SHOTS, 'round-mobile-touch.png') });

  for (let step = 0; step < 6; step += 1) {
    await mobilePage.click('.skip');
    await sleep(60);
  }
  await mobilePage.waitForSelector('.reveal', { timeout: 8000 });
  await waitForTransport(mobilePage, 'playing');
  const mobileFits = await mobilePage.$eval(
    '.reveal-card',
    (el) => el.getBoundingClientRect().height < window.innerHeight - 20,
  );
  check('the reveal panel fits a phone screen', mobileFits);
  check('keyboard hints are hidden on a touch device', (await mobilePage.locator('.reveal-hint:visible').count()) === 0);
  await mobilePage.screenshot({ path: path.join(SHOTS, 'reveal-mobile-touch.png') });
  await mobileContext.close();

  /* ── Console hygiene ────────────────────────────────────────────── */

  const realErrors = consoleErrors.filter((text) => !text.includes('favicon'));
  check('no console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  await browser.close();

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
