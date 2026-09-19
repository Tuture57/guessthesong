/**
 * Shared multiplayer guess matching for Node.
 *
 * Mirrors the client's `normalizeAnswer` / `resolveGuess` closely enough that
 * the player's local feedback agrees with the server verdict. The server's
 * verdict is the one that counts — the client never decides a round.
 *
 * Written as plain JS (no TypeScript import) so Node can use it directly.
 */
const FEATURE_CLAUSE = /\s+(?:ft|feat|featuring|avec)\b.*$/;
const BRACKETED = /[([{][^)\]}]*[)\]}]+/g;

function stripDiacritics(value) {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** The canonical form two answers are compared in. Mirrors matching.ts. */
export function normalizeAnswer(value, ignoreBracketed = true) {
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
function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  const current = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        current[j] = Math.min(current[j], previous[j - 2] + 1);
      }
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > max) return max + 1;
    previous = current.slice();
  }
  return previous[b.length];
}

/** How many typos we allow, scaled to how long the answer is. */
function toleranceFor(length) {
  if (length < 6) return 0;
  if (length < 10) return 1;
  return 2;
}

/**
 * Does `guess` name this track? True for the title alone, the title with the
 * artist in either order, or a near-miss within the typo budget.
 */
export function guessNamesTrack(guess, track) {
  const value = normalizeAnswer(guess, true);
  if (!value || !track) return false;

  const title = normalizeAnswer(track.title, true);
  const artist = normalizeAnswer(track.artist, true);
  const variants = [title];
  if (artist) variants.push(`${artist} ${title}`, `${title} ${artist}`);

  if (variants.includes(value)) return true;

  if (!title) return false;
  const budget = toleranceFor(title.length);
  if (budget === 0) return false;
  return variants.some((variant) => editDistance(value, variant, budget) <= budget);
}

/**
 * @param {string} guess
 * @param {object[]} tracks  the library snapshot used for this room
 * @param {string} trackId   the round's track id
 */
export function isCorrectGuess(guess, tracks, trackId) {
  if (!guess || !Array.isArray(tracks) || !trackId) return false;
  const track = tracks.find((candidate) => candidate.id === trackId);
  if (!track) return false;
  return guessNamesTrack(guess, track);
}
