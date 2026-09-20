/**
 * Audio playback.
 *
 * The excerpt has to stop *exactly* after its duration — a 0.1s round must
 * play 100 ms and no more. An <audio> element plus a timer cannot promise
 * that, so the primary path decodes the track and schedules it on the Web
 * Audio clock: `start(when, offset, duration)` stops sample-accurately, plays
 * gaplessly on repeat, and never overlaps.
 *
 * The same machinery plays the whole song once a round is over, from the very
 * position the excerpt was taken from — just without the `duration` argument.
 *
 * Decoding a whole track costs memory, so only the current and next tracks are
 * kept decoded. Encoded bytes are cached separately and more generously,
 * because they are ~20x smaller.
 *
 * If a file cannot be decoded at all, playback falls back to an <audio>
 * element so one broken song still plays instead of killing the round.
 *
 * Everything audible passes through one `master` gain node, which is the
 * game's volume setting: per-playback fades sit below it, so changing the
 * volume mid-excerpt is heard immediately and never touches the envelope. The
 * fallback element is not on that graph, so it mirrors the same value on its
 * own `.volume` — one setting, two outputs, no third opinion.
 */
import { audioConfig } from './types';
import { volume, VOLUME_RAMP_SECONDS } from './volume';

function audioUrl(id: string): string {
  return `/api/audio/${encodeURIComponent(id)}`;
}

export function coverUrl(id: string): string {
  return `/api/cover/${encodeURIComponent(id)}`;
}

/** An excerpt is a fixed slice; a song runs to the end of the file. */
export type PlaybackKind = 'excerpt' | 'song';

class LruCache<K, V> {
  private map = new Map<K, V>();
  constructor(private limit: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

interface ActivePlayback {
  kind: PlaybackKind;
  /** Context time at which the audio begins. */
  startAt: number;
  /** Seconds into the track where this playback starts. */
  offset: number;
  /** Seconds of audio scheduled. */
  length: number;
}

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private decoded = new LruCache<string, AudioBuffer>(audioConfig.decodedCacheSize);
  private encoded = new LruCache<string, ArrayBuffer>(audioConfig.encodedCacheSize);
  private decoding = new Map<string, Promise<AudioBuffer>>();
  private fetching = new Map<string, Promise<ArrayBuffer>>();

  private source: AudioBufferSourceNode | null = null;
  private active: ActivePlayback | null = null;

  private fallbackEl: HTMLAudioElement | null = null;
  private fallbackTrack: string | null = null;
  private fallbackStart = 0;
  private fallbackLength = 0;
  private fallbackRaf: number | null = null;
  private fallbackStopTimer: number | null = null;
  /** UI-side end-of-excerpt timer; see `schedule`. */
  private excerptTimer: number | null = null;
  private usingFallback = false;

  private currentId: string | null = null;
  /** Set when the current sound came from a full URL rather than a track id. */
  private currentRemote = false;
  private trackDuration = 0;
  private paused = false;
  /** Where to pick up from after a pause. */
  private resumeAt = 0;
  private generation = 0;

  /** Called when playback runs to its end or is interrupted. */
  onEnded: ((kind: PlaybackKind) => void) | null = null;

  constructor() {
    // The volume setting owns the master gain; this only follows it, so the
    // slider works before, during and after any playback.
    volume.subscribe(() => this.applyVolume());
  }

  /* ── Lifecycle ────────────────────────────────────────────────────── */

  /** Must be called from a user gesture the first time. */
  async unlock(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      // The context is created on the first gesture, so it starts at whatever
      // the player's stored setting already is — never at full volume.
      this.master.gain.value = volume.effective;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /* ── Volume ───────────────────────────────────────────────────────── */

  /**
   * Mirror the global volume onto the output. The master gain is ramped
   * rather than set, because a step change in gain is an audible click — and
   * because the ramp makes a drag of the slider a fade rather than a series
   * of seams.
   */
  private applyVolume(): void {
    const target = volume.effective;
    if (this.master && this.ctx) {
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(this.master.gain.value, now);
      this.master.gain.linearRampToValueAtTime(target, now + VOLUME_RAMP_SECONDS);
    }
    if (this.fallbackEl) this.fallbackEl.volume = target;
  }

  /** True while sound is actually coming out. */
  get isPlaying(): boolean {
    if (this.paused) return false;
    if (this.active !== null) return true;
    return this.usingFallback && this.fallbackEl?.paused === false;
  }

  /** Current position, in seconds into the track. */
  get position(): number {
    if (this.usingFallback && this.fallbackEl && this.fallbackEl.paused === false) {
      return this.fallbackEl.currentTime;
    }
    if (this.active && this.ctx) {
      const elapsed = Math.max(0, this.ctx.currentTime - this.active.startAt);
      return Math.min(this.active.offset + elapsed, this.active.offset + this.active.length);
    }
    // Nothing scheduled: `resumeAt` holds wherever we last were — the resume
    // point, or the end of a song that played out.
    return this.resumeAt;
  }

  /** Length of the loaded track in seconds, or 0 when unknown. */
  get duration(): number {
    return this.trackDuration;
  }

  /** 0 → 1 across the current excerpt, or 0 when no excerpt is running. */
  getProgress(): number {
    if (this.active?.kind === 'excerpt' && this.ctx) {
      const elapsed = this.ctx.currentTime - this.active.startAt;
      return clamp01(elapsed / this.active.length);
    }
    if (this.usingFallback && this.fallbackEl && this.fallbackLength > 0) {
      const elapsed = this.fallbackEl.currentTime - this.fallbackStart;
      return clamp01(elapsed / this.fallbackLength);
    }
    return 0;
  }

  /* ── Loading ──────────────────────────────────────────────────────── */

  isReady(id: string): boolean {
    return this.decoded.get(id) !== undefined;
  }

  /** Fetch and decode now, so PLAY has nothing to wait for. */
  async prepare(id: string, url?: string): Promise<boolean> {
    try {
      await this.getBuffer(id, url);
      return true;
    } catch {
      return false;
    }
  }

  private getBytes(id: string, url?: string): Promise<ArrayBuffer> {
    const cached = this.encoded.get(id);
    if (cached) return Promise.resolve(cached);

    const pending = this.fetching.get(id);
    if (pending) return pending;

    const request = fetch(url ?? audioUrl(id))
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((buffer) => {
        this.encoded.set(id, buffer);
        return buffer;
      })
      .finally(() => this.fetching.delete(id));

    this.fetching.set(id, request);
    return request;
  }

  private getBuffer(id: string, url?: string): Promise<AudioBuffer> {
    const cached = this.decoded.get(id);
    if (cached) return Promise.resolve(cached);

    const pending = this.decoding.get(id);
    if (pending) return pending;

    const request = this.getBytes(id, url)
      .then((bytes) => {
        const ctx = this.ensureContext();
        // decodeAudioData detaches the buffer it is given, so hand it a copy
        // and keep the cached bytes intact.
        return ctx.decodeAudioData(bytes.slice(0));
      })
      .then((buffer) => {
        this.decoded.set(id, buffer);
        return buffer;
      })
      .finally(() => this.decoding.delete(id));

    this.decoding.set(id, request);
    return request;
  }

  /* ── Playback: excerpt ────────────────────────────────────────────── */

  /**
   * Play `duration` seconds of `id`, starting at `startSec`.
   * Any playback already running is stopped first, so excerpts never overlap.
   * Resolves to false when a newer call superseded this one.
   */
  async play(id: string, startSec: number, duration: number): Promise<boolean> {
    return this.playFrom(id, startSec, duration);
  }

  /**
   * Play an excerpt from a URL instead of a track id. Used by multiplayer,
   * where the track id must stay secret until the round resolves — the room's
   * audio is addressed by an opaque per-room URL. `key` identifies this round
   * for caching (the URL alone is stable across rounds).
   */
  async playRemote(key: string, url: string, startSec: number, duration: number): Promise<boolean> {
    return this.playFrom(key, startSec, duration, url);
  }

  private async playFrom(key: string, startSec: number, duration: number, url?: string): Promise<boolean> {
    const generation = this.begin(key, Boolean(url));
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    if (generation !== this.generation) return false;

    let buffer: AudioBuffer | null = null;
    try {
      buffer = await this.getBuffer(key, url);
    } catch {
      buffer = null; // fall through to the element-based path
    }
    if (generation !== this.generation) return false;

    if (!buffer) return this.excerptViaElement(key, startSec, duration, generation, url);

    this.trackDuration = buffer.duration;
    const start = Math.min(Math.max(startSec, 0), Math.max(0, buffer.duration - 0.02));
    const length = Math.min(duration, Math.max(0, buffer.duration - start));
    if (length < 0.005) {
      this.onEnded?.('excerpt');
      return false;
    }

    this.schedule(ctx, buffer, start, length, 'excerpt', generation);
    return true;
  }

  /* ── Playback: whole song ─────────────────────────────────────────── */

  /**
   * Play `id` from `startSec` through to the end of the file.
   * Used once a round is over, from the round's frozen excerpt position.
   */
  async playSong(id: string, startSec: number): Promise<boolean> {
    return this.songFrom(id, startSec);
  }

  /** The URL twin of `playSong` — see `playRemote`. */
  async playSongRemote(key: string, url: string, startSec: number): Promise<boolean> {
    return this.songFrom(key, startSec, url);
  }

  private async songFrom(key: string, startSec: number, url?: string): Promise<boolean> {
    const generation = this.begin(key, Boolean(url));
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    if (generation !== this.generation) return false;

    let buffer: AudioBuffer | null = null;
    try {
      buffer = await this.getBuffer(key, url);
    } catch {
      buffer = null;
    }
    if (generation !== this.generation) return false;

    if (!buffer) return this.songViaElement(key, startSec, generation, url);

    this.trackDuration = buffer.duration;
    const start = Math.min(Math.max(startSec, 0), Math.max(0, buffer.duration - 0.05));
    const length = buffer.duration - start;
    if (length < 0.05) {
      this.onEnded?.('song');
      return false;
    }

    this.schedule(ctx, buffer, start, length, 'song', generation);
    return true;
  }

  /** A short lead-in so restarting the song does not click. */
  private schedule(
    ctx: AudioContext,
    buffer: AudioBuffer,
    start: number,
    length: number,
    kind: PlaybackKind,
    generation: number,
  ): void {
    const t0 = ctx.currentTime + 0.01;
    const gain = ctx.createGain();
    const fadeIn = Math.min(kind === 'song' ? audioConfig.songFadeInSeconds : audioConfig.fadeInSeconds, length * 0.2);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(1, t0 + fadeIn);
    // An excerpt is cut off mid-phrase, so it needs a matching fade out; a song
    // ends on its own.
    if (kind === 'excerpt') {
      const fadeOut = Math.min(audioConfig.fadeOutSeconds, length * 0.2);
      gain.gain.setValueAtTime(1, t0 + length - fadeOut);
      gain.gain.linearRampToValueAtTime(0, t0 + length);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(this.master!);

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (this.excerptTimer !== null) {
        clearTimeout(this.excerptTimer);
        this.excerptTimer = null;
      }
      if (generation !== this.generation) return;
      // Leave the position at the end so a progress bar does not rewind.
      if (this.active) this.resumeAt = this.active.offset + this.active.length;
      this.active = null;
      this.source = null;
      this.onEnded?.(kind);
    };
    source.onended = settle;

    this.source = source;
    this.active = { kind, startAt: t0, offset: start, length };
    this.resumeAt = start;

    if (kind === 'excerpt') {
      source.start(t0, start, length);
      /*
       * The excerpt stops on the audio clock either way — that part is exact.
       * This timer exists for the *interface*: decoding the next track can keep
       * the main thread busy, and the `ended` event then arrives hundreds of
       * milliseconds late, leaving the play button "playing" long after the
       * sound has gone. Measured at 1279 ms late for a 0.1 s clip before this.
       */
      this.excerptTimer = window.setTimeout(settle, (t0 - ctx.currentTime + length) * 1000 + 15);
    } else {
      source.start(t0, start);
    }
  }

  /** Shared preamble: takes over from whatever was playing. */
  private begin(id: string, remote = false): number {
    const generation = ++this.generation;
    this.halt();
    this.paused = false;
    this.usingFallback = false;
    this.currentId = id;
    this.currentRemote = remote;
    return generation;
  }

  /* ── Pause / resume ───────────────────────────────────────────────── */

  pause(): void {
    if (this.paused || !this.isPlaying) return;
    this.resumeAt = this.position;
    this.paused = true;
    // Bumping the generation discards the pending `onended` of the source we
    // are about to stop: a pause is not an end.
    this.generation += 1;
    this.halt();
  }

  async resume(): Promise<boolean> {
    if (!this.paused || !this.currentId) return false;
    const id = this.currentId;
    const at = this.resumeAt;
    this.paused = false;

    if (this.usingFallback && this.fallbackEl && this.fallbackTrack === id) {
      try {
        await this.fallbackEl.play();
      } catch {
        return false;
      }
      this.watchFallback(id, this.generation);
      return true;
    }
    if (this.currentRemote) return this.songFrom(id, at, id);
    return this.playSong(id, at);
  }

  /* ── Element fallback ─────────────────────────────────────────────── */

  private async excerptViaElement(
    id: string,
    startSec: number,
    duration: number,
    generation: number,
    url?: string,
  ): Promise<boolean> {
    const el = await this.loadElement(id, generation, url);
    if (!el) return false;

    this.usingFallback = true;
    const total = Number.isFinite(el.duration) ? el.duration : 0;
    const start = total ? Math.min(Math.max(startSec, 0), Math.max(0, total - 0.05)) : Math.max(startSec, 0);
    const length = total ? Math.min(duration, Math.max(0.02, total - start)) : duration;

    el.currentTime = start;
    try {
      await el.play();
    } catch {
      this.onEnded?.('excerpt');
      return false;
    }
    if (generation !== this.generation) {
      el.pause();
      return false;
    }

    this.fallbackStart = start;
    this.fallbackLength = length;

    let done = false;
    const stopExcerpt = () => {
      if (done) return;
      done = true;
      el.pause();
      this.fallbackLength = 0;
      this.fallbackRaf = null;
      if (this.fallbackStopTimer !== null) {
        clearTimeout(this.fallbackStopTimer);
        this.fallbackStopTimer = null;
      }
      this.onEnded?.('excerpt');
    };

    // Poll the element's own clock: a timer alone would drift against real
    // playback. The timer is the safety net, because browsers throttle
    // requestAnimationFrame in a background tab and the excerpt must still
    // stop on time if the player switches away mid-round.
    const tick = () => {
      if (generation !== this.generation) return;
      if (el.paused || el.currentTime >= start + length - 0.005) {
        stopExcerpt();
        return;
      }
      this.fallbackRaf = requestAnimationFrame(tick);
    };
    this.fallbackRaf = requestAnimationFrame(tick);
    this.fallbackStopTimer = window.setTimeout(stopExcerpt, length * 1000 + 40);
    return true;
  }

  private async songViaElement(id: string, startSec: number, generation: number, url?: string): Promise<boolean> {
    const el = await this.loadElement(id, generation, url);
    if (!el) return false;

    this.usingFallback = true;
    this.trackDuration = Number.isFinite(el.duration) ? el.duration : 0;
    const start = this.trackDuration
      ? Math.min(Math.max(startSec, 0), Math.max(0, this.trackDuration - 0.1))
      : Math.max(startSec, 0);

    el.currentTime = start;
    this.resumeAt = start;
    try {
      await el.play();
    } catch {
      this.onEnded?.('song');
      return false;
    }
    if (generation !== this.generation) {
      el.pause();
      return false;
    }

    this.watchFallback(id, generation);
    return true;
  }

  private watchFallback(id: string, generation: number): void {
    const el = this.fallbackEl;
    if (!el) return;
    const tick = () => {
      if (generation !== this.generation || this.fallbackTrack !== id) return;
      if (el.ended) {
        this.fallbackRaf = null;
        this.resumeAt = Number.isFinite(el.duration) ? el.duration : 0;
        this.onEnded?.('song');
        return;
      }
      if (el.paused) {
        this.fallbackRaf = null;
        return;
      }
      this.fallbackRaf = requestAnimationFrame(tick);
    };
    this.fallbackRaf = requestAnimationFrame(tick);
  }

  private async loadElement(id: string, generation: number, url?: string): Promise<HTMLAudioElement | null> {
    if (!this.fallbackEl) {
      this.fallbackEl = new Audio();
      this.fallbackEl.preload = 'auto';
      this.fallbackEl.volume = volume.effective;
      // Attached rather than left detached: it behaves predictably that way,
      // and audio elements without `controls` render nothing.
      document.body.append(this.fallbackEl);
    }
    const el = this.fallbackEl;

    if (this.fallbackTrack !== id) {
      this.fallbackTrack = id;
      el.src = url ?? audioUrl(id);
      await waitForEvent(el, 'loadedmetadata', 6000);
      if (generation !== this.generation) return null;
    }
    return el;
  }

  /* ── Stopping ─────────────────────────────────────────────────────── */

  /** Stop everything, without firing the `finished` callback. */
  stop(): void {
    this.generation += 1;
    this.halt();
    this.paused = false;
    this.usingFallback = false;
    this.resumeAt = 0;
  }

  /**
   * Stop and drop every cached buffer. A decoded song is often tens of
   * megabytes, so leaving a room hands the memory back instead of waiting for
   * the cache to rotate it out.
   */
  forget(): void {
    this.stop();
    this.decoded.clear();
    this.encoded.clear();
    this.decoding.clear();
    this.fetching.clear();
    this.currentId = null;
    this.currentRemote = false;
    this.trackDuration = 0;
  }

  private halt(): void {
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        /* already stopped */
      }
      this.source.disconnect();
      this.source = null;
    }
    this.active = null;

    if (this.fallbackRaf !== null) {
      cancelAnimationFrame(this.fallbackRaf);
      this.fallbackRaf = null;
    }
    if (this.fallbackStopTimer !== null) {
      clearTimeout(this.fallbackStopTimer);
      this.fallbackStopTimer = null;
    }
    if (this.excerptTimer !== null) {
      clearTimeout(this.excerptTimer);
      this.excerptTimer = null;
    }
    if (this.fallbackEl && !this.fallbackEl.paused) this.fallbackEl.pause();
    this.fallbackLength = 0;
  }
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function waitForEvent(el: HTMLMediaElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      el.removeEventListener(event, done);
      el.removeEventListener('error', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    el.addEventListener(event, done, { once: true });
    el.addEventListener('error', done, { once: true });
  });
}

export const audio = new AudioEngine();
