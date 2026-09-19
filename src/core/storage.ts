/**
 * localStorage wrapper. Every access is guarded: a private window, cleared
 * site data or a blocked origin must never stop the game from starting.
 */
import type { PersistedStats, Settings } from './types';

const PREFIX = 'gts.v1.';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? { ...fallback, ...parsed } : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable — the game simply forgets between sessions */
  }
}

const EMPTY_STATS: PersistedStats = {
  bestScore: 0,
  bestStreak: 0,
  gamesPlayed: 0,
  totalCorrect: 0,
  totalRounds: 0,
};

const DEFAULT_SETTINGS: Settings = {
  mode: 'quick',
  roundsPerGame: 10,
  category: 'all',
};

export const storage = {
  loadStats: () => read<PersistedStats>('stats', EMPTY_STATS),
  saveStats: (stats: PersistedStats) => write('stats', stats),
  loadSettings: () => read<Settings>('settings', DEFAULT_SETTINGS),
  saveSettings: (settings: Settings) => write('settings', settings),
};
