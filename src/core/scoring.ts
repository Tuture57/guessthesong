/**
 * Scoring: the earlier the guess, the bigger the reward.
 *
 * Points come from the reveal step the player stopped at — that is the primary
 * factor everywhere, singleplayer and multiplayer alike. Wrong guesses shave a
 * little off in singleplayer, a running streak adds a bonus, and answering
 * quickly *within the same reveal level* adds a small speed bonus.
 *
 * The speed bonus can never bridge two reveal levels: the base table falls by
 * 200 points per step while the bonus caps at 100. That invariant is enforced
 * by `assertScoringInvariant`, which the QA suite also checks.
 */
import { gameConfig } from './types';
import { basePointsForStep, speedBonusFor } from '../../shared/scoring.js';

export interface ScoreBreakdown {
  /** Points for the reveal step, before penalties. */
  base: number;
  /** Points removed for wrong guesses. */
  penalty: number;
  /** Points added for answering quickly at this reveal level. */
  speedBonus: number;
  /** Multiplier applied for a running streak, e.g. 0.2 for +20%. */
  streakBonus: number;
  total: number;
}

/**
 * Score a singleplayer round.
 *
 * Singleplayer keeps its own shape: the reveal step sets the base, wrong
 * guesses shave a little off, and a running streak adds a percentage. The
 * same-level speed bonus is multiplayer's — playing alone has no competitors
 * to out-recognise.
 *
 * @param step          index into `round.durations`
 * @param wrongGuesses  wrong guesses made this round
 * @param streak        streak going into this round
 */
export function scoreRound(step: number, wrongGuesses: number, streak: number): ScoreBreakdown {
  const { wrongGuessPenalty, minPointsRatio, streakBonusPerRound, maxStreakBonus } = gameConfig.scoring;

  const base = basePointsForStep(step);
  const floor = Math.round(base * minPointsRatio);
  const penalty = Math.min(wrongGuesses * wrongGuessPenalty, base - floor);
  const afterPenalty = base - penalty;
  const streakBonus = Math.min(streak * streakBonusPerRound, maxStreakBonus);
  const total = Math.round(afterPenalty * (1 + streakBonus));

  return { base, penalty, speedBonus: 0, streakBonus, total };
}

/**
 * The same-level speed bonus for a correct multiplayer answer — the amount the
 * server adds on top of the base reveal score. Exposed so the UI can label it.
 */
export function multiplayerSpeedBonus(sameLevelSeconds: number): number {
  return speedBonusFor(sameLevelSeconds);
}

/**
 * Guarantees the scoring invariant mathematically:
 *   max score at a worse reveal level  <  min score at a better reveal level.
 *
 * Called once at startup and by the QA suite; throws rather than shipping a
 * config where speed could outrank recognition.
 */
export function assertScoringInvariant(): void {
  const { pointsByStep, speedBonusMax } = gameConfig.scoring;
  for (let i = 0; i < pointsByStep.length - 1; i += 1) {
    const bestAtWorseLevel = pointsByStep[i + 1] + speedBonusMax;
    const worstAtBetterLevel = pointsByStep[i];
    if (bestAtWorseLevel >= worstAtBetterLevel) {
      throw new Error(
        `Scoring invariant broken between step ${i} (${pointsByStep[i]}) and step ${i + 1} ` +
          `(${pointsByStep[i + 1]}): a fast worse-level answer (${bestAtWorseLevel}) can beat a slow better-level one (${worstAtBetterLevel}).`,
      );
    }
  }
}
