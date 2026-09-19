/**
 * Multiplayer rooms — authoritative game state, one WebSocket per player.
 *
 * The server owns everything that matters: which track each round uses, where
 * the excerpt starts, when the round starts and ends, every player's reveal
 * level, the scoring, and the moment a round resolves. Clients send intents
 * ("reveal", "guess", "give up") and render what the server tells them.
 *
 * Spoiler safety is structural: the round's track id, title, artist and cover
 * are never sent to anyone until the round resolves. In-round audio streams
 * through an opaque per-room URL, so even the audio request leaks nothing.
 */
import { WebSocketServer } from 'ws';
import config from '../config.js';
import { pickExcerptStart, excerptEnd } from '../shared/excerpt.js';
import { messageFor } from '../shared/messages.fr.js';
import { scoreAnswer } from '../shared/scoring.js';
import { isCorrectGuess } from './guess.js';

const MP = config.multiplayer;

/**
 * The largest frame a client may send. Every real message here is well under
 * 200 bytes; the cap is what keeps a hostile client from making the server
 * buffer megabytes per socket.
 */
const MAX_MESSAGE_BYTES = 4096;

/** Hard ceiling on rooms held in memory, so a script cannot fill the heap. */
const MAX_ROOMS = positiveOr(Number(process.env.GTS_MAX_ROOMS), 500);
/** New rooms per minute, across the whole server. Far above any real usage. */
const MAX_ROOM_CREATES_PER_MINUTE = positiveOr(Number(process.env.GTS_ROOM_RATE), 120);

/**
 * Per-socket action budgets, in the shape "N actions per N seconds". They are
 * set so that no human, and no honest client, can reach them: they exist to
 * turn an abusive loop into a no-op, not to police fast players.
 */
const BUDGETS = {
  create: { limit: 10, windowMs: 60_000 },
  join: { limit: 20, windowMs: 60_000 },
  // Ten guesses a second, sustained. A person typing at a keyboard reaches a
  // fraction of that; a script written to hammer the server does not.
  guess: { limit: 100, windowMs: 10_000 },
  reveal: { limit: 100, windowMs: 10_000 },
};

/**
 * Timers can be shortened for automated tests and for tuning a session
 * (`GTS_MP_ROUND_SECONDS=15 npm start`). Config stays the source of truth for
 * normal play.
 */
const INTERMISSION_SECONDS = positiveOr(Number(process.env.GTS_MP_INTERMISSION_SECONDS), MP.intermissionSeconds);
const IDLE_SECONDS = positiveOr(Number(process.env.GTS_MP_IDLE_SECONDS), MP.idleRoomTimeoutSeconds);
/** Pins every room's round time — used by the automated tests and for tuning. */
const FORCED_ROUND_SECONDS = positiveOr(Number(process.env.GTS_MP_ROUND_SECONDS), null);

function positiveOr(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** How many guesses a player gets, and what a wrong one costs them. */
const ATTEMPT_MODES = new Set(['unlimited', 'perReveal', 'single']);

/** Bounds for a host-chosen round time, in seconds. */
const ROUND_TIME_MIN = 10;
const ROUND_TIME_MAX = 180;

function clampRoundSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return MP.roundSeconds;
  return Math.min(ROUND_TIME_MAX, Math.max(ROUND_TIME_MIN, Math.round(seconds)));
}

/** The round time actually in force for a room. */
function roomRoundSeconds(room) {
  return FORCED_ROUND_SECONDS ?? room.settings.roundSeconds;
}

/** Unambiguous room-code alphabet: no 0/O/1/I/L to misread aloud. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const rooms = new Map();
/** socket -> { room, playerId } */
const sessions = new Map();
/** The live WebSocket server, so a shutdown can reach every client. */
let liveServer = null;

/** Browsers allowed to open a socket. Empty means "anyone" — see `connection`. */
const ALLOWED_ORIGINS = String(process.env.GTS_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const rng = {
  code() {
    let out = '';
    for (let i = 0; i < MP.roomCodeLength; i += 1) {
      out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return out;
  },
  /** Fisher–Yates, so each room gets its own order. */
  shuffle(items) {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  },
};

function id() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function topFolder(track) {
  return track.folder ? track.folder.split(/[\\/]/)[0] : '';
}

function nowMs() {
  return Date.now();
}

/* ── Room lifecycle ─────────────────────────────────────────────────── */

function createRoom(settings) {
  let code;
  do {
    code = rng.code();
  } while (rooms.has(code));

  const room = {
    code,
    createdAt: nowMs(),
    lastActivity: nowMs(),
    phase: 'lobby', // lobby | playing | resolved | ended
    hostId: null,
    settings: {
      rounds: clampRounds(settings?.rounds),
      category: String(settings?.category ?? 'all'),
      attemptMode: ATTEMPT_MODES.has(settings?.attemptMode) ? settings.attemptMode : 'unlimited',
      roundSeconds: clampRoundSeconds(settings?.roundSeconds),
    },
    players: new Map(),
    roundNumber: 0,
    round: null,
    resolved: null,
    queue: [],
    timers: { round: null, intermission: null },
    emptySince: null,
  };
  rooms.set(code, room);
  return room;
}

function clampRounds(value) {
  const wanted = Number(value);
  if (!Number.isFinite(wanted)) return MP.defaultRounds;
  return Math.min(MP.maxRounds, Math.max(1, Math.floor(wanted)));
}

function deleteRoom(room) {
  clearRoomTimers(room);
  rooms.delete(room.code);
  for (const player of room.players.values()) {
    if (player.socket) sessions.delete(player.socket);
  }
}

function clearRoomTimers(room) {
  if (room.timers.round) clearTimeout(room.timers.round);
  if (room.timers.intermission) clearTimeout(room.timers.intermission);
  room.timers.round = null;
  room.timers.intermission = null;
}

function touch(room) {
  room.lastActivity = nowMs();
}

/** The next connected player becomes host. Returns true when one was found. */
function transferHost(room) {
  for (const player of room.players.values()) {
    if (player.connected) {
      room.hostId = player.id;
      player.isHost = true;
      return true;
    }
  }
  room.hostId = null;
  return false;
}

function dropPlayer(room, player) {
  room.players.delete(player.id);
  if (player.socket) sessions.delete(player.socket);
  if (room.hostId === player.id) transferHost(room);
}

/* ── Servery views ──────────────────────────────────────────────────── */
/* These are the only shapes that ever leave the process.                  */

/** Public, spoiler-free view of a player. No reveal level, no guesses. */
function publicPlayer(room, player) {
  return {
    id: player.id,
    name: player.name,
    isHost: player.id === room.hostId,
    connected: player.connected,
    status: player.connected ? player.status : 'away',
    ready: player.ready,
    /** Everything below is only meaningful once the round has resolved. */
    score: player.totalScore,
  };
}

/** The room as everyone may see it. Never contains the round's track. */
function publicRoom(room) {
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    settings: { ...room.settings },
    roundNumber: room.roundNumber,
    totalRounds: room.settings.rounds,
    endsAt: room.phase === 'playing' && room.round ? room.round.endsAt : null,
    nextAt: room.phase === 'resolved' && room.intermissionEndsAt ? room.intermissionEndsAt : null,
    players: [...room.players.values()].map((player) => publicPlayer(room, player)),
  };
}

/** A player's own private state — never sent to anyone else. */
function selfState(room, player) {
  const round = room.round;
  return {
    playerId: player.id,
    step: player.step,
    status: player.connected ? player.status : 'away',
    ready: player.ready,
    totalScore: player.totalScore,
    roundPoints: player.roundPoints,
    answerSeconds: player.answerSeconds,
    endsAt: round && room.phase === 'playing' ? round.endsAt : null,
    excerptStart: round && room.phase === 'playing' ? round.excerptStart : null,
    excerptSeconds:
      round && room.phase === 'playing'
        ? excerptEnd(round.excerptStart, room.trackDuration, config.round.durations[player.step] ?? 0) -
          round.excerptStart
        : null,
    /** This player's own actions on this song: what the attempt rows show. */
    events: (player.events ?? []).map((event) => ({ ...event })),
    /** When the current reveal level opened — the guess's "which level" stamp. */
    levelStartedAt: player.levelStartedAt ?? null,
    guesses: player.guesses ?? 0,
    guessedAtStep: player.guessedAtStep ?? null,
    revealCount: config.round.durations.length,
  };
}

function send(socket, message) {
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcastRoom(room) {
  const roomView = JSON.stringify({ t: 'room', room: publicRoom(room) });
  for (const player of room.players.values()) {
    if (player.socket && player.socket.readyState === player.socket.OPEN) {
      player.socket.send(roomView);
    }
  }
}

function sendSelf(room, player) {
  send(player.socket, { t: 'self', self: selfState(room, player) });
}

/**
 * One error shape: a code the client can translate, its parameters, and the
 * text they produce. The client renders from the code; the text rides along so
 * a log (or an older client) still reads as a sentence.
 */
function fail(socket, code, params) {
  send(socket, { t: 'error', code, params: params ?? null, message: messageFor(code, params) });
}

/**
 * A sliding allowance per socket. Reaching it is a no-op for the sender, never
 * a disconnect: a legitimate client that somehow trips this should be able to
 * carry on a second later, not lose its seat.
 */
function spend(socket, kind) {
  const budget = BUDGETS[kind];
  if (!budget) return true;
  const now = nowMs();
  let spent = socket.gtsSpent;
  if (!spent) {
    spent = {};
    socket.gtsSpent = spent;
  }
  const ledger = spent[kind] ?? (spent[kind] = []);
  while (ledger.length && now - ledger[0] > budget.windowMs) ledger.shift();
  if (ledger.length >= budget.limit) return false;
  ledger.push(now);
  return true;
}

/** Rooms opened per minute across the server — a runaway script's ceiling. */
let roomCreateLedger = [];
function mayCreateRoom() {
  const now = nowMs();
  while (roomCreateLedger.length && now - roomCreateLedger[0] > 60_000) roomCreateLedger.shift();
  if (rooms.size >= MAX_ROOMS) return false;
  if (roomCreateLedger.length >= MAX_ROOM_CREATES_PER_MINUTE) return false;
  roomCreateLedger.push(now);
  return true;
}

/* ── Round flow ─────────────────────────────────────────────────────── */

function categoryTracks(category) {
  const all = getTrackProvider().filter((track) => !track.unreadable);
  if (!category || category === 'all') return all;
  return all.filter((track) => topFolder(track) === category);
}

/** How many rounds a room can actually play with its current filter. */
function playableRounds(room) {
  const pool = categoryTracks(room.settings.category);
  return pool.length === 0 ? 0 : Math.min(room.settings.rounds, pool.length);
}

function refillQueue(room) {
  const pool = categoryTracks(room.settings.category);
  room.queue = rng.shuffle(pool.map((track) => track.id));
}

function startGame(room) {
  const pool = categoryTracks(room.settings.category);
  if (pool.length === 0) return false;

  room.roundNumber = 0;
  room.phase = 'playing';
  room.queue = [];
  room.nextTrackId = null;
  for (const player of room.players.values()) {
    player.totalScore = 0;
    player.status = 'guessing';
    player.ready = false;
  }
  refillQueue(room);
  startRound(room);
  return true;
}

function startRound(room) {
  if (!room.players.size) return;

  // The queue was stocked at the end of the previous round so its first entry
  // is exactly the song the clients already preloaded.
  if (room.queue.length === 0) refillQueue(room);
  room.nextTrackId = null;
  const trackId = room.queue.shift();
  const track = getTrackProvider().find((candidate) => candidate.id === trackId);
  if (!track) {
    // The library changed under us — try the next one, or end the game.
    if (room.queue.length > 0) return startRound(room);
    return endGame(room, 'library');
  }

  const startedAt = nowMs();
  const maxStep = config.round.durations.length - 1;

  room.roundNumber += 1;
  room.phase = 'playing';
  room.resolved = null;
  room.trackDuration = track.duration;
  room.round = {
    number: room.roundNumber,
    trackId: track.id,
    excerptStart: pickExcerptStart(track),
    startedAt,
    endsAt: startedAt + roomRoundSeconds(room) * 1000,
  };

  for (const player of room.players.values()) {
    player.step = 0;
    player.levelStartedAt = startedAt;
    /** Everything this player did on this song: guesses and skips. */
    player.events = [];
    player.guesses = 0;
    /** perReveal: the level whose single guess has already been spent. */
    player.guessedAtStep = null;
    player.status = player.connected ? 'guessing' : 'away';
    player.correct = false;
    player.answerSeconds = null;
    player.roundPoints = null;
    player.finishedAt = null;
    player.ready = false;
    player.maxStep = maxStep;
  }

  for (const player of room.players.values()) {
    send(player.socket, {
      t: 'round',
      round: {
        number: room.roundNumber,
        totalRounds: room.settings.rounds,
        excerptStart: room.round.excerptStart,
        endsAt: room.round.endsAt,
        durations: config.round.durations,
        attemptMode: room.settings.attemptMode,
      },
    });
    sendSelf(room, player);
  }
  broadcastRoom(room);

  if (room.timers.round) clearTimeout(room.timers.round);
  room.timers.round = setTimeout(() => resolveRound(room, 'timer'), Math.max(500, room.round.endsAt - nowMs()));
  touch(room);
}

/**
 * Unlock the next reveal level. Returns false at the last level, where there
 * is nothing left to reveal.
 */
function advancePlayer(player) {
  if (player.step >= config.round.durations.length - 1) return false;
  player.step += 1;
  player.levelStartedAt = nowMs();
  player.guessedAtStep = null;
  return true;
}

/**
 * Out of guesses with nothing left to hear: the round is over for this player.
 * Their reveal level is frozen as-is for the results table.
 */
function exhaustPlayer(room, player) {
  player.status = 'exhausted';
  player.roundPoints = 0;
  player.answerSeconds = null;
  player.finishedAt = nowMs();
  send(player.socket, { t: 'feedback', kind: 'exhausted' });
  sendSelf(room, player);
  broadcastRoom(room);
  if (allFinished(room)) resolveRound(room, 'all-finished');
}

/** True when no still-playing player remains (away players do not block). */
function allFinished(room) {
  for (const player of room.players.values()) {
    if (!player.connected) continue;
    if (player.status === 'guessing') return false;
  }
  return true;
}

function resolveRound(room, reason) {
  if (room.phase !== 'playing' || !room.round) return;
  if (room.timers.round) {
    clearTimeout(room.timers.round);
    room.timers.round = null;
  }

  const track = getTrackProvider().find((candidate) => candidate.id === room.round.trackId) ?? null;
  const roundNumber = room.roundNumber;

  const results = [];
  for (const player of room.players.values()) {
    const hadGuesses = (player.events ?? []).some((event) => event.kind === 'guess');
    // Someone who never said anything, and never guessed, was simply away.
    const status =
      player.status === 'finished'
        ? 'finished'
        : player.status === 'exhausted'
          ? 'exhausted'
          : player.status === 'away' && !hadGuesses
            ? 'away'
            : player.status === 'guessing'
              ? 'timedout'
              : 'gaveup';
    const points = status === 'finished' ? player.roundPoints ?? 0 : 0;
    player.totalScore += points;
    player.status = status;
    player.roundPoints = points;
    results.push({
      id: player.id,
      name: player.name,
      status,
      step: player.status === 'finished' || status === 'timedout' || status === 'exhausted' ? player.step : null,
      answerSeconds: player.answerSeconds,
      points,
      totalScore: player.totalScore,
      connected: player.connected,
      attempts: (player.events ?? []).filter((event) => event.kind === 'guess').length,
      skips: (player.events ?? []).filter((event) => event.kind === 'skip').length,
    });
  }

  results.sort((a, b) => b.points - a.points || (a.answerSeconds ?? 1e9) - (b.answerSeconds ?? 1e9) || a.name.localeCompare(b.name));

  room.phase = 'resolved';
  room.resolved = { roundNumber, trackId: room.round.trackId, excerptStart: room.round.excerptStart, at: nowMs() };
  // Decide the next song now (refilling first if the queue ran dry) so every
  // client can fetch and decode it while the countdown runs, instead of
  // paying for it when the round begins.
  if (room.queue.length === 0) refillQueue(room);
  room.nextTrackId = room.queue[0] ?? null;
  // Keep the song addressable while the reveal plays: the client already has
  // it decoded, and re-decoding the same file for the reveal was pure waste.
  room.lastAudioTrackId = room.round.trackId;
  room.round = null;

  // The spoiler dam breaks here and only here: title, artist and cover become
  // public the moment the whole room has finished the round.
  const reveal = track
    ? {
        id: track.id,
        title: track.title,
        artist: track.artist,
        hasCover: track.hasCover,
        album: track.album,
        duration: track.duration,
      }
    : null;

  for (const player of room.players.values()) {
    send(player.socket, {
      t: 'resolved',
      round: { number: roundNumber, excerptStart: room.resolved.excerptStart, track: reveal, reason },
      results,
    });
  }

  // Every round — the last one included — gets its reveal, its countdown and
  // its shared moment. Only when the intermission ends does the final board
  // take over, so the last answer is never swallowed by the scoreboard.
  room.intermissionEndsAt = nowMs() + INTERMISSION_SECONDS * 1000;
  broadcastRoom(room);
  room.timers.intermission = setTimeout(() => advance(room), INTERMISSION_SECONDS * 1000);
  touch(room);
}

/** Intermission over (or everyone ready): next round, or the final board. */
function advance(room) {
  if (room.phase !== 'resolved') return;
  if (room.timers.intermission) {
    clearTimeout(room.timers.intermission);
    room.timers.intermission = null;
  }
  room.intermissionEndsAt = null;
  if (room.roundNumber >= room.settings.rounds) {
    endGame(room, 'complete');
    return;
  }
  startRound(room);
}

function endGame(room, reason) {
  clearRoomTimers(room);
  room.phase = 'ended';
  room.round = null;
  room.intermissionEndsAt = null;

  const standings = [...room.players.values()]
    .map((player) => ({
      id: player.id,
      name: player.name,
      score: player.totalScore,
      correct: player.correctCount ?? 0,
      connected: player.connected,
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  for (const player of room.players.values()) {
    send(player.socket, { t: 'ended', reason, standings, totalRounds: room.settings.rounds });
  }
  broadcastRoom(room);
  touch(room);
}

/* ── Player actions ─────────────────────────────────────────────────── */

/**
 * Skipping is always available while a player is still guessing. In
 * `perReveal` a skip spends that level's one guess, which the rows show as a
 * neutral "Skipped" slot.
 */
function handleReveal(room, player) {
  if (room.phase !== 'playing' || !room.round) return;
  if (player.status !== 'guessing') return;

  if (!advancePlayer(player)) {
    send(player.socket, { t: 'reveal', step: player.step, atMax: true });
    return;
  }

  player.events.push({ kind: 'skip', step: player.step - 1 });
  send(player.socket, { t: 'reveal', step: player.step, atMax: player.step >= config.round.durations.length - 1 });
  sendSelf(room, player);
  touch(room);
}

function handleGuess(room, player, text, levelAt) {
  if (room.phase !== 'playing' || !room.round || player.status !== 'guessing') {
    send(player.socket, { t: 'feedback', kind: 'too-late' });
    return;
  }

  const guess = String(text ?? '').trim();
  if (!guess) return;

  // The attempt mode decides whether this guess is even allowed — the client
  // never gets a say.
  const mode = room.settings.attemptMode;
  if (mode === 'perReveal' && player.guessedAtStep === player.step) {
    send(player.socket, { t: 'feedback', kind: 'spent' });
    return;
  }
  /*
   * A per-reveal level pays for exactly one guess. Because a wrong guess
   * advances the level immediately, a second guess sent in the same breath
   * (double Enter, a stale tab) would silently land on the *next* level —
   * scoring an answer the player never heard. The client stamps each guess
   * with the level it was answering; a stamp that no longer matches is a
   * guess for a reveal that is already spent.
   */
  if (mode === 'perReveal' && Number.isFinite(levelAt) && levelAt !== player.levelStartedAt) {
    send(player.socket, { t: 'feedback', kind: 'spent' });
    return;
  }
  if (mode === 'single' && player.guesses > 0) {
    send(player.socket, { t: 'feedback', kind: 'spent' });
    return;
  }

  player.guesses += 1;

  const tracks = getTrackProvider();
  if (isCorrectGuess(guess, tracks, room.round.trackId)) {
    const seconds = Math.max(0, (nowMs() - player.levelStartedAt) / 1000);
    const points = scoreAnswer(player.step, seconds);
    player.status = 'finished';
    player.correct = true;
    player.correctCount = (player.correctCount ?? 0) + 1;
    player.answerSeconds = Math.round(seconds * 10) / 10;
    player.roundPoints = points;
    player.finishedAt = nowMs();
    player.events.push({ kind: 'guess', text: guess, step: player.step, correct: true });

    send(player.socket, { t: 'feedback', kind: 'correct', points, step: player.step, seconds: player.answerSeconds });
    sendSelf(room, player);
    broadcastRoom(room);

    if (allFinished(room)) resolveRound(room, 'all-finished');
    return;
  }

  player.events.push({ kind: 'guess', text: guess, step: player.step, correct: false });
  send(player.socket, { t: 'feedback', kind: 'wrong' });
  sendSelf(room, player);

  if (mode === 'perReveal') {
    // A wrong guess spends this level and reveals the next one.
    player.guessedAtStep = player.step;
    if (!advancePlayer(player)) {
      exhaustPlayer(room, player);
      return;
    }
    send(player.socket, {
      t: 'reveal',
      step: player.step,
      atMax: player.step >= config.round.durations.length - 1,
      automatic: true,
    });
    sendSelf(room, player);
  } else if (mode === 'single') {
    // One shot: that was the guess.
    exhaustPlayer(room, player);
    return;
  }

  touch(room);
}

function handleGiveUp(room, player) {
  if (room.phase !== 'playing' || !room.round) return;
  if (player.status !== 'guessing') return;
  player.status = 'gaveup';
  player.roundPoints = config.scoring.giveUpPoints ?? 0;
  player.answerSeconds = null;
  player.finishedAt = nowMs();
  send(player.socket, { t: 'feedback', kind: 'gaveup' });
  sendSelf(room, player);
  broadcastRoom(room);
  if (allFinished(room)) resolveRound(room, 'all-finished');
}

function handleReady(room, player) {
  if (room.phase !== 'resolved') return;
  if (player.ready) return; // repeated clicks are a no-op
  player.ready = true;
  broadcastRoom(room);
  const connected = [...room.players.values()].filter((candidate) => candidate.connected);
  if (connected.length > 0 && connected.every((candidate) => candidate.ready)) {
    advance(room);
  }
}

function handleLeave(socket, session) {
  const { room, playerId } = session;
  sessions.delete(socket);
  if (!room) return;
  const player = room.players.get(playerId);
  if (!player) return;
  player.socket = null;
  player.connected = false;

  // In the lobby, leaving means leaving: the seat opens up. Mid-game the seat
  // is kept so a refresh can reclaim it, but it never blocks a round.
  if (room.phase === 'lobby') {
    dropPlayer(room, player);
  } else if (room.hostId === player.id) {
    transferHost(room);
  }

  if (room.players.size === 0 || ![...room.players.values()].some((candidate) => candidate.connected)) {
    room.emptySince = nowMs();
  }

  if (room.phase === 'playing' && allFinished(room)) resolveRound(room, 'all-finished');
  broadcastRoom(room);
  touch(room);
}

/* ── Message handling ───────────────────────────────────────────────── */

function playerWithClientId(room, clientId) {
  if (!clientId) return null;
  for (const player of room.players.values()) {
    if (player.clientId === clientId) return player;
  }
  return null;
}

function nameTaken(room, name, exceptId) {
  const key = name.trim().toLowerCase();
  for (const player of room.players.values()) {
    if (player.id !== exceptId && player.name.trim().toLowerCase() === key) return true;
  }
  return false;
}

function joinRoom(socket, message) {
  const code = String(message.code ?? '').trim().toUpperCase();
  const name = String(message.name ?? '').trim().slice(0, 24);
  const clientId = String(message.clientId ?? '').slice(0, 64);

  if (!name) return fail(socket, 'name-required');
  const room = rooms.get(code);
  if (!room) return fail(socket, 'room-not-found', { code: code || '—' });

  // A refresh reclaims the existing seat instead of adding a new one.
  const existing = playerWithClientId(room, clientId);
  if (existing) {
    if (existing.socket && existing.socket !== socket) {
      send(existing.socket, { t: 'replaced' });
      sessions.delete(existing.socket);
      try {
        existing.socket.close();
      } catch {
        /* already gone */
      }
    }
    existing.socket = socket;
    existing.connected = true;
    existing.name = name;
    sessions.set(socket, { room, playerId: existing.id });
    touch(room);

    send(socket, { t: 'joined', room: publicRoom(room), playerId: existing.id, reconnected: true });
    sendSelf(room, existing);
    resumeAfterJoin(room, existing);
    broadcastRoom(room);
    return undefined;
  }

  if (room.phase !== 'lobby') {
    return fail(socket, 'in-progress');
  }
  if (room.players.size >= MP.maxPlayers) {
    return fail(socket, 'full', { code, max: MP.maxPlayers });
  }
  if (nameTaken(room, name)) {
    return fail(socket, 'duplicate-name', { code, name });
  }

  const player = {
    id: id(),
    clientId,
    name,
    socket,
    connected: true,
    isHost: room.players.size === 0,
    status: 'lobby',
    step: 0,
    levelStartedAt: null,
    attempts: [],
    correct: false,
    correctCount: 0,
    answerSeconds: null,
    roundPoints: null,
    totalScore: 0,
    ready: false,
    finishedAt: null,
  };
  room.players.set(player.id, player);
  if (!room.hostId || !rooms.get(code).players.has(room.hostId)) room.hostId = player.id;
  room.emptySince = null;
  sessions.set(socket, { room, playerId: player.id });
  touch(room);

  send(socket, { t: 'joined', room: publicRoom(room), playerId: player.id, reconnected: false });
  sendSelf(room, player);
  broadcastRoom(room);
  return undefined;
}

/** A reconnect mid-round must land in the right screen with the right step. */
function resumeAfterJoin(room, player) {
  if (room.phase === 'playing' && room.round) {
    send(player.socket, {
      t: 'round',
      round: {
        number: room.roundNumber,
        totalRounds: room.settings.rounds,
        excerptStart: room.round.excerptStart,
        endsAt: room.round.endsAt,
        durations: config.round.durations,
      },
    });
    sendSelf(room, player);
  }
}

function handleMessage(socket, message) {
  let data;
  try {
    data = JSON.parse(message);
  } catch {
    return undefined;
  }
  if (!data || typeof data.t !== 'string') return undefined;

  if (data.t === 'create') {
    if (sessions.has(socket)) return undefined;
    if (!spend(socket, 'create') || !mayCreateRoom()) return fail(socket, 'rate-limited');
    const room = createRoom({
      rounds: data.rounds,
      category: data.category,
      attemptMode: data.attemptMode,
      roundSeconds: data.roundSeconds,
    });
    return joinRoom(socket, { code: room.code, name: data.name, clientId: data.clientId });
  }

  if (data.t === 'join') {
    if (sessions.has(socket)) return undefined;
    if (!spend(socket, 'join')) return fail(socket, 'rate-limited');
    return joinRoom(socket, data);
  }

  const session = sessions.get(socket);
  if (!session || !session.room) {
    if (data.t !== 'ping') fail(socket, 'no-room');
    return undefined;
  }
  const { room, playerId } = session;
  const player = room.players.get(playerId);
  if (!player) return undefined;
  touch(room);

  switch (data.t) {
    case 'ping':
      return send(socket, { t: 'pong' });
    case 'settings':
      // Only the host, and only before the game: once it starts the rules are
      // the rules (the lobby comes back after the final board, for a rematch).
      if (player.id !== room.hostId || room.phase !== 'lobby') return undefined;
      if (data.rounds !== undefined) room.settings.rounds = clampRounds(data.rounds);
      if (data.category !== undefined) room.settings.category = String(data.category);
      if (data.attemptMode !== undefined && ATTEMPT_MODES.has(data.attemptMode)) {
        room.settings.attemptMode = data.attemptMode;
      }
      if (data.roundSeconds !== undefined) room.settings.roundSeconds = clampRoundSeconds(data.roundSeconds);
      return broadcastRoom(room);
    case 'start':
      if (player.id !== room.hostId || room.phase !== 'lobby') return undefined;
      if (playableRounds(room) === 0) {
        return fail(socket, 'empty-library');
      }
      startGame(room);
      return undefined;
    case 'reveal':
      if (!spend(socket, 'reveal')) return undefined;
      return handleReveal(room, player);
    case 'guess':
      if (!spend(socket, 'guess')) return undefined;
      return handleGuess(room, player, data.text, Number(data.levelAt));
    case 'giveup':
      return handleGiveUp(room, player);
    case 'ready':
      return handleReady(room, player);
    case 'leave':
      handleLeave(socket, session);
      return undefined;
    case 'back-to-lobby':
      if (player.id !== room.hostId || room.phase !== 'ended') return undefined;
      room.phase = 'lobby';
      room.roundNumber = 0;
      room.resolved = null;
      for (const other of room.players.values()) {
        other.status = 'lobby';
        other.ready = false;
        other.totalScore = 0;
        other.correctCount = 0;
        other.roundPoints = null;
        other.answerSeconds = null;
      }
      return broadcastRoom(room);
    default:
      return undefined;
  }
}

/* ── Wiring ─────────────────────────────────────────────────────────── */

/** @type {() => object[]} */
let getTrackProvider = () => [];

/** Sweep: forget rooms nobody has been in for a while. */
function sweepRooms() {
  const cutoff = nowMs() - IDLE_SECONDS * 1000;
  for (const room of [...rooms.values()]) {
    const hasConnected = [...room.players.values()].some((player) => player.connected);
    if (hasConnected) {
      room.emptySince = null;
      continue;
    }
    if (!room.emptySince) room.emptySince = nowMs();
    if (room.emptySince <= cutoff || (room.players.size === 0 && room.lastActivity <= cutoff)) {
      deleteRoom(room);
    }
  }
}

/**
 * @param {import('node:http').Server} httpServer
 * @param {{ getTracks: () => object[] }} deps
 */
export function attachMultiplayer(httpServer, deps) {
  getTrackProvider = deps.getTracks;

  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });
  liveServer = wss;

  wss.on('connection', (socket, request) => {
    /*
     * Off by default: behind a hosting proxy the browser's Origin and the
     * Host header do not always agree, and a wrong guess here would break the
     * game rather than protect it. Operators who know their domain can turn it
     * on with GTS_ALLOWED_ORIGINS, and then a browser page from anywhere else
     * is refused.
     */
    if (ALLOWED_ORIGINS.length) {
      const origin = String(request?.headers?.origin ?? '');
      if (!ALLOWED_ORIGINS.includes(origin)) {
        socket.close(1008, 'origin');
        return;
      }
    }
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    socket.on('message', (raw) => {
      try {
        handleMessage(socket, String(raw));
      } catch (error) {
        /*
         * A malformed frame is already ignored inside `handleMessage` (the
         * JSON parse is guarded there), so anything reaching this point is a
         * bug in our own code. Swallowing it would turn that bug into a game
         * that silently stops responding; log it and keep the socket alive.
         */
        console.error('WebSocket message failed:', error);
      }
    });
    socket.on('close', () => {
      const session = sessions.get(socket);
      if (session) handleLeave(socket, session);
    });
    socket.on('error', () => {});
  });

  // Drop half-open sockets so seats free up and rounds do not wait on ghosts.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        try {
          socket.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch {
        /* ignore */
      }
    }
  }, 20_000);

  // Sweep often enough that a short idle timeout still behaves predictably.
  const sweepEvery = Math.max(2000, Math.min(15_000, (IDLE_SECONDS * 1000) / 2));
  const sweeper = setInterval(sweepRooms, sweepEvery);

  httpServer.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(sweeper);
    wss.close();
  });

  return { rooms, deleteRoom };
}

/**
 * Say goodbye before the process goes away.
 *
 * Rooms live in memory only, so a deploy or a platform restart ends every game
 * in progress — there is nothing to restore them from. What can be done is to
 * tell each client *why* the socket is about to close, so the page shows a
 * sentence instead of a game that silently stops responding.
 */
export function closeMultiplayer() {
  if (!liveServer) return;
  const notice = JSON.stringify({
    t: 'error',
    code: 'server-restart',
    params: null,
    message: messageFor('server-restart'),
  });
  for (const socket of liveServer.clients) {
    try {
      if (socket.readyState === socket.OPEN) {
        socket.send(notice);
        socket.close(1012, 'restart');
      }
    } catch {
      /* the socket is already gone; nothing to say to it */
    }
  }
  liveServer = null;
}

/** How many rooms are alive right now — reported by the health endpoint. */
export function roomCount() {
  return rooms.size;
}

/**
 * The audio a room is allowed to hear right now — identified by an opaque
 * room code, never by track id, so nothing leaks before the reveal.
 *
 * @returns {{ relPath: string, fileName: string } | null}
 */
export function getRoundAudio(code) {
  const room = rooms.get(String(code ?? '').toUpperCase());
  if (!room) return null;

  // During the round this is the secret the clients must not learn; after the
  // reveal the same URL simply keeps serving the song that was just played, so
  // the post-round playback reuses the buffer the client already decoded.
  const trackId = room.round ? room.round.trackId : room.phase === 'ended' || room.phase === 'resolved' ? room.lastAudioTrackId : null;
  if (!trackId) return null;

  const track = getTrackProvider().find((candidate) => candidate.id === trackId);
  if (!track) return null;
  return { relPath: track.relPath, fileName: track.fileName };
}

/**
 * The song the room is about to play, while the reveal and its countdown are
 * on screen. Same rules as the round audio: addressed by room code, no id, no
 * metadata, and only served between rounds.
 */
export function getUpcomingAudio(code) {
  const room = rooms.get(String(code ?? '').toUpperCase());
  if (!room || room.phase !== 'resolved' || !room.nextTrackId) return null;
  const track = getTrackProvider().find((candidate) => candidate.id === room.nextTrackId);
  if (!track) return null;
  return { relPath: track.relPath, fileName: track.fileName };
}

/** Category tabs that make sense for this library. */
export function listCategories() {
  const counts = new Map();
  for (const track of getTrackProvider()) {
    if (track.unreadable) continue;
    const folder = topFolder(track);
    if (!folder) continue;
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count }));
}
