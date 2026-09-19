/**
 * Multiplayer scoring — server-authoritative.
 *
 * The rule that matters most is the scoring invariant: the reveal level a
 * player needed is the primary factor, and the same-level speed bonus must
 * NEVER be large enough to let a worse reveal level outscore a better one.
 *
 * The base table is strictly decreasing and the gaps are always wider than the
 * speed bonus maximum (100 < min gap of 200), so the invariant is guaranteed
 * by construction.
 */
import config from '../config.js';

/** Raw base points for a reveal step, from the config table. */
export function basePointsForStep(step) {
  const table = config.scoring.pointsByStep;
  return table[Math.min(Math.max(step, 0), table.length - 1)] ?? table[table.length - 1] ?? 0;
}

/**
 * Same-level speed bonus, 0..speedBonusMax.
 * Linear: an answer in 0s earns the full bonus, an answer at or beyond
 * `speedBonusWindowSeconds` earns 0.
 *
 * @param {number} sameLevelSeconds  seconds between the reveal level becoming
 *   active and the correct submission (measured server-side)
 */
export function speedBonusFor(sameLevelSeconds) {
  const { speedBonusMax, speedBonusWindowSeconds } = config.scoring;
  if (!Number.isFinite(sameLevelSeconds) || sameLevelSeconds < 0) return 0;
  if (sameLevelSeconds >= speedBonusWindowSeconds) return 0;
  const raw = speedBonusMax * (1 - sameLevelSeconds / speedBonusWindowSeconds);
  return Math.max(0, Math.min(speedBonusMax, Math.round(raw)));
}

/**
 * Final points for a correct answer at a given reveal step.
 *
 * @param {number} step  index into `round.durations`
 * @param {number} sameLevelSeconds  server-measured answer speed at that level
 * @param {number} wrongGuesses  wrong guesses on this round (singleplayer only)
 */
export function scoreAnswer(step, sameLevelSeconds, wrongGuesses = 0) {
  const { wrongGuessPenalty, minPointsRatio } = config.scoring;
  const base = basePointsForStep(step);
  const floor = Math.round(base * minPointsRatio);
  const penalty = Math.min(wrongGuesses * wrongGuessPenalty, base - floor);
  return base - penalty + speedBonusFor(sameLevelSeconds);
}