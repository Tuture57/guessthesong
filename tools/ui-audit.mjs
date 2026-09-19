/**
 * Visual audit: walks every screen at every target viewport, measures the
 * layout, and writes screenshots to .audit/.
 *
 * Measurements are the point — "does the search field fit on a 1366x768
 * laptop" should be answered with a number, not an opinion.
 *
 *   node server/index.js --prod
 *   node tools/ui-audit.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.GTS_URL ?? 'http://localhost:8792';
const OUT = path.resolve('.audit');

const VIEWPORTS = [
  { name: '2560x1440', width: 2560, height: 1440 },
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '430x932', width: 430, height: 932 },
  { name: '390x844', width: 390, height: 844 },
  { name: '375x667', width: 375, height: 667 },
  { name: '360x800', width: 360, height: 800 },
  { name: 'shortscreen-1366x600', width: 1366, height: 600 },
];

/** The bits of each screen that must be reachable without scrolling. */
const CRITICAL = {
  'sp-round': ['.hud', '.rows', '.timeline', '.play', '.field-input', '.skip'],
  'sp-reveal': ['.reveal-card', '.reveal-next'],
  'mp-menu': ['.mp-name', '.mp-create', '.mp-join'],
  'mp-lobby': ['.mp-code-value', '.mp-players', '.mp-settings', '.mp-start'],
  'mp-game': ['.hud', '.mp-status', '.mp-board', '.mp-attempt-rows', '.timeline', '.play', '.field-input', '.mp-giveup'],
  'mp-results': ['.reveal-card', '.mp-ready'],
  'mp-final': ['.mp-standings', '.results-actions'],
  home: ['.home-title', '.mode-picker', '.home-start'],
};

const problems = [];
let checks = 0;

function record(viewport, screen, name, ok, detail) {
  checks += 1;
  if (!ok) {
    problems.push(`${viewport} · ${screen} · ${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${viewport.padEnd(20)} ${screen.padEnd(11)} ${name}${detail ? `  ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measure(page, selectors) {
  return page.evaluate((list) => {
    const box = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    const boxes = {};
    for (const selector of list) boxes[selector] = box(selector);
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      overflowY: document.documentElement.scrollHeight - window.innerHeight,
      boxes,
    };
  }, selectors);
}

/** Everything that must be visible, on screen, and inside the gutters. */
async function auditScreen(page, viewport, screen, selectors) {
  const data = await measure(page, selectors);

  record(viewport, screen, 'no horizontal overflow', data.overflowX <= 1, `overflow ${data.overflowX}px`);

  for (const selector of selectors) {
    const box = data.boxes[selector];
    if (!box) {
      record(viewport, screen, `${selector} exists`, false, 'not found');
      continue;
    }
    const insideBottom = box.bottom <= data.viewport.height + 1;
    const insideTop = box.top >= -1;
    record(
      viewport,
      screen,
      `${selector} on screen`,
      insideBottom && insideTop,
      `top ${box.top}, bottom ${box.bottom} vs ${data.viewport.height}`,
    );
    // Touch-size sanity for real controls — never for containers or rows.
    const PRIMARY = ['.play', '.skip', '.mp-giveup', '.field-input', '.mp-create', '.mp-join',
      '.home-start', '.mp-ready', '.mp-start', '.mp-reveal'];
    const SECONDARY = ['.mp-chip', '.mp-mode', '.mp-copy', '.cat-tab', '.mode-card', '.mp-board-head'];
    if (PRIMARY.includes(selector)) {
      record(viewport, screen, `${selector} ≥ 44px tall`, box.height >= 44, `${box.height}px`);
    } else if (SECONDARY.includes(selector)) {
      record(viewport, screen, `${selector} ≥ 40px tall`, box.height >= 40, `${box.height}px`);
    }
  }
  // The stack must never sit on top of the controls below it.
  if (data.boxes['.rows'] && data.boxes['.timeline']) {
    record(
      viewport,
      screen,
      'the attempt stack clears the timeline',
      data.boxes['.rows'].bottom <= data.boxes['.timeline'].top + 1,
      `rows end ${data.boxes['.rows'].bottom}, timeline starts ${data.boxes['.timeline'].top}`,
    );
  }

  // Nothing inside the column may stick out of it.
  const edges = await page.evaluate(() => {
    const shell = document.querySelector('.screen .shell');
    if (!shell) return null;
    const shellRect = shell.getBoundingClientRect();
    const offenders = [];
    for (const element of shell.querySelectorAll('*')) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0) continue;
      if (rect.left < shellRect.left - 1 || rect.right > shellRect.right + 1) {
        offenders.push(`${element.className || element.tagName} ${Math.round(rect.left)}..${Math.round(rect.right)}`);
      }
    }
    return { shell: [Math.round(shellRect.left), Math.round(shellRect.right)], offenders: offenders.slice(0, 3) };
  });
  if (edges) {
    record(viewport, screen, 'nothing escapes the column gutters', edges.offenders.length === 0, edges.offenders.join(', '));
  }

  // Long text clips inside its row instead of stretching it.
  const stretched = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.row, .mp-player, .results-row, .mp-result')];
    return rows.filter((row) => row.scrollWidth > row.clientWidth + 1).map((row) => row.textContent.trim().slice(0, 24));
  });
  record(viewport, screen, 'long text stays inside its row', stretched.length === 0, stretched.join(', '));

  return data;
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const library = await (await fetch(`${BASE}/api/library`)).json();
  const titles = library.tracks.map((track) => track.title);

  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  // Every navigation starts from the home screen: no half-finished room from
  // the previous viewport leaks into the next one.
  await page.addInitScript(() => {
    try {
      sessionStorage.clear();
    } catch {
      /* private mode */
    }
  });
  const shot = async (viewport, screen) => {
    await page.screenshot({ path: path.join(OUT, `${screen}-${viewport}.png`) });
  };

  for (const viewport of VIEWPORTS) {
    const name = viewport.name;
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    /* ── Home ─────────────────────────────────────────────────────── */
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.home-title');
    await page.waitForFunction(() => !document.querySelector('.chip')?.textContent?.includes('Chargement'));
    await sleep(250);
    await auditScreen(page, name, 'home', CRITICAL.home);
    await shot(name, 'home');

    /* ── Singleplayer round ───────────────────────────────────────── */
    await page.click('.home-start');
    await page.waitForSelector('.round');
    await sleep(500);
    await auditScreen(page, name, 'sp-round', CRITICAL['sp-round']);
    await shot(name, 'sp-round');

    // With a full stack: five wrong guesses, so the rows are at their tallest.
    for (const title of ['a very long wrong answer that goes on and on', 'second', 'third', 'fourth', 'fifth']) {
      await page.fill('.field-input', title);
      await page.keyboard.press('Enter');
      await sleep(60);
    }
    await auditScreen(page, name, 'sp-round', CRITICAL['sp-round']);
    await shot(name, 'sp-round-full');

    const ladder = await page.evaluate(() => {
      const steps = [...document.querySelectorAll('.ladder-step')];
      const current = document.querySelector('.ladder-step.is-current') ?? steps[0];
      const pointer = document.querySelector('.ladder-pointer');
      const track = document.querySelector('.ladder');
      if (!pointer || !track || !current) return null;
      const pointerRect = pointer.getBoundingClientRect();
      const pointerMid = pointerRect.left + pointerRect.width / 2;
      const stepRect = current.getBoundingClientRect();
      const stepMid = stepRect.left + stepRect.width / 2;
      const trackRect = track.getBoundingClientRect();
      return {
        delta: Math.abs(pointerMid - stepMid),
        pointerInside: pointerRect.left >= trackRect.left - 8 && pointerRect.right <= trackRect.right + 8,
      };
    });
    if (ladder) {
      record(name, 'sp-round', 'timeline pointer sits on the active segment', ladder.delta <= 3, `${ladder.delta.toFixed(1)}px off`);
      record(name, 'sp-round', 'timeline pointer stays inside the track', ladder.pointerInside);
    }

    /* ── Singleplayer reveal ──────────────────────────────────────── */
    for (let i = 0; i < 1; i += 1) {
      await page.click('.skip');
      await sleep(60);
    }
    for (let i = 0; i < 5; i += 1) {
      await page.click('.skip');
      await sleep(60);
    }
    await page.waitForSelector('.reveal');
    await sleep(500);
    await auditScreen(page, name, 'sp-reveal', CRITICAL['sp-reveal']);
    await shot(name, 'sp-reveal');
    await page.click('.reveal-next');
    await sleep(250);

    /* ── Multiplayer: menu, lobby, round, results ─────────────────── */
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.home-title');
    await page.click('.mode-card[data-mode="multi"]');
    await page.waitForSelector('.mp-menu');
    await page.fill('.mp-name', 'Alexandra Longname');
    await sleep(200);
    await auditScreen(page, name, 'mp-menu', CRITICAL['mp-menu']);
    await shot(name, 'mp-menu');

    await page.selectOption('.mp-rounds', '10');
    await page.click('.mp-create');
    await page.waitForSelector('.mp-lobby');
    await page.waitForFunction(() => document.querySelectorAll('.mp-player').length === 1);
    await sleep(300);
    await auditScreen(page, name, 'mp-lobby', CRITICAL['mp-lobby']);
    await shot(name, 'mp-lobby');

    await page.click('.mp-start');
    await page.waitForSelector('.mp-game');
    await sleep(1200);
    await auditScreen(page, name, 'mp-game', CRITICAL['mp-game']);
    await shot(name, 'mp-game');

    // Guesses fill the attempt stack; the others' statuses show a finished player.
    for (const title of ['tell me - Kanii', 'Good Feeling - Flo Rida']) {
      await page.fill('.field-input', title);
      await page.keyboard.press('Enter');
      await sleep(180);
    }
    await auditScreen(page, name, 'mp-game', CRITICAL['mp-game']);
    await shot(name, 'mp-game-attempts');

    // Finish the round to see the results panel and the final board.
    let answered = false;
    for (const title of titles) {
      await page.fill('.field-input', title);
      await page.keyboard.press('Enter');
      await sleep(120);
      if (await page.locator('.field.is-correct').count()) {
        answered = true;
        break;
      }
      if (await page.locator('.reveal.is-results').count()) break;
    }
    if (answered) {
      await page.waitForSelector('.reveal.is-results', { timeout: 20000 }).catch(() => {});
    }
    if (await page.locator('.reveal.is-results').count()) {
      await sleep(700);
      await auditScreen(page, name, 'mp-results', CRITICAL['mp-results']);
      await shot(name, 'mp-results');

      // The intermission runs itself out, and the next round opens with the
      // standings populated — the state the board exists for.
      await page
        .waitForFunction(() => document.querySelector('.reveal.is-results') === null, null, { timeout: 30000 })
        .catch(() => {});
      await sleep(500);
      if (await page.locator('.mp-board-row').count()) {
        await auditScreen(page, name, 'mp-game', CRITICAL['mp-game']);
        await shot(name, 'mp-board');
      }
    }

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.home-title');
  }

  /* ── Mobile keyboard: the viewport shrinks to about half its height ── */
  await page.setViewportSize({ width: 390, height: 420 });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.home-title');
  await page.click('.home-start');
  await page.waitForSelector('.round');
  await sleep(400);
  await page.click('.field-input');
  await page.fill('.field-input', 'bou');
  await sleep(350);

  const keyboard = await page.evaluate(() => {
    const box = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
    };
    return {
      height: window.innerHeight,
      input: box('.field-input'),
      suggestions: box('.suggestions'),
      play: box('.play'),
      skip: box('.skip'),
      rowCount: document.querySelectorAll('.suggestions .suggestion').length,
    };
  });

  record('390x420', 'sp-round', 'the answer field stays visible with a keyboard open', Boolean(keyboard.input) && keyboard.input.bottom <= keyboard.height, JSON.stringify(keyboard.input));
  record('390x420', 'sp-round', 'autocomplete opens inside the viewport', keyboard.rowCount === 0 || (keyboard.suggestions && keyboard.suggestions.top >= 0), JSON.stringify(keyboard.suggestions));
  record('390x420', 'sp-round', 'the play control is still reachable', Boolean(keyboard.play));
  await page.screenshot({ path: path.join(OUT, 'sp-round-keyboard-390x420.png') });

  /* ── Error / empty states ───────────────────────────────────────── */
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/?room=ZZZZZ`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.home-title');
  await page.click('.mode-card[data-mode="multi"]');
  await page.waitForSelector('.mp-menu');
  await page.fill('.mp-name', 'Test');
  await page.fill('.mp-code-input', 'ZZZZZ');
  await page.click('.mp-join');
  await page.waitForFunction(() => document.querySelector('.mp-notice')?.textContent?.length > 0, null, { timeout: 8000 });
  await auditScreen(page, page.viewportSize().width + 'x' + page.viewportSize().height, 'mp-error', ['.mp-notice', '.mp-create']);
  await page.screenshot({ path: path.join(OUT, 'mp-error-390x844.png') });

  await browser.close();

  console.log(`\n${checks - problems.length}/${checks} layout checks passed`);
  if (problems.length) {
    console.log(`\nProblems (${problems.length}):`);
    for (const problem of problems) console.log(`  - ${problem}`);
  }
  console.log(`\nScreenshots: ${OUT}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
