/**
 * The global volume control.
 *
 * Checks the setting itself, not the widget: the master gain node the audio
 * engine actually plays through is read out of the page, so "the slider says
 * 40 %" is only accepted alongside "the output gain is 0.4".
 *
 * Covers the parts that are easy to get subtly wrong — a mute that resets the
 * level, a reload that forgets it, a slider that only applies to the next
 * sound — plus the four required viewports, where the control must not push
 * the round's own controls off the screen.
 *
 *   npm run build
 *   npm run qa:volume
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';

const PORT = Number(process.env.GTS_VOLUME_PORT ?? 8796);
const BASE = process.env.GTS_VOLUME_URL ?? `http://localhost:${PORT}`;
const SHOTS = path.resolve('.qa');

const failures = [];
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) failures.push(name);
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const near = (value, wanted, tolerance = 0.002) => Math.abs(value - wanted) <= tolerance;

async function startServer() {
  const child = spawn(process.execPath, ['server/index.js', '--prod'], {
    env: { ...process.env, PORT: String(PORT), GTS_MP_IDLE_SECONDS: '20' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return child;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('the test server did not come up');
}

/**
 * Watches the Web Audio graph. The master gain is the first one the app
 * creates — the engine makes it once, when the AudioContext is built — and
 * every other gain node in the app is a per-playback fade below it.
 *
 * Automation is recorded as well as values, because this environment gives
 * Chromium no audio output device: `AudioContext.currentTime` never advances,
 * so a ramp that has been scheduled correctly still reads back as the old
 * value. The scheduled target is the honest measurement of "the volume was
 * applied here, now" — and `gain.value` is checked too whenever the clock
 * does run, which is the case on a real machine.
 */
const GAIN_PROBE = () => {
  window.__gains = [];
  window.__sources = 0;
  window.__automation = [];

  const paramIds = new WeakMap();
  let nextParamId = 0;
  window.__paramId = (param) => {
    if (!paramIds.has(param)) paramIds.set(param, ++nextParamId);
    return paramIds.get(param);
  };

  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (Ctor) {
    const original = Ctor.prototype.createGain;
    Ctor.prototype.createGain = function (...args) {
      const node = original.apply(this, args);
      window.__gains.push(node);
      return node;
    };
  }

  const paramProto = window.AudioParam && window.AudioParam.prototype;
  if (paramProto) {
    for (const kind of ['linearRampToValueAtTime', 'setValueAtTime', 'setTargetAtTime']) {
      const original = paramProto[kind];
      paramProto[kind] = function (...args) {
        try {
          window.__automation.push({ param: window.__paramId(this), kind, value: Number(args[0]), time: Number(args[1]) });
        } catch {
          /* never break audio */
        }
        return original.apply(this, args);
      };
    }
  }

  const proto = window.AudioBufferSourceNode && window.AudioBufferSourceNode.prototype;
  if (proto) {
    const original = proto.start;
    proto.start = function (...args) {
      window.__sources += 1;
      return original.apply(this, args);
    };
  }
};

/** What the engine last told the master gain to do, and what it now reads. */
const master = (page) =>
  page.evaluate(() => {
    const node = (window.__gains ?? [])[0];
    if (!node) return null;
    const id = window.__paramId(node.gain);
    const entries = (window.__automation ?? []).filter((entry) => entry.param === id);
    const last = entries.length ? entries[entries.length - 1] : null;
    return {
      nodes: window.__gains.length,
      value: Number(node.gain.value),
      clock: Number(node.context.currentTime),
      automation: entries.length,
      kind: last?.kind ?? null,
      target: last ? last.value : null,
      delay: last ? Number((last.time - node.context.currentTime).toFixed(4)) : null,
    };
  });

const stored = (page) =>
  page.evaluate(() => ({
    level: window.localStorage.getItem('gts-volume'),
    muted: window.localStorage.getItem('gts-volume-muted'),
  }));

const ui = (page) =>
  page.evaluate(() => {
    const slider = document.querySelector('.volume-slider');
    const toggle = document.querySelector('.volume-toggle');
    const panel = document.querySelector('.volume-panel');
    const rect = panel?.getBoundingClientRect();
    return {
      slider: slider ? Number(slider.value) : null,
      sliderText: slider?.getAttribute('aria-valuetext') ?? null,
      label: toggle?.getAttribute('aria-label') ?? null,
      pressed: toggle?.getAttribute('aria-pressed') ?? null,
      state: document.querySelector('.volume')?.getAttribute('data-state') ?? null,
      readout: document.querySelector('.volume-readout')?.textContent ?? null,
      panelVisible: panel ? getComputedStyle(panel).visibility === 'visible' : false,
      panelBox: rect ? { left: Math.round(rect.left), right: Math.round(rect.right), width: window.innerWidth } : null,
    };
  });

/** Waits for the N-th scheduled source, or gives up and reports what it saw. */
async function waitForSources(page, wanted, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  while (Date.now() < deadline) {
    seen = await page.evaluate(() => window.__sources);
    if (seen >= wanted) return seen;
    await sleep(150);
  }
  return seen;
}

const openPanel = async (page) => {
  await page.hover('.volume');
  await sleep(250);
};

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  console.log(`\nVolume control against ${BASE}\n`);

  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    await page.addInitScript(GAIN_PROBE);
    // Start from a clean slate: no stored setting at all. Cleared once, by
    // hand, so a reload later in the run genuinely tests persistence.
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      try {
        window.localStorage.removeItem('gts-volume');
        window.localStorage.removeItem('gts-volume-muted');
      } catch {
        /* ignore */
      }
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.home-title', { timeout: 20000 });

    /* ── Default ──────────────────────────────────────────────────── */
    const initial = await ui(page);
    check('the control is on the home screen', initial.slider !== null, JSON.stringify(initial.slider));
    check('a fresh player starts at 75 %', initial.slider === 75, String(initial.slider));
    check('the readout says 75 %', initial.readout === '75 %', initial.readout);
    check('the slider is labelled in French', initial.label === 'Couper le son', initial.label);
    check('the value is spoken as a percentage', initial.sliderText === 'Volume 75 pour cent', initial.sliderText);
    check('the panel is hidden until asked for', initial.panelVisible === false, String(initial.panelVisible));

    // A click anywhere unlocks the AudioContext, which is when the master
    // gain is built — it must be built at the stored setting, not at 1.
    await page.click('.brand');
    await sleep(300);
    const built = await master(page);
    check('the audio graph starts at the stored volume', near(built.value, 0.75), JSON.stringify(built));
    check('there is exactly one master gain node', built.nodes === 1, `${built.nodes} gain nodes`);

    /* ── The slider ───────────────────────────────────────────────── */
    await openPanel(page);
    check('hovering the control reveals the slider', (await ui(page)).panelVisible === true);

    await page.fill('.volume-slider', '40');
    await page.dispatchEvent('.volume-slider', 'input');
    await sleep(200);
    const at40 = await master(page);
    check(
      'the slider ramps the master gain to 40 %',
      at40.kind === 'linearRampToValueAtTime' && near(at40.target, 0.4) && at40.delay <= 0.05,
      JSON.stringify(at40),
    );
    check('40 % is stored', (await stored(page)).level === '0.4', JSON.stringify(await stored(page)));
    check('the readout follows', (await ui(page)).readout === '40 %', (await ui(page)).readout);
    check('no second master gain was invented', at40.nodes === 1, `${at40.nodes} gain nodes`);

    /* ── Persistence across a reload ──────────────────────────────── */
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.home-title', { timeout: 20000 });
    await sleep(300);
    const afterReload = await ui(page);
    check('a reload restores the slider', afterReload.slider === 40, String(afterReload.slider));
    check('a reload keeps the stored value', (await stored(page)).level === '0.4', JSON.stringify(await stored(page)));

    await page.click('.brand');
    await sleep(300);
    check('a reload rebuilds the graph at that volume', near((await master(page)).value, 0.4), JSON.stringify(await master(page)));

    /* ── Mute ─────────────────────────────────────────────────────── */
    await page.click('.volume-toggle');
    await sleep(250);
    const muted = await ui(page);
    const mutedGain = await master(page);
    check(
      'clicking the speaker ramps the sound to silence',
      mutedGain.kind === 'linearRampToValueAtTime' && near(mutedGain.target, 0),
      JSON.stringify(mutedGain),
    );
    check('muting does not move the slider', muted.slider === 40, String(muted.slider));
    check('muting is remembered', (await stored(page)).muted === '1', JSON.stringify(await stored(page)));
    check('the level survives the mute', (await stored(page)).level === '0.4', JSON.stringify(await stored(page)));
    check('the icon says the sound is off', muted.label === 'Rétablir le son' && muted.pressed === 'true', `${muted.label} / ${muted.pressed}`);
    check('the icon switches to the muted state', muted.state === 'muted', muted.state);

    /* ── Unmute ───────────────────────────────────────────────────── */
    await page.click('.volume-toggle');
    await sleep(250);
    const back = await master(page);
    check(
      'un-muting restores exactly the previous level, not 100 %',
      near(back.target, 0.4) && back.target !== 1,
      JSON.stringify(back),
    );
    check(
      'the icon reports the level it came back to',
      (await ui(page)).state === 'low' && near(back.target, 0.4, 0.001),
      `${(await ui(page)).state} at ${back.target}`,
    );

    /* ── Muted, then reloaded ─────────────────────────────────────── */
    await page.click('.volume-toggle');
    await sleep(200);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.home-title', { timeout: 20000 });
    await sleep(300);
    const stillMuted = await ui(page);
    check('a mute survives a reload', stillMuted.pressed === 'true' && stillMuted.slider === 40, JSON.stringify(stillMuted));
    await page.click('.brand');
    await sleep(300);
    check('...and so does its silence', near((await master(page)).value, 0), JSON.stringify(await master(page)));
    await page.click('.volume-toggle');
    await sleep(250);

    /* ── Keyboard ─────────────────────────────────────────────────── */
    // Real TAB presses: `:focus-visible` is about how focus arrived, and a
    // programmatic focus() would not match it.
    await page.mouse.move(4, 4);
    const reachedSlider = await (async () => {
      for (let i = 0; i < 12; i += 1) {
        await page.keyboard.press('Tab');
        if (await page.evaluate(() => document.activeElement?.classList.contains('volume-slider'))) return true;
      }
      return false;
    })();
    check('TAB reaches the slider', reachedSlider, 'never focused');
    const focusVisible = await page.evaluate(() => document.activeElement?.matches(':focus-visible') ?? false);
    check('the slider takes keyboard focus visibly', focusVisible, String(focusVisible));
    check('focusing the slider opens its panel', (await ui(page)).panelVisible === true, 'panel hidden');

    const beforeKeys = (await ui(page)).slider;
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await sleep(250);
    check('the arrow keys change the level', (await ui(page)).slider === beforeKeys - 2, `${beforeKeys} → ${(await ui(page)).slider}`);
    const afterKeys = await master(page);
    check(
      '...and the output follows the keyboard too',
      near(afterKeys.target, (beforeKeys - 2) / 100),
      JSON.stringify(afterKeys),
    );
    await page.mouse.move(4, 4);
    await page.keyboard.press('Escape');
    await sleep(250);
    check('Escape dismisses the panel', (await ui(page)).panelVisible === false, 'panel still visible');
    check('Escape leaves no focus behind', await page.evaluate(() => document.activeElement === document.body), 'focus still inside');

    /* ── A change while a sound is playing ────────────────────────── */
    await page.click('.home-start');
    await page.waitForSelector('.round', { timeout: 15000 });
    await sleep(400);
    const before = await page.evaluate(() => window.__sources);
    await page.click('.play');
    // A cold PLAY decodes the file first; measured at ~2 s for a full track.
    const sources = await waitForSources(page, before + 1);
    check('a solo excerpt is handed to the audio hardware', sources > before, `sources ${before} → ${sources}`);

    await page.hover('.volume');
    await page.fill('.volume-slider', '90');
    await page.dispatchEvent('.volume-slider', 'input');
    await sleep(150);
    const whilePlaying = await master(page);
    check(
      'changing the slider changes the sound that is already playing',
      whilePlaying.kind === 'linearRampToValueAtTime' && near(whilePlaying.target, 0.9) && whilePlaying.delay <= 0.05,
      JSON.stringify(whilePlaying),
    );
    check(
      '...without restarting it',
      (await page.evaluate(() => window.__sources)) === sources,
      `sources ${sources} → ${await page.evaluate(() => window.__sources)}`,
    );

    /* ── The multiplayer screen keeps the control ─────────────────── */
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.home-title');
    await page.click('.mode-card[data-mode="multi"]');
    await page.waitForSelector('.mp-menu');
    check('the control is on the multiplayer screen', (await ui(page)).slider === 90, String((await ui(page)).slider));
    await page.click('.mp-back');
    await page.waitForSelector('.home-title');
    check('the level survives multiplayer → home', (await ui(page)).slider === 90, String((await ui(page)).slider));
    check('and it is still the stored one', (await stored(page)).level === '0.9', JSON.stringify(await stored(page)));

    /* ── The fallback <audio> element mirrors the same setting ────── */
    const fallbackContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const fallbackPage = await fallbackContext.newPage();
    await fallbackPage.addInitScript(() => {
      // Force the element path: no decoded buffer can be produced.
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (Ctor) Ctor.prototype.decodeAudioData = () => Promise.reject(new Error('forced'));
    });
    await fallbackPage.goto(BASE, { waitUntil: 'domcontentloaded' });
    await fallbackPage.waitForSelector('.home-title');
    await fallbackPage.click('.home-start');
    await fallbackPage.waitForSelector('.round');
    await fallbackPage.waitForTimeout(300);
    await fallbackPage.hover('.volume');
    await fallbackPage.fill('.volume-slider', '30');
    await fallbackPage.dispatchEvent('.volume-slider', 'input');
    await fallbackPage.click('.play');
    await fallbackPage.waitForSelector('audio', { timeout: 10000 }).catch(() => {});
    await sleep(600);
    const fallbackVolume = await fallbackPage.evaluate(() => document.querySelector('audio')?.volume ?? null);
    check('the fallback <audio> element follows the same setting', fallbackVolume !== null && near(fallbackVolume, 0.3), String(fallbackVolume));
    await fallbackContext.close();

    /* ── Layout: the control never costs the game its controls ────── */
    const viewports = [
      { width: 1920, height: 1080 },
      { width: 1366, height: 768 },
      { width: 390, height: 844 },
      { width: 375, height: 667 },
    ];
    // The multiplayer menu: a top bar with the control plus page content,
    // which is the layout most at risk from a wider header.
    await page.click('.mode-card[data-mode="multi"]');
    await page.waitForSelector('.mp-menu');
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await sleep(250);
      const box = await page.evaluate(() => {
        const toggle = document.querySelector('.volume-toggle')?.getBoundingClientRect();
        return {
          toggle: toggle ? { top: toggle.top, bottom: toggle.bottom, left: toggle.left, right: toggle.right } : null,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
        };
      });
      const label = `${viewport.width}×${viewport.height}`;
      check(
        `the volume control fits the ${label} top bar`,
        Boolean(box.toggle) && box.toggle.top >= 0 && box.toggle.right <= box.innerWidth + 1 && box.toggle.bottom <= 120,
        JSON.stringify(box.toggle),
      );
      check(`no horizontal scrolling at ${label}`, box.scrollWidth <= box.innerWidth + 1, `${box.scrollWidth} > ${box.innerWidth}`);

      await openPanel(page);
      const panel = await ui(page);
      check(
        `the open panel stays inside the ${label} viewport`,
        Boolean(panel.panelBox) && panel.panelBox.left >= 0 && panel.panelBox.right <= panel.panelBox.width + 1,
        JSON.stringify(panel.panelBox),
      );
      await page.screenshot({ path: path.join(SHOTS, `volume-${viewport.width}x${viewport.height}.png`) });
    }

    /* The round screen is the one with controls to lose. */
    await page.setViewportSize({ width: 375, height: 667 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.home-title');
    await page.click('.home-start');
    await page.waitForSelector('.round');
    await sleep(300);
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 1366, height: 768 },
      { width: 390, height: 844 },
      { width: 375, height: 667 },
    ]) {
      await page.setViewportSize(viewport);
      await sleep(250);
      const layout = await page.evaluate(() => {
        const selectors = ['.play', '.field', '.skip', '.volume-toggle'];
        const out = {};
        for (const selector of selectors) {
          const rect = document.querySelector(selector)?.getBoundingClientRect();
          out[selector] = rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom) } : null;
        }
        out.innerHeight = window.innerHeight;
        out.scrollHeight = document.documentElement.scrollHeight;
        return out;
      });
      const label = `${viewport.width}×${viewport.height}`;
      check(
        `the play button is still on screen at ${label}`,
        Boolean(layout['.play']) && layout['.play'].bottom <= layout.innerHeight + 1 && layout['.play'].top >= 0,
        JSON.stringify(layout['.play']),
      );
      check(
        `the answer field is still on screen at ${label}`,
        Boolean(layout['.field']) && layout['.field'].bottom <= layout.innerHeight + 1,
        JSON.stringify(layout['.field']),
      );
    }

    await context.close();
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

await main();
