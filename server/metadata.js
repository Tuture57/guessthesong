/**
 * Turning a file on disk into a track the game can use.
 *
 * Metadata comes from embedded tags when they exist. A lot of downloaded music
 * has tags that are technically present but useless ("RoK - Boulbi" as the
 * title of a RoK song), so tags are cleaned up before they reach the player.
 * When there are no tags at all we fall back to parsing the filename.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config.js';

const DOWNLOADERS =
  'soundloadmate|soundcloudmate|spotisaver|spotisave|spotifydown|mp3juice|mp3juices|y2mate|ytmp3|ytdl|savefrom|convert2mp3|online-audio-converter|audio-joiner|flvto|dirremix|waptrick';

const NOISE_PATTERNS = [
  new RegExp(`\\s*[-–—]\\s*(${DOWNLOADERS})\\.?\\w*\\s*$`, 'i'),
  // The same markers in brackets — "Titre (SPOTISAVER)", "Titre [Official Video]".
  new RegExp(`\\s*[\\[(]\\s*(${DOWNLOADERS})\\s*[\\])]\\s*`, 'gi'),
  /\s*[\[(](official\s*(music\s*)?video|official\s*audio|lyrics?|audio|hd|hq|4k|m\/v|visuali[sz]er|clip\s*officiel)[\])]\s*/gi,
  /\s*(www\.[a-z0-9-]+\.[a-z]{2,}\S*)\s*/gi,
  /\s*\bhd\b\s*$/i,
];

/** Remove downloader watermarks and "(Official Video)"-style noise. */
function stripNoise(value) {
  let out = value;
  for (const pattern of NOISE_PATTERNS) out = out.replace(pattern, ' ');
  return out.replace(/\s{2,}/g, ' ').trim();
}

/** Diacritic-free, punctuation-free, lowercase form used for comparisons. */
function normalizeForCompare(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`´]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Separator-free form, so "R.O.K" and "RoK" collapse to the same key. */
function normalizeCompact(value) {
  return normalizeForCompare(value).replace(/\s+/g, '');
}

/**
 * One artist, one spelling. Tags and filenames drift ("RoK", "rok", "R.O.K"),
 * and the game should always show the canonical name from config.
 */
function canonicalArtist(value) {
  const name = String(value ?? '').trim();
  if (!name) return '';
  const aliases = config.library.artistAliases ?? {};
  return aliases[normalizeCompact(name)] ?? name;
}

/**
 * "RoK - Boulbi" by "R.O.K" is really just "Boulbi".
 * Also handles "RoK Ft KoR - Semelew".
 */
function stripArtistPrefix(title, artist) {
  const match = title.match(/^(.{1,60}?)\s*[-–—]\s*(.+)$/);
  if (!match) return title;

  const [, prefix, rest] = match;
  if (!rest.trim()) return title;

  const prefixKey = normalizeForCompare(prefix);
  const prefixCompact = prefixKey.replace(/\s+/g, '');
  const artistCompact = normalizeCompact(artist);

  const isArtistPrefix = Boolean(artistCompact) && prefixCompact === artistCompact;
  const isCollabPrefix = /(^|\s)(ft|feat|featuring|avec)(\s|$)/.test(prefixKey);
  return isArtistPrefix || isCollabPrefix ? rest.trim() : title;
}

/**
 * Best-effort guess from a filename like "Artist - Title - Artist.mp3".
 * Only used when a file has no usable tags.
 */
function parseFromFilename(baseName, artistTag) {
  const cleaned = stripNoise(baseName.replace(/\.[^.]+$/, '').replace(/_+/g, ' '));
  const parts = cleaned
    .split(/\s+[-–—]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return { title: cleaned, artist: artistTag || '' };
  if (parts.length === 1) return { title: parts[0], artist: artistTag || '' };

  // If one part repeats, that part is almost certainly the artist.
  const counts = new Map();
  for (const part of parts) {
    const key = normalizeForCompare(part);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const repeated = [...counts.entries()].find(([, count]) => count > 1)?.[0];
  if (repeated) {
    const title = parts.find((part) => normalizeForCompare(part) !== repeated);
    const artist = parts.find((part) => normalizeForCompare(part) === repeated);
    if (title) return { title, artist: artistTag || artist };
  }

  const artistKey = normalizeForCompare(artistTag);
  const withoutArtist = parts.find((part) => normalizeForCompare(part) !== artistKey);
  if (artistKey && withoutArtist) return { title: withoutArtist, artist: artistTag };

  // Conventional "Artist - Title": the title comes last.
  return { title: parts[parts.length - 1], artist: artistTag || parts[0] };
}

/** Stable short id derived from the library-relative path. */
function trackId(relPath) {
  return crypto.createHash('sha1').update(relPath.toLowerCase()).digest('hex').slice(0, 12);
}

/**
 * @param {object} input
 * @param {string} input.absPath
 * @param {string} input.relPath  path relative to the library root
 * @param {object} input.stat     fs stat result
 * @param {object|null} input.metadata  music-metadata result, or null if unreadable
 */
export function buildTrack({ absPath, relPath, stat, metadata }) {
  const fileName = path.basename(relPath);
  const baseName = fileName.replace(/\.[^.]+$/, '');
  const folder = path.dirname(relPath) === '.' ? '' : path.dirname(relPath);
  const common = metadata?.common ?? {};
  const format = metadata?.format ?? {};

  const tagArtist = canonicalArtist(stripNoise(String(common.artist ?? common.albumartist ?? '').trim()));
  let title = stripNoise(String(common.title ?? '').trim());

  let artist = tagArtist;
  if (title) {
    title = stripArtistPrefix(title, artist);
    // No artist tag: the filename is the only place left to look for one.
    if (!artist) artist = parseFromFilename(baseName, '').artist;
  } else {
    const parsed = parseFromFilename(baseName, tagArtist);
    title = parsed.title;
    artist = parsed.artist;
  }

  title = (title || baseName).trim();
  artist = canonicalArtist(artist);

  const duration = Number.isFinite(format.duration) ? Number(format.duration) : 0;
  const picture = Array.isArray(common.picture) ? common.picture[0] : null;

  return {
    id: trackId(relPath),
    relPath,
    fileName,
    folder,
    title,
    artist,
    album: stripNoise(String(common.album ?? '').trim()),
    year: Number.isFinite(common.year) ? common.year : null,
    duration: Math.round(duration * 1000) / 1000,
    format: String(format.container ?? path.extname(fileName).slice(1)).toLowerCase(),
    hasCover: Boolean(picture),
    // Files we could not read still show up, but never crash a round.
    unreadable: !metadata,
    mtimeMs: Math.round(stat.mtimeMs),
    size: stat.size,
  };
}

/** Same track minus the fields the client does not need. */
export function toPublicTrack(track) {
  const { mtimeMs, size, unreadable, ...rest } = track;
  return { ...rest, unreadable: Boolean(unreadable) };
}
