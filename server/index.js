/**
 * The game server: one Node process serving the built interface, the API, the
 * audio and the multiplayer socket on a single port.
 *
 * Development splits that across two processes (`npm run dev` adds Vite);
 * production is this file alone (`npm run build && npm start`), which is what a
 * hosting platform expects: one app, one port.
 */
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { messageFor } from '../shared/messages.fr.js';
import config from '../config.js';
import {
  PROJECT_ROOT,
  getCoverPath,
  getLibraryLabel,
  getLibraryPayload,
  getLibraryPath,
  getTrack,
  getTracks,
  isLibraryAvailable,
  isWatching,
  libraryEvents,
  scan,
  startWatcher,
  stopWatcher,
} from './library.js';
import {
  attachMultiplayer,
  closeMultiplayer,
  getRoundAudio,
  getUpcomingAudio,
  listCategories,
  roomCount,
} from './multiplayer.js';

const app = express();
/**
 * PORT first: a hosting platform chooses the port and passes it in, and the
 * Manager's "listening port" field must match. The local default is only a
 * convenience for `npm run dev`.
 */
const PORT = Number(process.env.PORT ?? config.server.port);
/**
 * Node already listens on every interface when no host is given, which is what
 * a hosting reverse proxy needs. `HOST=127.0.0.1` is there for anyone who
 * would rather the port were not reachable from the network.
 */
const HOST = process.env.HOST || undefined;
const PROD = process.argv.includes('--prod') || process.env.NODE_ENV === 'production';

/** Track ids are 12 hex characters; anything else is not ours. */
const TRACK_ID = /^[0-9a-f]{12}$/;

app.disable('x-powered-by');
if (PROD) app.set('env', 'production');
// Hosting platforms put a reverse proxy in front of the app (Infomaniak's
// documents it forwarding X-Forwarded-For), so the caller's real address — and
// therefore the rate limiter above — has to come from that header.
app.set('trust proxy', true);
app.use(express.json({ limit: '32kb' }));

const VERSION = readVersion();
function readVersion() {
  try {
    const raw = fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8');
    return JSON.parse(raw).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * A library-relative path resolved against the library root, refusing anything
 * that would climb out of it. The index is ours, so this should never fire —
 * it is here so that a corrupted index cannot become a file read.
 */
function resolveInLibrary(relPath) {
  const root = getLibraryPath();
  const abs = path.resolve(root, relPath);
  const rel = path.relative(root, abs);
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? abs : null;
}

/* ── API ────────────────────────────────────────────────────────────── */

/**
 * Liveness, and enough to tell a healthy deployment from a broken one — with
 * nothing an anonymous caller should not have: no filesystem path, no song, no
 * room. `library.source` is the folder *as configured*, never as resolved.
 */
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    library: {
      ready: isLibraryAvailable(),
      source: getLibraryLabel(),
      tracks: getTracks().filter((track) => !track.unreadable).length,
      watching: isWatching(),
    },
    rooms: roomCount(),
  });
});

app.get('/api/library', (_req, res) => {
  res.json(getLibraryPayload({ absolute: !PROD }));
});

app.post('/api/library/refresh', async (req, res) => {
  // Rescanning walks the whole folder: cheap when nothing changed, but not
  // something an anonymous caller should be able to trigger in a loop.
  if (!withinBudget(req, res, 'refresh', 12, 60_000)) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    const force = req.query.full === '1' || req.body?.full === true;
    const stats = await scan({ force });
    res.json({ ...stats, ...getLibraryPayload({ absolute: !PROD }) });
  } catch (error) {
    console.error('rescan failed:', error);
    res.status(500).json({ error: 'Rescan failed.' });
  }
});

/* ── Rate limiting ──────────────────────────────────────────────────── */

/**
 * A small per-caller allowance for the HTTP endpoints that do real work.
 * Nothing here is on the path of normal play: a player guessing as fast as
 * they can never touches these.
 */
const budgets = new Map();

function withinBudget(req, res, kind, limit, windowMs) {
  const now = Date.now();
  const key = `${kind}:${req.ip ?? 'unknown'}`;
  const ledger = (budgets.get(key) ?? []).filter((at) => now - at < windowMs);
  if (ledger.length >= limit) {
    budgets.set(key, ledger);
    res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
    res.status(429).json({ error: messageFor('rate-limited') });
    return false;
  }
  ledger.push(now);
  budgets.set(key, ledger);
  // Keep the table from growing without bound: it is keyed by caller.
  if (budgets.size > 5000) {
    for (const [entry] of budgets) {
      if (!entry.some((at) => now - at < 60_000)) budgets.delete(entry);
    }
  }
  return true;
}

/** Server-sent events: tells the page when songs were added or removed. */
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');

  const onLibraryChange = (stats) => {
    res.write(`event: library\ndata: ${JSON.stringify({ ...stats, ...getLibraryPayload({ absolute: !PROD }) })}\n\n`);
  };
  const onWarning = (message) => {
    res.write(`event: warning\ndata: ${JSON.stringify({ message })}\n\n`);
  };
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  libraryEvents.on('change', onLibraryChange);
  libraryEvents.on('warning', onWarning);

  req.on('close', () => {
    clearInterval(heartbeat);
    libraryEvents.off('change', onLibraryChange);
    libraryEvents.off('warning', onWarning);
  });
});

app.get('/api/cover/:id', async (req, res) => {
  if (!TRACK_ID.test(req.params.id) || !getTrack(req.params.id)) return res.status(404).end();
  const coverPath = await getCoverPath(req.params.id);
  if (!coverPath) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(coverPath, (error) => {
    if (error && !res.headersSent) res.status(404).end();
  });
});

/**
 * Streams the original file. `sendFile` gives us Range support for seeking.
 *
 * The URL carries only the track's opaque id — never a path and never the
 * folder layout — and the file it resolves to always comes from the index, so
 * a request cannot name a file the server did not choose to publish.
 */
app.get('/api/audio/:id', (req, res) => {
  if (!TRACK_ID.test(req.params.id)) return res.status(404).end();
  const track = getTrack(req.params.id);
  if (!track) return res.status(404).end();

  const absPath = resolveInLibrary(track.relPath);
  if (!absPath || !fs.existsSync(absPath)) return res.status(410).end();

  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Type', contentTypeFor(track.fileName));
  res.sendFile(absPath, (error) => {
    if (error && !res.headersSent) res.status(500).end();
  });
});

/** Category tabs that actually exist in this library. */
app.get('/api/categories', (_req, res) => {
  res.json({ categories: [{ name: 'Toutes', value: 'all', count: getTracks().filter((t) => !t.unreadable).length }, ...listCategories().map((c) => ({ name: c.name, value: c.name, count: c.count }))] });
});

/**
 * In-round audio for a multiplayer room. Addressed by room code, never by
 * track id, so the URL itself carries no spoiler.
 */
app.get('/api/multi/audio/:code', (req, res) => {
  const audio = getRoundAudio(req.params.code);
  if (!audio) return res.status(404).end();

  const absPath = resolveInLibrary(audio.relPath);
  if (!absPath || !fs.existsSync(absPath)) return res.status(410).end();

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', contentTypeFor(audio.fileName));
  res.sendFile(absPath, (error) => {
    if (error && !res.headersSent) res.status(500).end();
  });
});

/**
 * The song the room will play next, fetchable only while the reveal and its
 * countdown are on screen. Same terms as the round audio: room code only, no
 * track id, no metadata — it exists so clients can decode ahead of time and
 * start the next round without a loading pause.
 */
app.get('/api/multi/upcoming/:code', (req, res) => {
  const audio = getUpcomingAudio(req.params.code);
  if (!audio) return res.status(404).end();

  const absPath = resolveInLibrary(audio.relPath);
  if (!absPath || !fs.existsSync(absPath)) return res.status(410).end();

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', contentTypeFor(audio.fileName));
  res.sendFile(absPath, (error) => {
    if (error && !res.headersSent) res.status(500).end();
  });
});

function contentTypeFor(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return (
    {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.flac': 'audio/flac',
      '.m4a': 'audio/mp4',
      '.ogg': 'audio/ogg',
      '.oga': 'audio/ogg',
      '.opus': 'audio/ogg',
      '.aac': 'audio/aac',
      '.webm': 'audio/webm',
    }[ext] ?? 'application/octet-stream'
  );
}

/*
 * Anything under /api that got this far is not a route. Answering with the
 * single-page HTML shell instead would be a confusing "success" for a request
 * that asked for data — and it is the shape a path-traversal probe takes when
 * the router refuses to match it.
 */
app.all('/api/*', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

/* ── Static client ──────────────────────────────────────────────────── */

if (PROD) {
  const dist = path.join(PROJECT_ROOT, 'dist');
  if (!fs.existsSync(dist)) {
    console.error('\n  No build found. Run `npm run build` first (or use `npm run dev`).\n');
    process.exit(1);
  }
  /*
   * Vite fingerprints everything it emits except the HTML, so the assets can
   * be cached hard and the entry document not at all — which is what keeps a
   * redeploy from serving yesterday's interface to a returning player.
   */
  app.use(
    express.static(dist, {
      index: false,
      setHeaders: (res, filePath) => {
        const immutable = /\.[0-9a-f]{8,}\./.test(path.basename(filePath));
        res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }),
  );
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(dist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.type('html').send(
      `<!doctype html><meta charset="utf-8" lang="fr"><title>Devine la chanson — API seule</title>
       <body style="font:15px/1.6 system-ui;background:#0d0e10;color:#f2f2f4;padding:48px">
       <h1 style="margin:0 0 8px">Devine la chanson — API seule</h1>
       <p>En développement, l’interface est servie par Vite : <a style="color:#35d873" href="http://localhost:5173">http://localhost:5173</a></p>
       <p style="opacity:.6">Pour servir l’interface ici : npm run build puis npm start.</p></body>`,
    );
  });
}

/* ── Errors ─────────────────────────────────────────────────────────── */

/**
 * One last handler, so a thrown route answers with JSON rather than Express's
 * HTML error page — and, in production, without the stack trace that page
 * would otherwise carry.
 */
// eslint-disable-next-line no-unused-vars -- Express identifies it by arity.
app.use((error, _req, res, _next) => {
  const status = Number.isInteger(error?.status) && error.status >= 400 ? error.status : 500;
  // The stack goes to the operator's log, never to the caller.
  if (status >= 500) console.error('request failed:', error);
  if (res.headersSent) return;
  res.status(status).json({
    error: status >= 500 && PROD ? messageFor('unknown') : String(error?.message ?? messageFor('unknown')),
  });
});

/* ── Boot ───────────────────────────────────────────────────────────── */

async function boot() {
  if (!isLibraryAvailable()) {
    console.error(`\n  Music folder not found: ${getLibraryPath()}`);
    console.error('  Set "library.path" in config.js, or create the folder.\n');
  }

  const started = Date.now();
  const stats = await scan();
  console.log(
    `  Library  ${stats.total} track${stats.total === 1 ? '' : 's'} indexed in ${Date.now() - started} ms` +
      (stats.addedOnly || stats.updated || stats.removed
        ? `  (+${stats.addedOnly} new, ${stats.updated} updated, ${stats.removed} removed)`
        : '  (cache hit)'),
  );
  console.log(`  Folder   ${getLibraryPath()}`);

  startWatcher();

  // The WebSocket server shares the HTTP server, so one port serves game,
  // API and realtime multiplayer alike.
  const server = http.createServer(app);
  attachMultiplayer(server, { getTracks });

  server.listen(PORT, HOST, () => {
    const where = HOST ?? 'every interface';
    console.log(`  Listening  ${where}:${PORT}${PROD ? '' : ' (development)'}`);
    console.log(PROD ? '  Game       this same port\n' : '  Game       http://localhost:5173\n');
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`\n  Port ${PORT} is already in use. Stop the other process, or set PORT.\n`);
    } else {
      console.error('\n  Server error:', error.message, '\n');
    }
    process.exit(1);
  });

  liveServer = server;
}

/* ── Shutdown ───────────────────────────────────────────────────────── */

let liveServer = null;
let closing = false;

/**
 * A deploy or a platform restart ends every game in progress: rooms live in
 * memory, and there is no database to bring them back from. All that can be
 * done is to do it tidily — tell the players why, stop the watcher, and stop
 * accepting new connections.
 */
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n  ${signal} — closing rooms and stopping.`);
  closeMultiplayer();
  stopWatcher();
  const done = () => process.exit(0);
  if (liveServer) liveServer.close(done);
  else done();
  setTimeout(done, 3000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}

boot();
