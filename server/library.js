/**
 * The music library: discovery, metadata cache, and change tracking.
 *
 * A scan stats every supported audio file under the library folder and only
 * re-reads tags for files whose mtime or size changed. Everything else is
 * served straight from the JSON cache, so a 1000-track library still starts in
 * well under a second after the first run.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parseFile } from 'music-metadata';
import config from '../config.js';
import { buildTrack, toPublicTrack } from './metadata.js';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SERVER_DIR, '..');

/**
 * Where the music and the derived data live.
 *
 * Both come from the environment first so a deployment can point them
 * somewhere else without editing code: `MUSIC_DIR=/srv/songs npm start`, or an
 * absolute path on Windows for a folder outside the project. A relative value
 * always resolves from the project root, which is what keeps `songs/` working
 * the same way on Windows and on a Linux host.
 *
 * `path.resolve` handles both separators, so a Windows path stays valid locally
 * and a POSIX path works on the server.
 */
const MUSIC_DIR = process.env.MUSIC_DIR || config.library.path;
const LIBRARY_DIR = path.resolve(PROJECT_ROOT, MUSIC_DIR);

/** Caches and extracted covers — writable, disposable, never the songs. */
const DATA_DIR = path.resolve(PROJECT_ROOT, process.env.DATA_DIR || path.dirname(config.library.cacheFile));
const CACHE_PATH = path.join(DATA_DIR, path.basename(config.library.cacheFile));
const COVER_DIR = path.join(DATA_DIR, 'covers');

const EXTENSIONS = new Set(config.library.extensions.map((ext) => ext.toLowerCase()));

/** `WATCH=1` / `WATCH=0` overrides config.library.watch. */
const WATCH = process.env.WATCH === undefined ? config.library.watch : process.env.WATCH !== '0';

export const libraryEvents = new EventEmitter();

/** @type {Map<string, object>} relPath -> track */
let tracksByPath = new Map();
/** @type {Map<string, object>} id -> track */
let tracksById = new Map();
let lastScan = null;
let scanning = null;
let rescanQueued = false;
let queuedForce = false;
let watcher = null;

/** Directories that are never part of the library. */
const IGNORED_DIRS = new Set(['.cache', 'node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information']);

/* ── Cache file ─────────────────────────────────────────────────────── */

async function readCache() {
  try {
    const raw = await fs.readFile(CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      tracks: Object.create(null),
      ...parsed,
    };
  } catch {
    return { version: 1, tracks: Object.create(null) };
  }
}

async function writeCache(cache) {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  const tmp = `${CACHE_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cache), 'utf8');
  await fs.rename(tmp, CACHE_PATH);
}

/* ── Filesystem walk ────────────────────────────────────────────────── */

async function walk(dir, rootDir = dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    // Unreadable subfolder: report it once, keep scanning the rest.
    libraryEvents.emit('warning', `Cannot read ${dir}: ${error.code ?? error.message}`);
    return out;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, rootDir, out);
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(path.relative(rootDir, full));
    }
  }
  return out;
}

/* ── Cover art ──────────────────────────────────────────────────────── */

const COVER_EXTENSIONS = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

async function storeCover(track, picture) {
  const ext = COVER_EXTENSIONS[String(picture.format ?? '').toLowerCase()] ?? 'jpg';
  const target = path.join(COVER_DIR, `${track.id}.${ext}`);
  await fs.mkdir(COVER_DIR, { recursive: true });
  await fs.writeFile(target, Buffer.from(picture.data));
  return ext;
}

async function removeCovers(id) {
  try {
    const files = await fs.readdir(COVER_DIR);
    await Promise.all(
      files
        .filter((file) => file.startsWith(`${id}.`))
        .map((file) => fs.unlink(path.join(COVER_DIR, file)).catch(() => {})),
    );
  } catch {
    /* no cover dir yet */
  }
}

export async function getCoverPath(id) {
  try {
    const files = await fs.readdir(COVER_DIR);
    const match = files.find((file) => file.startsWith(`${id}.`));
    return match ? path.join(COVER_DIR, match) : null;
  } catch {
    return null;
  }
}

/* ── Scanning ───────────────────────────────────────────────────────── */

/** Run `worker` over `items`, at most `limit` at a time. */
async function pool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

async function inspect(relPath, cachedEntry) {
  const absPath = path.join(LIBRARY_DIR, relPath);
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return null;
  }

  const unchanged = cachedEntry && cachedEntry.mtimeMs === Math.round(stat.mtimeMs) && cachedEntry.size === stat.size;
  if (unchanged) return { track: cachedEntry, reused: true };

  let metadata = null;
  try {
    metadata = await parseFile(absPath, { duration: true, skipCovers: false });
  } catch (error) {
    libraryEvents.emit('warning', `Unreadable audio file ${relPath}: ${error.message}`);
  }

  const track = buildTrack({ absPath, relPath, stat, metadata });

  // Cover art goes to its own file — never into the JSON cache.
  if (metadata?.common?.picture?.length) {
    try {
      await storeCover(track, metadata.common.picture[0]);
      track.hasCover = true;
    } catch {
      track.hasCover = false;
    }
  } else if (cachedEntry?.hasCover) {
    await removeCovers(track.id);
    track.hasCover = false;
  }

  return { track, reused: false };
}

/**
 * Rescan the library folder. Cheap when nothing changed.
 * @param {{ force?: boolean }} [options] force re-reads tags for every file.
 */
export async function scan({ force = false } = {}) {
  // A change that lands while a scan is running would otherwise be swallowed
  // by that scan's already-finished file listing, so queue one more pass.
  if (scanning) {
    rescanQueued = true;
    queuedForce = queuedForce || force;
    return scanning;
  }

  scanning = (async () => {
    const started = Date.now();
    const cache = force ? { version: 1, tracks: Object.create(null) } : await readCache();
    const cachedTracks = cache.tracks ?? {};

    const relPaths = (await walk(LIBRARY_DIR)).sort();
    const nextTracks = Object.create(null);
    let added = 0;
    let updated = 0;
    let reused = 0;

    await pool(relPaths, 6, async (relPath) => {
      const cachedEntry = force ? null : cachedTracks[relPath];
      const result = await inspect(relPath, cachedEntry);
      if (!result) return;

      nextTracks[relPath] = result.track;
      if (result.reused) reused += 1;
      else if (cachedEntry) updated += 1;
      else added += 1;
    });

    const removedPaths = Object.keys(cachedTracks).filter((relPath) => !nextTracks[relPath]);
    for (const relPath of removedPaths) {
      const gone = cachedTracks[relPath];
      if (gone?.id) await removeCovers(gone.id);
    }

    tracksByPath = new Map(Object.entries(nextTracks));
    tracksById = new Map([...tracksByPath.values()].map((track) => [track.id, track]));
    await writeCache({ version: 1, tracks: nextTracks });

    lastScan = {
      at: Date.now(),
      durationMs: Date.now() - started,
      total: tracksById.size,
      added: added + updated,
      addedOnly: added,
      updated,
      removed: removedPaths.length,
      reused,
      changed: added + updated + removedPaths.length > 0,
    };

    if (lastScan.changed && lastScan.at > started) {
      libraryEvents.emit('change', lastScan);
    }
    return lastScan;
  })().finally(() => {
    scanning = null;
    if (rescanQueued) {
      const forceNext = queuedForce;
      rescanQueued = false;
      queuedForce = false;
      scan({ force: forceNext }).catch((error) => libraryEvents.emit('warning', `Rescan failed: ${error.message}`));
    }
  });

  return scanning;
}

/* ── Watcher ────────────────────────────────────────────────────────── */

/**
 * Watch the folder for changes, unless told not to.
 *
 * A watcher is a nicety, never a requirement: some hosting filesystems do not
 * deliver inotify events, and a container may cap them. `WATCH=0` turns it off
 * and the rescan button — always present, always working — does the job.
 */
export function startWatcher() {
  if (watcher || !WATCH) return;

  // Imported lazily so a missing optional dependency can never break startup.
  import('chokidar').then(({ watch }) => {
    let timer = null;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        scan().catch((error) => libraryEvents.emit('warning', `Rescan failed: ${error.message}`));
      }, 500);
    };

    watcher = watch(LIBRARY_DIR, {
      ignoreInitial: true,
      depth: 12,
      ignored: (target) => IGNORED_DIRS.has(path.basename(target)),
      awaitWriteFinish: { stabilityThreshold: 700, pollInterval: 150 },
    });
    watcher
      .on('add', schedule)
      .on('change', schedule)
      .on('unlink', schedule)
      .on('error', (error) => libraryEvents.emit('warning', `Watcher: ${error.code ?? error.message}`));
  }).catch(() => {
    /* watcher is a nicety; the rescan button still works */
  });
}

export function stopWatcher() {
  watcher?.close();
  watcher = null;
}

/* ── Accessors ──────────────────────────────────────────────────────── */

export function getTracks() {
  return [...tracksById.values()];
}

export function getTrack(id) {
  return tracksById.get(String(id)) ?? null;
}

/** The absolute folder, for the server's own logs and file access. */
export function getLibraryPath() {
  return LIBRARY_DIR;
}

/**
 * The folder as it was *configured* — `songs`, or whatever MUSIC_DIR says.
 * This, and never the resolved path, is what leaves the process: a public
 * deployment has no business telling visitors where the server keeps its
 * files.
 */
export function getLibraryLabel() {
  return MUSIC_DIR;
}

export function isWatching() {
  return Boolean(watcher);
}

/**
 * Payload sent to the client. Search fields are derived there instead.
 *
 * @param {{ absolute?: boolean }} [options] `absolute: false` (what a public
 *   deployment uses) reports the folder as configured instead of as resolved,
 *   so the response never carries a server path.
 */
export function getLibraryPayload({ absolute = true } = {}) {
  const tracks = getTracks()
    .map(toPublicTrack)
    .sort((a, b) => a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' }));

  return {
    tracks,
    libraryPath: absolute ? LIBRARY_DIR : getLibraryLabel(),
    scan: lastScan,
  };
}

export function isLibraryAvailable() {
  return fssync.existsSync(LIBRARY_DIR);
}
