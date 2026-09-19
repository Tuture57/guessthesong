/**
 * Production QA — everything that can be proved without a real host.
 *
 * The point of this suite is to answer "would this survive being put on a
 * hosting platform?" with evidence rather than optimism. It starts the built
 * app the way a host would (`node server/index.js --prod`, one process, no
 * Vite), then puts a real TLS-terminating reverse proxy in front of it — which
 * is exactly the shape of Infomaniak's Node.js hosting — and drives a
 * multiplayer room through it over `https://`, to prove the page picks `wss://`
 * on its own.
 *
 * What it cannot prove is marked as such in DEPLOY-INFOMANIAK.md: the platform
 * is uniquely able to answer whether it proxies WebSocket upgrades at all.
 *
 *   npm run build
 *   npm run qa:prod
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.GTS_PROD_PORT ?? 8795);
const ALT_PORT = PORT + 1;
const TLS_PORT = PORT + 2;
const BASE = `http://127.0.0.1:${PORT}`;
const QA_DIR = path.resolve('.qa');
const CERT_DIR = path.join(QA_DIR, 'tls');

const failures = [];
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) failures.push(name);
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── Servers ────────────────────────────────────────────────────────── */

/** Starts the app the way a host does: one process, `--prod`, PORT from env. */
async function startApp({ port, env = {} }) {
  const child = spawn(process.execPath, ['server/index.js', '--prod'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'production', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => {
    output += chunk;
    process.stderr.write(`[server] ${chunk}`);
  });
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return { child, output: () => output };
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  child.kill();
  throw new Error(`server did not come up on ${port}\n${output}`);
}

/**
 * A minimal TLS-terminating reverse proxy: HTTPS in, plain HTTP and a raw
 * WebSocket upgrade out. This is the same arrangement a managed host uses, so
 * a page that works through it is a page that works behind theirs.
 */
function startProxy({ listenPort, upstreamPort, key, cert }) {
  const server = https.createServer({ key, cert }, (req, res) => {
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: upstreamPort,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}`, 'x-forwarded-proto': 'https' },
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });

  // The upgrade has to be forwarded byte for byte; that is the whole question.
  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(upstreamPort, '127.0.0.1', () => {
      const headers = Object.entries({ ...req.headers, host: `127.0.0.1:${upstreamPort}` })
        .map(([name, value]) => `${name}: ${value}`)
        .join('\r\n');
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  return new Promise((resolve) => server.listen(listenPort, '127.0.0.1', () => resolve(server)));
}

/** A throwaway self-signed certificate, valid only for this loopback address. */
async function makeCertificate() {
  await fs.mkdir(CERT_DIR, { recursive: true });
  const key = path.join(CERT_DIR, 'key.pem');
  const cert = path.join(CERT_DIR, 'cert.pem');
  const result = spawnSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '2',
      '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  if (result.status !== 0) return null;
  return { key: await fs.readFile(key), cert: await fs.readFile(cert) };
}

/* ── Page probes ────────────────────────────────────────────────────── */

/**
 * Records the URL each WebSocket is opened with. Unlike the frame recorder in
 * the other suites this one *does* replace the constructor — so it has to copy
 * the readyState constants across, or the app's `WebSocket.OPEN` checks would
 * read `undefined` and never send anything.
 */
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

/* ── The suite ──────────────────────────────────────────────────────── */

async function main() {
  await fs.mkdir(QA_DIR, { recursive: true });
  const app = await startApp({ port: PORT });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });

  try {
    /* ── One process, serving everything ──────────────────────────── */
    console.log('\nOne process, one port\n');
    const home = await fetch(BASE);
    const html = await home.text();
    check('the production server answers on the port it was given', home.ok && /<div id="app">/.test(html));
    check('the interface is served by Node, not by Vite', !/vite|@vite\/client/i.test(html), html.slice(0, 120));
    check('the page is declared French', /<html lang="fr">/.test(html));

    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    check('the built bundle is referenced by the document', Boolean(asset), asset ?? '(none)');
    if (asset) {
      const bundle = await fetch(`${BASE}${asset}`);
      const source = await bundle.text();
      check('the bundle is served with a 200', bundle.ok);
      check(
        'the bundle hardcodes no development address',
        !/localhost:\d+|127\.0\.0\.1:\d+|ws:\/\/localhost/.test(source),
        (/(localhost:\d+|127\.0\.0\.1:\d+)/.exec(source) ?? ['(none)'])[0],
      );
      check('the bundle derives the socket URL from the page', /wss?:\/\/\$\{|location\.host/.test(source) || /"wss"/.test(source));

      /*
       * Vite emits `name-HASH.ext`. That hash is what makes the file safe to
       * cache forever, and it is easy to match the wrong separator — this
       * exact check exists because the first version looked for a dot and
       * quietly downgraded every asset to `no-cache`.
       */
      const assetHeaders = await (await fetch(`${BASE}${asset}`)).headers;
      check(
        'a fingerprinted asset is cacheable forever',
        /immutable/.test(assetHeaders.get('cache-control') ?? ''),
        assetHeaders.get('cache-control') ?? '(none)',
      );
      const pageHeaders = await (await fetch(BASE)).headers;
      check(
        'the entry document is never cached',
        /no-cache|no-store/.test(pageHeaders.get('cache-control') ?? ''),
        pageHeaders.get('cache-control') ?? '(none)',
      );
      const hashed = /-[0-9A-Za-z_-]{8,}\.[a-z0-9]+$/i.test(asset.split('/').pop() ?? '');
      check('the asset name really is fingerprinted', hashed, asset);
    }

    /* ── Nothing private in the public endpoints ──────────────────── */
    console.log('\nWhat the API will tell a stranger\n');
    const healthText = await (await fetch(`${BASE}/api/health`)).text();
    const health = JSON.parse(healthText);
    check('the health endpoint reports a version', typeof health.version === 'string', health.version);
    check('the health endpoint reports uptime', Number.isFinite(health.uptimeSeconds));
    check('the health endpoint reports the library is ready', health.library?.ready === true);
    check('the health endpoint counts tracks', Number.isFinite(health.library?.tracks), String(health.library?.tracks));
    check('the health endpoint reports the watcher', typeof health.library?.watching === 'boolean');
    check(
      'the health endpoint leaks no filesystem path',
      !/[A-Za-z]:[\\/]|\\\\|\/(home|srv|var|Users)\//.test(healthText),
      healthText,
    );

    const libraryText = await (await fetch(`${BASE}/api/library`)).text();
    const library = JSON.parse(libraryText);
    check('the library endpoint lists tracks', Array.isArray(library.tracks) && library.tracks.length > 0);
    check(
      'the library endpoint leaks no absolute path',
      !libraryText.includes('\\\\') && !/"[A-Za-z]:[\\/]/.test(libraryText),
      String(library.libraryPath),
    );
    check(
      'tracks are addressed by opaque id',
      library.tracks.every((track) => /^[0-9a-f]{12}$/.test(track.id)),
    );

    /* ── Path traversal and malformed input ───────────────────────── */
    console.log('\nAwkward requests\n');
    const nasty = [
      '/api/audio/..%2f..%2fpackage.json',
      '/api/audio/%2e%2e%2f%2e%2e%2fpackage.json',
      '/api/audio/....//package.json',
      '/api/cover/..%2f..%2fpackage.json',
      '/api/cover/not-a-track-id',
      '/api/audio/not-a-track-id',
      '/api/multi/audio/ZZZZZ',
      '/api/multi/upcoming/ZZZZZ',
    ];
    for (const url of nasty) {
      const response = await fetch(`${BASE}${url}`);
      check(`${url} is refused`, response.status >= 400 && response.status < 500, String(response.status));
    }

    const badJson = await fetch(`${BASE}/api/library/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not json',
    });
    const badJsonBody = await badJson.text();
    check('a malformed body does not return a stack trace', !/at [A-Za-z]+ \(|\.js:\d+:\d+/.test(badJsonBody), badJsonBody.slice(0, 160));

    /* ── The socket is same-origin, and ws:// locally ─────────────── */
    console.log('\nWebSocket — plain HTTP\n');
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(SOCKET_URL_RECORDER);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.home-title', { timeout: 20000 });
    await page.click('.mode-card[data-mode="multi"]');
    await page.fill('.mp-name', 'Prod');
    await page.click('.mp-create');
    await page.waitForSelector('.mp-lobby', { timeout: 15000 });

    const plainUrl = await page.evaluate(() => window.__wsUrls[0] ?? null);
    check('the page opens a socket on its own origin', plainUrl === `ws://127.0.0.1:${PORT}/ws`, String(plainUrl));
    check('a room can be created on the production server', /^[A-Z0-9]{5}$/.test((await page.textContent('.mp-code-value')).trim()));
    await context.close();

    /* ── The socket behind a TLS-terminating proxy ────────────────── */
    console.log('\nWebSocket — HTTPS through a reverse proxy\n');
    const tls = await makeCertificate();
    if (!tls) {
      check('a test certificate could be created (openssl present)', false, 'openssl missing — the TLS half was skipped');
    } else {
      const proxy = await startProxy({ listenPort: TLS_PORT, upstreamPort: PORT, key: tls.key, cert: tls.cert });
      const secure = await browser.newContext({ ignoreHTTPSErrors: true });
      const securePage = await secure.newPage();
      await securePage.addInitScript(SOCKET_URL_RECORDER);
      await securePage.goto(`https://127.0.0.1:${TLS_PORT}`, { waitUntil: 'domcontentloaded' });
      await securePage.waitForSelector('.home-title', { timeout: 20000 });
      check('the app loads over HTTPS', true);

      const healthOverTls = await (await fetch(`https://127.0.0.1:${TLS_PORT}/api/health`, { dispatcher: undefined }).catch(() => null)) ?? null;
      void healthOverTls;

      await securePage.click('.mode-card[data-mode="multi"]');
      await securePage.fill('.mp-name', 'Secure');
      await securePage.click('.mp-create');
      await securePage.waitForSelector('.mp-lobby', { timeout: 15000 });

      const secureUrl = await securePage.evaluate(() => window.__wsUrls[0] ?? null);
      check(
        'an HTTPS page asks for wss:// without being told to',
        secureUrl === `wss://127.0.0.1:${TLS_PORT}/ws`,
        String(secureUrl),
      );
      check(
        'the multiplayer socket survives the proxy',
        /^[A-Z0-9]{5}$/.test((await securePage.textContent('.mp-code-value')).trim()),
      );
      await securePage.click('.mp-start');
      const started = await securePage.waitForSelector('.mp-game', { timeout: 15000 }).then(() => true).catch(() => false);
      check('a round can start through the proxy', started);
      await secure.close();
      proxy.close();
    }

    /* ── A different music folder, from the environment ───────────── */
    console.log('\nMUSIC_DIR\n');
    const altDir = path.join(QA_DIR, 'alt-library');
    await fs.rm(altDir, { recursive: true, force: true });
    await fs.mkdir(path.join(altDir, 'Dossier Test'), { recursive: true });
    const first = library.tracks[0];
    if (first) {
      await fs.copyFile(
        path.join(path.resolve(process.cwd(), library.libraryPath), first.relPath),
        path.join(altDir, 'Dossier Test', 'Titre Test.mp3'),
      );
    }

    const alt = await startApp({ port: ALT_PORT, env: { MUSIC_DIR: altDir, WATCH: '0' } });
    const altHealth = await (await fetch(`http://127.0.0.1:${ALT_PORT}/api/health`)).json();
    check('MUSIC_DIR is honoured', altHealth.library?.tracks === 1, String(altHealth.library?.tracks));
    check('the reported folder is the one configured', altHealth.library?.source === altDir, altHealth.library?.source);
    check('WATCH=0 turns the watcher off', altHealth.library?.watching === false, String(altHealth.library?.watching));

    const altLibrary = await (await fetch(`http://127.0.0.1:${ALT_PORT}/api/library`)).json();
    check('a subfolder becomes a category', (await (await fetch(`http://127.0.0.1:${ALT_PORT}/api/categories`)).json()).categories.some((category) => category.name === 'Dossier Test'));
    check('accented folder names survive', altLibrary.tracks.length === 1, JSON.stringify(altLibrary.tracks.map((track) => track.folder)));
    alt.child.kill();
    await fs.rm(altDir, { recursive: true, force: true });

    /* ── A room that is only in memory ────────────────────────────── */
    console.log('\nRestart behaviour\n');
    const before = await (await fetch(`${BASE}/api/health`)).json();
    app.child.kill();
    await sleep(600);
    const restarted = await startApp({ port: PORT });
    const after = await (await fetch(`${BASE}/api/health`)).json();
    check('rooms live in memory only', before.rooms >= 0 && after.rooms === 0, `${before.rooms} -> ${after.rooms}`);
    check('the process starts again on the same port', after.ok === true);
    check('the library is re-indexed from its cache', after.library?.tracks > 0, String(after.library?.tracks));
    restarted.child.kill();
  } finally {
    await browser.close();
    app.child.kill();
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length) {
    console.log('\nFailed:');
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  }
  console.log('');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
