/**
 * Game state and round flow.
 *
 * Knows nothing about the DOM. The UI subscribes, reads the state and renders;
 * every transition happens here.
 */
import { audio } from './audio';
import { excerptEnd, pickExcerptStart } from './excerpt';
import { library } from './library';
import { resolveGuess } from './matching';
import { scoreRound } from './scoring';
import type { ScoreBreakdown } from './scoring';
import { storage } from './storage';
import { gameConfig } from './types';
import type { Mode, PersistedStats, Phase, Round, RoundResult, Screen, Track } from './types';

export type GuessOutcome = 'correct' | 'wrong' | 'empty';

function shuffle<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export class Game {
  screen: Screen = 'home';
  mode: Mode = 'quick';
  roundsPerGame = gameConfig.game.roundsPerGame;
  /** 'all', or the folder name the player filtered the library by. */
  category = 'all';
  roundIndex = 0;
  score = 0;
  streak = 0;
  bestStreak = 0;
  correct = 0;
  history: RoundResult[] = [];
  round: Round | null = null;
  phase: Phase = 'guessing';
  breakdown: ScoreBreakdown | null = null;
  /** True once the round's answer has been shown to the player. */
  revealed = false;
  stats: PersistedStats;
  /** Bumped on every finished round so the UI can animate the score. */
  scoreFlash = 0;

  private queue: Track[] = [];
  private lastTrackId: string | null = null;
  private bestScoreBeforeRun = 0;
  private listeners = new Set<() => void>();

  constructor() {
    this.stats = storage.loadStats();
    const settings = storage.loadSettings();
    this.mode = settings.mode;
    this.roundsPerGame = settings.roundsPerGame || gameConfig.game.roundsPerGame;
    this.category = settings.category || 'all';
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    for (const listener of this.listeners) listener();
  }

  /* ── Derived values ───────────────────────────────────────────────── */

  get durations(): number[] {
    return gameConfig.round.durations;
  }

  get currentDuration(): number {
    return this.durations[this.round?.step ?? 0] ?? 0;
  }

  get isLastStep(): boolean {
    return (this.round?.step ?? 0) >= this.durations.length - 1;
  }

  get nextDuration(): number | null {
    if (!this.round || this.isLastStep) return null;
    return this.durations[this.round.step + 1];
  }

  /** Total rounds in this run, or Infinity for Quick Play. */
  get totalRounds(): number {
    return this.mode === 'rounds' ? this.roundsPerGame : Number.POSITIVE_INFINITY;
  }

  get roundNumber(): number {
    return this.roundIndex + 1;
  }

  get answerMode(): 'title' | 'title+artist' {
    return gameConfig.round.answerMode;
  }

  get requiresArtist(): boolean {
    return this.answerMode === 'title+artist';
  }

  /** End of the current excerpt, clamped to the file's real length. */
  excerptEndSeconds(): number {
    if (!this.round) return 0;
    return excerptEnd(this.round.startSec, this.round.track.duration, this.currentDuration);
  }

  excerptLengthSeconds(): number {
    if (!this.round) return 0;
    return Math.max(0, this.excerptEndSeconds() - this.round.startSec);
  }

  /* ── Flow ─────────────────────────────────────────────────────────── */

  start(mode: Mode, roundsPerGame = this.roundsPerGame): void {
    this.mode = mode;
    this.roundsPerGame = Math.max(1, Math.floor(roundsPerGame));
    this.screen = 'game';
    this.roundIndex = 0;
    this.score = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.correct = 0;
    this.history = [];
    this.queue = [];
    this.lastTrackId = null;
    this.bestScoreBeforeRun = this.stats.bestScore;

    this.saveSettings();
    this.beginRound();
  }

  /** Back to the menu. Stops any audio so nothing plays over the home screen. */
  quit(): void {
    audio.stop();
    this.screen = 'home';
    this.round = null;
    this.phase = 'guessing';
    this.revealed = false;
    this.breakdown = null;
    this.notify();
  }

  /**
   * The tracks this run may draw from. When the selected folder has vanished
   * (renamed or deleted since it was chosen) the filter falls back to the
   * whole library rather than leaving the game with nothing to play.
   */
  private pool(): Track[] {
    const scoped = library.tracksIn(this.category);
    if (scoped.length > 0) return scoped;
    this.category = 'all';
    return library.playable();
  }

  private nextTrackFromQueue(): Track | null {
    const pool = this.pool();
    if (pool.length === 0) return null;

    if (this.queue.length === 0) {
      this.queue = shuffle(pool);
      // Avoid handing the player the same song twice in a row across shuffles.
      if (this.queue.length > 1 && this.queue[0].id === this.lastTrackId) {
        [this.queue[0], this.queue[1]] = [this.queue[1], this.queue[0]];
      }
    }

    const track = this.queue.shift() ?? null;
    if (track) this.lastTrackId = track.id;
    return track;
  }

  /** Whichever track the next round would use — used to warm the audio cache. */
  peekNextTrack(): Track | null {
    const pool = this.pool();
    if (pool.length === 0) return null;
    if (this.queue.length === 0) {
      const preview = shuffle(pool);
      if (preview.length > 1 && preview[0].id === this.lastTrackId) {
        [preview[0], preview[1]] = [preview[1], preview[0]];
      }
      return preview[0];
    }
    return this.queue[0];
  }

  private beginRound(): void {
    const track = this.nextTrackFromQueue();
    if (!track) {
      // Empty or unreadable library — the UI shows an empty state.
      this.round = null;
      this.notify();
      return;
    }

    this.round = {
      track,
      startSec: pickExcerptStart(track),
      step: 0,
      attempts: [],
      events: [],
      solved: false,
      givenUp: false,
      levelStartedAt: Date.now(),
      answerSeconds: null,
    };
    this.phase = 'guessing';
    this.revealed = false;
    this.breakdown = null;

    audio.stop();
    // Decode this track now, then the next one, so PLAY is instant here and
    // the following round is already decoded before the player reaches it.
    const upcoming = this.peekNextTrack();
    void audio.prepare(track.id).then(() => {
      if (upcoming) void audio.prepare(upcoming.id);
    });

    this.notify();
  }

  guess(text: string): GuessOutcome {
    if (!this.round || this.phase === 'revealed') return 'empty';
    const value = text.trim();
    if (!value) return 'empty';

    const match = resolveGuess(value, library.matchIndex, {
      ignoreBracketed: gameConfig.matching.ignoreBracketedSuffixes,
      requireArtist: this.requiresArtist,
    });

    if (match && match.track.id === this.round.track.id) {
      // Speed is measured from the moment this reveal level became active —
      // recognising a 0.5s clip slowly still beats needing the 2s clip.
      this.round.answerSeconds = Math.max(0, (Date.now() - this.round.levelStartedAt) / 1000);
      this.round.events.push({ kind: 'guess', text: value, step: this.round.step, correct: true });
      this.finishRound(true);
      return 'correct';
    }

    // Repeating a guess the player already made is not a new mistake.
    const alreadyTried = this.round.attempts.some((attempt) => attempt.text.toLowerCase() === value.toLowerCase());
    if (!alreadyTried) {
      this.round.attempts.push({ text: value });
      this.round.events.push({ kind: 'guess', text: value, step: this.round.step, correct: false });
    }
    this.notify();
    return 'wrong';
  }

  /** Unlock the next excerpt, or give up when there is nothing left to unlock. */
  revealMore(): void {
    if (!this.round || this.phase === 'revealed') return;
    audio.stop();

    if (this.isLastStep) {
      this.round.givenUp = true;
      this.finishRound(false);
      return;
    }
    this.round.events.push({ kind: 'skip', step: this.round.step });
    this.round.step += 1;
    // The clock for "how fast did you answer at this level" restarts here.
    this.round.levelStartedAt = Date.now();
    this.notify();
  }

  private finishRound(solved: boolean): void {
    if (!this.round) return;
    audio.stop();

    const { step, attempts } = this.round;
    const breakdown = solved ? scoreRound(step, attempts.length, this.streak) : null;
    const points = breakdown?.total ?? 0;

    this.round.solved = solved;
    this.phase = 'revealed';
    this.revealed = true;
    this.breakdown = breakdown;
    this.scoreFlash += 1;

    this.score += points;
    if (solved) {
      this.streak += 1;
      this.correct += 1;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
    } else {
      this.streak = 0;
    }

    this.history.push({
      track: this.round.track,
      step,
      duration: this.durations[step] ?? 0,
      attempts: attempts.length,
      solved,
      points,
      answerSeconds: this.round.answerSeconds,
    });

    this.persistStats(false);
    this.notify();
  }

  /** Move on: next round, or the results screen when the run is over. */
  next(): void {
    audio.stop();
    const finishedGame = this.mode === 'rounds' && this.history.length >= this.roundsPerGame;

    if (finishedGame) {
      this.persistStats(true);
      this.screen = 'results';
      this.notify();
      return;
    }

    this.roundIndex = this.history.length;
    this.beginRound();
  }

  playAgain(): void {
    this.start(this.mode, this.roundsPerGame);
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.saveSettings();
    this.notify();
  }

  setRoundsPerGame(rounds: number): void {
    this.roundsPerGame = Math.max(1, Math.floor(rounds));
    this.saveSettings();
    this.notify();
  }

  /** Restrict the singleplayer draw to one folder, or 'all'. */
  setCategory(category: string): void {
    this.category = category || 'all';
    this.saveSettings();
    this.notify();
  }

  private saveSettings(): void {
    storage.saveSettings({ mode: this.mode, roundsPerGame: this.roundsPerGame, category: this.category });
  }

  private persistStats(gameFinished: boolean): void {
    this.stats = {
      bestScore: Math.max(this.stats.bestScore, this.score),
      bestStreak: Math.max(this.stats.bestStreak, this.bestStreak),
      gamesPlayed: this.stats.gamesPlayed + (gameFinished ? 1 : 0),
      totalCorrect: this.stats.totalCorrect + (gameFinished ? this.correct : 0),
      totalRounds: this.stats.totalRounds + (gameFinished ? this.history.length : 0),
    };
    storage.saveStats(this.stats);
  }

  /** True when this run beat the score stored from previous sessions. */
  get beatPersonalBest(): boolean {
    return this.score > 0 && this.score > this.bestScoreBeforeRun;
  }
}

export const game = new Game();
