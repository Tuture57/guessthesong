/**
 * Answer matching.
 *
 * Forgiving about the things a player cannot be expected to reproduce exactly
 * — case, accents, apostrophes, punctuation, "feat." clauses, bracketed
 * suffixes, and the artist being typed in front of the title. Strict about
 * everything else: a guess only counts if the whole title is there.
 */
import type { Track } from './types';

const FEATURE_CLAUSE = /\s+(?:ft|feat|featuring|avec)\b.*$/;
const BRACKETED = /[([{][^)\]}]*[)\]}]+/g;

function stripDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** The canonical form two answers are compared in. */
export function normalizeAnswer(value: string, ignoreBracketed = true): string {
  let out = stripDiacritics(String(value ?? '')).toLowerCase();
  if (ignoreBracketed) out = out.replace(BRACKETED, ' ');
  out = out
    .replace(/&/g, ' and ')
    .replace(/['’`´]/g, '')
    .replace(FEATURE_CLAUSE, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return out;
}

/** Damerau-Levenshtein distance, capped early since we only care about 0–2. */
function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  const current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        current[j] = Math.min(current[j], previous[j - 2] + 1); // transposition
      }
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > max) return max + 1;
    previous = current.slice();
  }
  return previous[b.length];
}

/** How many typos we allow, scaled to how long the answer is. */
function toleranceFor(length: number): number {
  if (length < 6) return 0; // "DLEH", "Yéti", "BRAX" — too short to guess at
  if (length < 10) return 1;
  return 2;
}

/** True when the two strings are within the typo budget for their length. */
function withinTolerance(guess: string, target: string): boolean {
  if (guess === target) return true;
  if (!target) return false;
  const budget = toleranceFor(target.length);
  if (budget === 0) return false;
  return editDistance(guess, target, budget) <= budget;
}

export interface MatchResult {
  track: Track;
  /** 'exact' — the title was typed out. 'fuzzy' — a typo away. */
  kind: 'exact' | 'fuzzy';
}

/** Precomputed comparison keys for a track. */
export interface MatchIndex {
  track: Track;
  title: string;
  artist: string;
  /** "artist title" in both orders, so any reasonable phrasing works. */
  full: string[];
  /** Punctuation-free haystack: makes "R.O.K" findable by typing "rok". */
  compact: string;
}

export function buildMatchIndex(tracks: Track[], ignoreBracketed: boolean): MatchIndex[] {
  return tracks.map((track) => {
    const title = normalizeAnswer(track.title, ignoreBracketed);
    const artist = normalizeAnswer(track.artist, ignoreBracketed);
    const full = artist ? [`${artist} ${title}`, `${title} ${artist}`] : [];
    return { track, title, artist, full, compact: `${title}${artist}`.replace(/\s+/g, '') };
  });
}

/**
 * Find the track a guess refers to.
 *
 * Exact matches are considered across the whole library before any fuzzy
 * match is allowed, so a near-miss can never shadow a song the player named
 * correctly.
 */
export function resolveGuess(
  guess: string,
  index: MatchIndex[],
  options: { ignoreBracketed: boolean; requireArtist: boolean },
): MatchResult | null {
  const value = normalizeAnswer(guess, options.ignoreBracketed);
  if (!value) return null;

  for (const entry of index) {
    if (matchesExactly(value, entry, options.requireArtist)) return { track: entry.track, kind: 'exact' };
  }
  for (const entry of index) {
    if (matchesLoosely(value, entry, options.requireArtist)) return { track: entry.track, kind: 'fuzzy' };
  }
  return null;
}

/** True when the track has no artist to check against. */
function artistSatisfied(value: string, entry: MatchIndex, required: boolean): boolean {
  if (!required || !entry.artist) return true;
  return value.includes(entry.artist);
}

function matchesExactly(value: string, entry: MatchIndex, requireArtist: boolean): boolean {
  // The title alone ("yéti"), or the artist typed alongside it in either order
  // ("rok yéti", "yéti rok") — `full` holds both.
  if (entry.title === value && artistSatisfied(value, entry, requireArtist)) return true;
  return entry.full.includes(value);
}

function matchesLoosely(value: string, entry: MatchIndex, requireArtist: boolean): boolean {
  if (!artistSatisfied(value, entry, requireArtist)) return false;
  if (withinTolerance(value, entry.title)) return true;
  return entry.full.some((variant) => withinTolerance(value, variant));
}

export interface Suggestion {
  track: Track;
  score: number;
}

/**
 * Rank tracks for the autocomplete list. Every suggestion is a real track from
 * the library — nothing is invented.
 */
export function searchTracks(query: string, index: MatchIndex[], limit: number): Suggestion[] {
  const value = normalizeAnswer(query, true);
  if (value.length < 2) return [];

  const tokens = value.split(' ');
  const compactValue = value.replace(/\s+/g, '');
  const results: Suggestion[] = [];

  for (const entry of index) {
    const title = entry.title;
    const haystack = `${title} ${entry.artist}`.trim();
    if (!haystack) continue;

    let score = 0;
    if (title === value) score = 1000;
    else if (title.startsWith(value)) score = 800 - title.length * 0.1;
    else if (haystack.startsWith(value)) score = 700 - haystack.length * 0.1;
    else if (title.includes(value)) score = 600 - title.indexOf(value);
    else if (haystack.includes(value)) score = 500 - haystack.indexOf(value);
    else if (tokens.length > 1 && tokens.every((token) => haystack.includes(token))) score = 400 - haystack.length * 0.1;
    // Last resort: match against the punctuation-free form, so "rok" finds
    // a track whose artist tag is "R.O.K".
    else if (compactValue.length >= 2 && entry.compact.includes(compactValue)) score = 250 - entry.compact.indexOf(compactValue);
    else if (tokens.every((token) => haystack.startsWith(token))) score = 200;
    else continue;

    results.push({ track: entry.track, score });
  }

  return results
    .sort((a, b) => b.score - a.score || a.track.title.localeCompare(b.track.title))
    .slice(0, limit);
}
