/**
 * Shared excerpt start logic — imported by BOTH the Node server (authoritative
 * for multiplayer) and the browser client (singleplayer). Kept as plain JS so
 * Node can require it without a build step.
 */
import config from '../config.js';

/** Draft of the current song. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(value) {
  let out = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    out ^= value.charCodeAt(i);
    out = Math.imul(out, 16777619);
  }
  return out >>> 0;
}

function longestExcerpt() {
  const durations = config.round.durations;
  return durations[durations.length - 1] ?? 10;
}

/** The range of seconds the excerpt may start in, for a track of this length. */
function excerptWindow(duration) {
  const { minStartSeconds, introSkipRatio, latestStartRatio, tailPaddingSeconds } = config.excerpt;
  const longest = longestExcerpt();

  const earliest = Math.max(minStartSeconds, duration * introSkipRatio);
  const latest = Math.min(duration * latestStartRatio, duration - longest - tailPaddingSeconds);
  return { earliest, latest };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * @param {object} track  a track with a numeric `duration` (seconds)
 * @param {number} [seed] pin the choice (the 'stable' strategy, and tests)
 */
export function pickExcerptStart(track, seed) {
  const { strategy, fixedStartSeconds } = config.excerpt;
  const duration = track.duration;

  // Unknown or very short tracks: play from the top and let the client clamp
  // the excerpt to whatever is actually there.
  if (!Number.isFinite(duration) || duration <= 0) return 0;

  if (strategy === 'fixed') return Math.min(fixedStartSeconds, Math.max(0, duration - 1));

  const { earliest, latest } = excerptWindow(duration);

  if (latest <= earliest) {
    const longest = Math.min(longestExcerpt(), duration);
    return round(Math.max(0, (duration - longest) / 2));
  }

  const random =
    strategy === 'stable'
      ? mulberry32(hash(track.id) ^ (seed ?? 0))()
      : seed !== undefined
        ? mulberry32(seed)()
        : Math.random();

  return round(earliest + random * (latest - earliest));
}

/** The excerpt's end, clamped so it never runs past the end of the file. */
export function excerptEnd(startSec, duration, excerptSeconds) {
  const end = startSec + excerptSeconds;
  if (!Number.isFinite(duration) || duration <= 0) return end;
  return Math.min(end, duration);
}