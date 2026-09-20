/**
 * The game's one volume setting.
 *
 * Every sound the game makes — a solo excerpt, a multiplayer excerpt, the
 * reveal's full song, a replay, the fallback <audio> element — passes through
 * this. The audio engine reads it, the top bar writes it, and nothing else
 * decides how loud anything is.
 *
 * Two numbers, kept apart on purpose:
 *
 *   level — what the slider shows, 0 → 1, remembered across a mute
 *   muted — the switch, which silences without destroying the level
 *
 * So muting at 75% and un-muting returns exactly 75%, never 100%. The stored
 * value is the slider's, not the output's: a player who muted and reloaded
 * finds their volume where they left it.
 */

const LEVEL_KEY = 'gts-volume';
const MUTED_KEY = 'gts-volume-muted';

/** Where a fresh player starts: loud enough to hear, quiet enough to talk over. */
export const DEFAULT_VOLUME = 0.75;

/** The shortest useful ramp. Long enough to swallow the click, short enough
 *  that a dragged slider still feels attached to the sound. */
export const VOLUME_RAMP_SECONDS = 0.02;

function readNumber(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function readFlag(key: string): boolean {
  return readNumber(key) === 1;
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private window: the setting applies for this session only */
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VOLUME;
  return Math.min(Math.max(value, 0), 1);
}

class Volume {
  /** The slider's position, 0 → 1. Survives a mute. */
  private level = DEFAULT_VOLUME;
  private muted = false;
  private listeners = new Set<() => void>();

  constructor() {
    const storedLevel = readNumber(LEVEL_KEY);
    this.level = storedLevel === null ? DEFAULT_VOLUME : clamp01(storedLevel);
    this.muted = readFlag(MUTED_KEY);
  }

  /** What the slider shows, 0 → 1. */
  get value(): number {
    return this.level;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** What the audio engine should actually output, 0 → 1. */
  get effective(): number {
    return this.muted ? 0 : this.level;
  }

  /** 0 → 100, for the readout and the slider's own step. */
  get percent(): number {
    return Math.round(this.level * 100);
  }

  /** 'normal' · 'low' · 'muted' — what the icon shows. */
  get state(): 'normal' | 'low' | 'muted' {
    if (this.muted || this.level === 0) return 'muted';
    return this.level <= 0.4 ? 'low' : 'normal';
  }

  setLevel(value: number): void {
    const next = clamp01(value);
    // Dragging the slider up is itself the request to hear something again,
    // so it lifts the mute. Leaving it at zero does not re-mute.
    const unmute = next > 0;
    if (next === this.level && (!this.muted || !unmute)) return;
    this.level = next;
    if (unmute) this.muted = false;
    this.persist();
    this.notify();
  }

  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    this.persist();
    this.notify();
  }

  toggleMute(): void {
    this.setMuted(!this.muted);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private persist(): void {
    write(LEVEL_KEY, String(Math.round(this.level * 1000) / 1000));
    write(MUTED_KEY, this.muted ? '1' : '0');
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const volume = new Volume();
