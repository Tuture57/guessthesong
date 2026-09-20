import config from '../../config.js';

export interface Track {
  id: string;
  relPath: string;
  fileName: string;
  folder: string;
  title: string;
  artist: string;
  album: string;
  year: number | null;
  duration: number;
  format: string;
  hasCover: boolean;
  unreadable: boolean;
}

export interface ScanStats {
  at: number;
  durationMs: number;
  total: number;
  added: number;
  addedOnly: number;
  updated: number;
  removed: number;
  reused: number;
  changed: boolean;
}

export interface LibraryPayload {
  tracks: Track[];
  libraryPath: string;
  scan: ScanStats | null;
}

export interface GameConfig {
  library: {
    path: string;
    extensions: string[];
    cacheFile: string;
    watch: boolean;
    artistAliases: Record<string, string>;
  };
  round: {
    durations: number[];
    answerMode: 'title' | 'title+artist';
  };
  excerpt: {
    strategy: 'random' | 'stable' | 'fixed';
    fixedStartSeconds: number;
    minStartSeconds: number;
    introSkipRatio: number;
    latestStartRatio: number;
    tailPaddingSeconds: number;
  };
  scoring: {
    pointsByStep: number[];
    wrongGuessPenalty: number;
    minPointsRatio: number;
    streakBonusPerRound: number;
    maxStreakBonus: number;
    giveUpPoints: number;
    speedBonusMax: number;
    speedBonusWindowSeconds: number;
  };
  game: {
    roundsPerGame: number;
  };
  matching: {
    ignoreBracketedSuffixes: boolean;
  };
  ui: {
    autocompleteLimit: number;
    spaceToPlay: boolean;
  };
  multiplayer: {
    maxPlayers: number;
    roomCodeLength: number;
    roundsChoices: number[];
    defaultRounds: number;
    maxRounds: number;
    roundSeconds: number;
    intermissionSeconds: number;
    idleRoomTimeoutSeconds: number;
  };
  server: {
    port: number;
  };
}

export const gameConfig = config as unknown as GameConfig;

/** Web Audio needs a little memory; two tracks is plenty and keeps RAM sane. */
export const audioConfig = {
  decodedCacheSize: 2,
  encodedCacheSize: 6,
  fadeInSeconds: 0.003,
  fadeOutSeconds: 0.006,
  // A full song starts from a standstill, so it gets a softer entry.
  songFadeInSeconds: 0.12,
};

export type Screen = 'home' | 'game' | 'results';
export type Mode = 'quick' | 'rounds';
export type Phase = 'guessing' | 'revealed';

/* ── Multiplayer ─────────────────────────────────────────────────────── */

/** A player's public status inside a room. Never carries a reveal level. */
export type MpStatus = 'lobby' | 'guessing' | 'finished' | 'gaveup' | 'timedout' | 'exhausted' | 'away';

/**
 * How many guesses a player gets.
 *   unlimited — guess as often as you like; skipping is the only way forward
 *   perReveal — one guess per reveal level; a wrong one reveals the next level
 *   single    — one guess for the whole song
 */
export type MpAttemptMode = 'unlimited' | 'perReveal' | 'single';

/** One thing a player did on one song: a guess, or a skip. */
export interface AttemptEvent {
  kind: 'guess' | 'skip';
  /** The reveal level it happened at. */
  step: number;
  /** The submitted text, for guesses. */
  text?: string;
  correct?: boolean;
}

export interface MpPlayer {
  id: string;
  name: string;
  isHost: boolean;
  connected: boolean;
  status: MpStatus;
  ready: boolean;
  score: number;
}

export interface MpRoom {
  code: string;
  phase: 'lobby' | 'playing' | 'resolved' | 'ended';
  hostId: string | null;
  settings: { rounds: number; category: string; attemptMode: MpAttemptMode; roundSeconds: number };
  roundNumber: number;
  totalRounds: number;
  endsAt: number | null;
  nextAt: number | null;
  /** Address of the next round's audio, published only between rounds. */
  nextToken: string | null;
  players: MpPlayer[];
}

/** The one player's own private state. */
export interface MpSelf {
  playerId: string;
  step: number;
  status: MpStatus;
  ready: boolean;
  totalScore: number;
  roundPoints: number | null;
  answerSeconds: number | null;
  endsAt: number | null;
  excerptStart: number | null;
  excerptSeconds: number | null;
  /** This player's own actions on this song — what the attempt rows show. */
  events: AttemptEvent[];
  /** Server clock for the level this player is on. */
  levelStartedAt: number | null;
  guesses: number;
  /** perReveal: the level whose one guess is already spent. */
  guessedAtStep: number | null;
  revealCount: number;
}

export interface MpRoundInfo {
  number: number;
  totalRounds: number;
  /**
   * This round's audio address. Opaque, unique to the round, and the same for
   * every player — it is the join between the audio a player hears and the
   * track the server will reveal.
   */
  token: string;
  excerptStart: number;
  endsAt: number;
  durations: number[];
  attemptMode: MpAttemptMode;
}

export interface MpRevealTrack {
  id: string;
  title: string;
  artist: string;
  hasCover: boolean;
  album: string;
  duration: number;
}

export interface MpRoundResult {
  id: string;
  name: string;
  status: MpStatus;
  step: number | null;
  answerSeconds: number | null;
  points: number;
  totalScore: number;
  connected: boolean;
  attempts: number;
  skips: number;
}

export interface MpResolved {
  round: {
    number: number;
    /** The resolved round's own audio address: the reveal replays that song. */
    token: string;
    excerptStart: number;
    track: MpRevealTrack | null;
    reason: string;
  };
  results: MpRoundResult[];
}

export interface MpStanding {
  id: string;
  name: string;
  score: number;
  correct: number;
  connected: boolean;
}

export interface CategoryTab {
  name: string;
  value: string;
  count: number;
}

export interface Attempt {
  text: string;
}

export interface Round {
  track: Track;
  /** Where inside the track this round's excerpt starts, in seconds. */
  startSec: number;
  /** Index into `round.durations`. */
  step: number;
  attempts: Attempt[];
  solved: boolean;
  /** True when the player ran out of reveals and the answer was shown. */
  givenUp: boolean;
  /** What the player did on THIS song: wrong guesses and skips, in order. */
  events: AttemptEvent[];
  /** When the current reveal level became active, so answer speed is fair. */
  levelStartedAt: number;
  /** Seconds spent on the winning reveal level, once solved. */
  answerSeconds: number | null;
}

export interface RoundResult {
  track: Track;
  step: number;
  duration: number;
  attempts: number;
  solved: boolean;
  points: number;
  /** Seconds between the winning reveal level and the correct answer. */
  answerSeconds: number | null;
}

export interface PersistedStats {
  bestScore: number;
  bestStreak: number;
  gamesPlayed: number;
  totalCorrect: number;
  totalRounds: number;
}

export interface Settings {
  mode: Mode;
  roundsPerGame: number;
  /** 'all', or a top-level music folder name. */
  category: string;
}
