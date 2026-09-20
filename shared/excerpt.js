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

/**
 * The range of seconds the excerpt may start in, for a track of this length.
 *
 * `maxStart` is the hard ceiling and it is a *correctness* bound, not a taste
 * one: the longest reveal in the ladder must fit inside the file with the tail
 * padding to spare. Every other term is clamped to it, so no combination of
 * ratios can produce a start the 15-second excerpt cannot reach. Both ends are
 * clamped to it, which is what keeps `earliest <= latest` true on a track too
 * short to have a window at all — a 20-second track collapses to a single
 * legal position instead of an inverted range.
 */
function excerptWindow(duration) {
  const { minStartSeconds, introSkipRatio, latestStartRatio, tailPaddingSeconds } = config.excerpt;
  const longest = longestExcerpt();

  const maxStart = Math.max(0, duration - longest - tailPaddingSeconds);
  const earliest = Math.min(Math.max(minStartSeconds, duration * introSkipRatio), maxStart);
  const latest = Math.min(Math.max(duration * latestStartRatio, earliest), maxStart);
  return { earliest, latest, maxStart };
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