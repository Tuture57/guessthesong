/**
 * Multiplayer client.
 *
 * A thin, obedient mirror of the server's room state. It sends intents
 * ("I skip", "I guess", "I'm ready") and renders what comes back — it never
 * decides round flow, scores a round, or reveals anything the server has not
 * revealed. The track of the current round is not part of any message until
 * the round resolves: in-round audio streams through the opaque room URL.
 */
import { fill, t } from '../i18n';
import { audio } from './audio';
import { gameConfig } from './types';
import type { MpAttemptMode, MpResolved, MpRoom, MpRoundInfo, MpSelf, MpStanding } from './types';

export type MpScreen = 'off' | 'menu' | 'lobby' | 'game' | 'results';

const SESSION_KEY = 'gts.v1.mp.session';
const NAME_KEY = 'gts.v1.mp.name';

interface StoredSession {
  code: string;
  clientId: string;
  name: string;
}

export interface MpFeedback {
  kind: 'correct' | 'wrong' | 'gaveup' | 'too-late' | 'spent' | 'exhausted';
  points?: number;
  step?: number;
  seconds?: number;
  at: number;
}

function makeClientId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Same-origin, always. The scheme follows the page, so an HTTPS deployment
 * gets `wss://` without anything being configured, and local development keeps
 * plain `ws://` — no localhost and no port is ever written down here.
 */
export function socketUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}

/** The server's error code, rendered through the copy layer. */
function errorText(message: Record<string, unknown>): string {
  const code = String(message.code ?? '');
  const template = t.proto.errors[code];
  if (template) return fill(template, (message.params ?? {}) as Record<string, string | number>);
  return String(message.message ?? t.proto.errors.unknown);
}

export class Multiplayer {
  screen: MpScreen = 'off';
  connected = false;
  connecting = false;

  /** This player's server-side id. */
  playerId: string | null = null;
  room: MpRoom | null = null;
  self: MpSelf | null = null;
  /** The round in progress. Absent until the first round of a game starts. */
  round: MpRoundInfo | null = null;
  /** Set the moment a round resolves; cleared when the next one starts. */
  resolved: MpResolved | null = null;
  standings: MpStanding[] | null = null;

  /** Transient per-player feedback (Correct! / Wrong / …). */
  feedback: MpFeedback | null = null;
  notice: { kind: 'error' | 'info'; message: string } | null = null;

  name = '';

  private socket: WebSocket | null = null;
  private clientId = '';
  /** True while reclaiming a seat: a dead room then clears silently. */
  private resuming = false;
  /** A guess is on its way; further submissions wait for the verdict. */
  private pendingGuess = false;
  private reconnectTimer: number | null = null;
  private reconnectDelay = 800;
  private intentionalClose = false;
  private listeners = new Set<() => void>();

  constructor() {
    this.name = readLocal(NAME_KEY) ?? '';
    this.clientId = makeClientId();
  }

  /**
   * The first real gesture is the only moment a browser will let an AudioContext
   * start. Doing it here means the click that finally plays music never pays
   * for waking the context up.
   */
  warmAudio(): void {
    void audio.unlock();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /* ── Derived ──────────────────────────────────────────────────────── */

  get isHost(): boolean {
    return Boolean(this.room && this.playerId && this.room.hostId === this.playerId);
  }

  get durations(): number[] {
    return this.round?.durations ?? gameConfig.round.durations;
  }

  get roundActive(): boolean {
    return this.room?.phase === 'playing' && Boolean(this.round) && this.self?.status === 'guessing';
  }

  /** Open the multiplayer menu (create / join). */
  openMenu(): void {
    this.notice = null;
    this.screen = 'menu';
    this.notify();
  }

  /** Leave everything and go back to singleplayer home. */
  close(): void {
    if (this.room) this.leave();
    else audio.forget();
    this.reset();
    this.notify();
  }

  private reset(): void {
    this.screen = 'off';
    this.room = null;
    this.self = null;
    this.round = null;
    this.resolved = null;
    this.standings = null;
    this.feedback = null;
    this.playerId = null;
  }

  /* ── Connection ───────────────────────────────────────────────────── */

  private connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return Promise.resolve();

    return new Promise((resolve) => {
      this.connecting = true;
      this.notify();

      let socket: WebSocket;
      try {
        socket = new WebSocket(socketUrl());
      } catch {
        this.connecting = false;
        this.notice = { kind: 'error', message: t.mp.connectFailed };
        this.notify();
        resolve();
        return;
      }
      this.socket = socket;

      socket.addEventListener('open', () => {
        this.connected = true;
        this.connecting = false;
        this.reconnectDelay = 800;
        this.notify();
        resolve();
      });

      socket.addEventListener('message', (event) => {
        try {
          this.onMessage(JSON.parse(String(event.data)));
        } catch {
          /* malformed frame — ignore */
        }
      });

      socket.addEventListener('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.connecting = false;
        if (this.socket === socket) this.socket = null;
        this.notify();
        if (!this.intentionalClose && (wasConnected || this.room)) this.scheduleReconnect();
        resolve();
      });

      socket.addEventListener('error', () => {
        /* close follows */
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    // A dropped socket in a live room is worth saying out loud: the player is
    // about to miss a round, and silence would look like a frozen game.
    if (this.room && !this.notice) this.notice = { kind: 'info', message: t.mp.connectionLost };
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8000);
    this.reconnectTimer = window.setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
      // Reclaim the seat we had; the server answers on the same socket.
      const stored = readSession();
      if (this.connected && this.playerId && this.room && stored) {
        this.send({ t: 'join', code: stored.code, name: stored.name, clientId: stored.clientId });
      }
    }, delay);
  }

  private send(message: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private async sendNow(message: unknown): Promise<void> {
    await this.connect();
    this.send(message);
  }

  /* ── Intents ──────────────────────────────────────────────────────── */

  async createRoom(settings: { rounds: number; category: string; attemptMode: MpAttemptMode; roundSeconds: number }): Promise<void> {
    const name = this.name.trim();
    if (!name) {
      this.notice = { kind: 'error', message: t.mp.nameFirst };
      this.notify();
      return;
    }
    writeLocal(NAME_KEY, name);
    this.notice = null;
    this.intentionalClose = false;
    await this.sendNow({
      t: 'create',
      name,
      clientId: this.clientId,
      rounds: settings.rounds,
      category: settings.category,
      attemptMode: settings.attemptMode,
      roundSeconds: settings.roundSeconds,
    });
  }

  async joinRoom(code: string): Promise<void> {
    const name = this.name.trim();
    if (!name) {
      this.notice = { kind: 'error', message: t.mp.nameFirst };
      this.notify();
      return;
    }
    const clean = code.trim().toUpperCase();
    if (clean.length < 4) {
      this.notice = { kind: 'error', message: t.mp.codeTooShort };
      this.notify();
      return;
    }
    writeLocal(NAME_KEY, name);
    this.notice = null;
    this.intentionalClose = false;
    await this.sendNow({ t: 'join', code: clean, name, clientId: this.clientId });
  }

  /** Try to reclaim a seat after a refresh. */
  async resumeSession(): Promise<boolean> {
    const stored = readSession();
    if (!stored) return false;
    this.clientId = stored.clientId;
    this.name = this.name || stored.name;
    this.intentionalClose = false;
    this.resuming = true;
    await this.connect();
    if (!this.connected) {
      this.resuming = false;
      return false;
    }
    this.send({ t: 'join', code: stored.code, name: this.name || stored.name, clientId: stored.clientId });
    return true;
  }

  leave(): void {
    this.send({ t: 'leave' });
    clearSession();
    // A decoded song is tens of megabytes; leaving the room releases them.
    audio.forget();
    this.intentionalClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.reset();
    this.notify();
  }

  startGame(): void {
    this.send({ t: 'start' });
  }

  setRounds(rounds: number): void {
    this.send({ t: 'settings', rounds });
  }

  setCategory(category: string): void {
    this.send({ t: 'settings', category });
  }

  setAttemptMode(attemptMode: MpAttemptMode): void {
    this.send({ t: 'settings', attemptMode });
  }

  setRoundSeconds(roundSeconds: number): void {
    this.send({ t: 'settings', roundSeconds });
  }

  /**
   * Round actions are gated on the room phase, not on this client's copy of
   * its own status: a guess can arrive in the instant between "the round
   * started" and "your status is guessing", and dropping it there would lose
   * a legitimate answer. The server is the authority — it answers 'too-late'
   * when an action is not allowed.
   */
  reveal(): void {
    if (this.room?.phase !== 'playing') return;
    this.send({ t: 'reveal' });
  }

  guess(text: string): boolean {
    if (this.room?.phase !== 'playing') return false;
    if (this.pendingGuess) return false;
    const value = text.trim();
    if (!value) return false;
    this.pendingGuess = true;
    // The stamp tells the server which reveal level this answers, so a rapid
    // double submit can never spend two levels at once.
    this.send({ t: 'guess', text: value, levelAt: this.self?.levelStartedAt ?? undefined });
    return true;
  }

  giveUp(): void {
    if (this.room?.phase !== 'playing') return;
    this.send({ t: 'giveup' });
  }

  ready(): void {
    if (this.room?.phase !== 'resolved') return;
    this.send({ t: 'ready' });
  }

  backToLobby(): void {
    this.send({ t: 'back-to-lobby' });
  }

  /**
   * The opaque audio URL for one round's token. The token is minted per round
   * and never reused, so this URL names exactly one file for as long as it
   * exists — which is what makes it safe to cache against.
   */
  audioUrl(token: string): string | null {
    if (!this.room || !token) return null;
    return `/api/multi/audio/${encodeURIComponent(this.room.code)}/${encodeURIComponent(token)}`;
  }

  /**
   * Cache key for one round's audio. Derived from the token, not from the
   * round number: round numbers restart with every rematch in the same room,
   * and a key that repeats would serve the previous game's decoded song.
   */
  audioKey(token: string): string | null {
    if (!this.room || !token) return null;
    return `mp:${this.room.code}:${token}`;
  }

  /* ── Server messages ──────────────────────────────────────────────── */

  private onMessage(message: { t: string; [key: string]: unknown }): void {
    switch (message.t) {
      case 'joined': {
        this.playerId = String(message.playerId);
        this.room = message.room as MpRoom;
        this.resuming = false;
        writeSession({ code: this.room.code, clientId: this.clientId, name: this.name });
        this.notice = null;
        this.screen = this.room.phase === 'lobby' ? 'lobby' : 'game';
        break;
      }
      case 'room': {
        this.room = message.room as MpRoom;
        if (this.room.phase === 'lobby' && this.screen !== 'menu') this.screen = 'lobby';
        else if (this.room.phase === 'playing' && this.screen !== 'game') this.screen = 'game';
        else if (this.room.phase === 'ended') this.screen = 'results';
        break;
      }
      case 'self': {
        this.self = message.self as MpSelf;
        break;
      }
      case 'round': {
        this.round = message.round as MpRoundInfo;
        this.pendingGuess = false;
        this.resolved = null;
        this.standings = null;
        this.feedback = null;
        this.screen = 'game';
        break;
      }
      case 'resolved': {
        this.resolved = { round: message.round, results: message.results } as MpResolved;
        this.feedback = null;
        break;
      }
      case 'reveal': {
        if (this.self) this.self = { ...this.self, step: Number(message.step) };
        break;
      }
      case 'ended': {
        this.standings = message.standings as MpStanding[];
        this.screen = 'results';
        break;
      }
      case 'feedback': {
        this.pendingGuess = false;
        this.feedback = {
          kind: message.kind as MpFeedback['kind'],
          points: message.points as number | undefined,
          step: message.step as number | undefined,
          seconds: message.seconds as number | undefined,
          at: Date.now(),
        };
        break;
      }
      case 'error': {
        clearSession();
        // A room that died while the page was reloading is not an error the
        // player needs to see — they simply land back on the home screen.
        if (this.resuming) {
          this.resuming = false;
          this.reset();
          break;
        }
        this.notice = { kind: 'error', message: errorText(message) };
        this.screen = 'menu';
        break;
      }
      case 'replaced': {
        this.notice = { kind: 'info', message: fill(t.proto.info.replaced) };
        this.reset();
        break;
      }
      case 'pong':
      default:
        break;
    }
    this.notify();
  }
}

export const multiplayer = new Multiplayer();

/* ── Persistence ─────────────────────────────────────────────────────── */

function readSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    return parsed && parsed.code && parsed.clientId ? parsed : null;
  } catch {
    return null;
  }
}

function writeSession(session: StoredSession): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* private window — the session just is not resumable */
  }
}

function clearSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}
