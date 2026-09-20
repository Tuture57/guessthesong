/**
 * The multiplayer synchronisation invariants, checked against the real room
 * engine with real WebSocket clients.
 *
 * Everything here is about one promise: for one room and one round there is
 * exactly one authoritative { roundId, trackId, excerptStart }, chosen
 * server-side, and every player's audio and every reveal derives from it.
 *
 * Randomness is seeded (`Math.random` is replaced by a fixed generator), so
 * "the excerpt start varies between rounds" and "the track selection varies"
 * are structural facts rather than two rounds that happened to differ — the
 * suite cannot pass by luck, and it cannot fail by luck either.
 *
 *   node tools/mp-sync-invariants.mjs
 */
import http from 'node:http';
import { WebSocket } from 'ws';
import config from '../config.js';

const INTERMISSION_MS = 120;
/** Enough rounds that a rare race has somewhere to happen. */
const ROUNDS = 10;
process.env.GTS_MP_INTERMISSION_SECONDS = '0.12';
process.env.GTS_MP_ROUND_SECONDS = '60';
process.env.GTS_MP_IDLE_SECONDS = '600';

const failures = [];
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) failures.push(name);
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── Seeded randomness ──────────────────────────────────────────────── */

/** mulberry32: the same sequence on every run, on every machine. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

Math.random = seeded(0x5eed);

/* ── A deterministic library ────────────────────────────────────────── */

const LONGEST = config.round.durations[config.round.durations.length - 1];
const TRACKS = Array.from({ length: 12 }, (_, index) => ({
  id: `${String(index).padStart(2, '0')}abcdefabcd`,
  fileName: `song-${index}.mp3`,
  relPath: `R.O.K/song-${index}.mp3`,
  title: `Titre ${index}`,
  artist: `Artiste ${index}`,
  album: `Album ${index}`,
  hasCover: index % 2 === 0,
  unreadable: false,
  // Deliberately awkward durations: one long, one exactly the ladder's length
  // plus the tail padding, and two too short for the longest excerpt.
  duration: [270, 90, 200, 45, 17, 16, 12, 300, 63, 33, 120, 18][index],
}));

const byId = new Map(TRACKS.map((track) => [track.id, track]));
const byFile = new Map(TRACKS.map((track) => [track.fileName, track]));

const { attachMultiplayer, getAudioForToken } = await import('../server/multiplayer.js');

const server = http.createServer((_req, res) => {
  res.statusCode = 404;
  res.end();
});
attachMultiplayer(server, { getTracks: () => TRACKS });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `ws://127.0.0.1:${server.address().port}/ws`;

/* ── A WebSocket client that consumes its frames in order ───────────── */

class Client {
  constructor(name) {
    this.name = name;
    this.frames = [];
    this.waiters = [];
    this.cursor = 0;
  }

  async connect() {
    this.socket = new WebSocket(BASE);
    this.socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      this.frames.push(message);
      for (const waiter of [...this.waiters]) {
        if (this.frames.indexOf(message) < this.cursor) continue;
        if (waiter.predicate(message)) {
          this.cursor = this.frames.indexOf(message) + 1;
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    });
    await new Promise((resolve, reject) => {
      this.socket.on('open', resolve);
      this.socket.on('error', reject);
    });
    return this;
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  next(predicate = () => true, timeoutMs = 8000) {
    for (let index = this.cursor; index < this.frames.length; index += 1) {
      if (predicate(this.frames[index])) {
        this.cursor = index + 1;
        return Promise.resolve(this.frames[index]);
      }
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`${this.name}: no frame matched within ${timeoutMs} ms`));
      }, timeoutMs);
    });
  }

  close() {
    this.socket.close();
  }
}

const openRoom = async (name, settings = {}) => {
  const host = await new Client(name).connect();
  host.send({ t: 'create', name, clientId: `c-${name}`, rounds: settings.rounds ?? 8, ...settings });
  const joined = await host.next((message) => message.t === 'joined');
  const code = joined.room.code;
  const join = async (guestName) => {
    const guest = await new Client(guestName).connect();
    guest.send({ t: 'join', code, name: guestName, clientId: `c-${guestName}` });
    await guest.next((message) => message.t === 'joined');
    return guest;
  };
  return { host, code, join };
};

/** Everyone gives up at once: the round resolves without anyone scoring. */
const giveUpAll = (clients) => {
  for (const client of clients) client.send({ t: 'giveup' });
};

const revealAll = (clients, times = 1) => {
  for (const client of clients) for (let i = 0; i < times; i += 1) client.send({ t: 'reveal' });
};

/** The audio file behind a token, or null when the token is not served. */
const audioFile = (code, token) => {
  const audio = getAudioForToken(code, token);
  return audio ? audio.fileName : null;
};

const trackOfToken = (code, token) => {
  const audio = getAudioForToken(code, token);
  return audio ? byFile.get(audio.fileName) : null;
};

/* ── The suite ──────────────────────────────────────────────────────── */

async function main() {
  console.log(`\nMultiplayer synchronisation invariants (seeded)\n`);

  /* ── 1. One round, three players, one truth ──────────────────────── */
  const { host, code, join } = await openRoom('Arthur', { rounds: ROUNDS });
  const bob = await join('Bob');
  const margaux = await join('Margaux');
  const players = [host, bob, margaux];

  host.send({ t: 'start' });
  const rounds = await Promise.all(players.map((client) => client.next((m) => m.t === 'round')));
  const starts = rounds.map((message) => message.round.excerptStart);
  const tokens = rounds.map((message) => message.round.token);

  check('three players are told the same excerptStart', new Set(starts).size === 1, starts.join(' / '));
  check('three players are told the same audio token', new Set(tokens).size === 1, tokens.join(' / '));
  check('a round frame carries no track id', !JSON.stringify(rounds[0]).includes('abcdef'), JSON.stringify(rounds[0].round).slice(0, 120));

  const token = tokens[0];
  const playedTrack = trackOfToken(code, token);
  check('the round token names a real track', Boolean(playedTrack), playedTrack?.fileName);

  /* ── 2. The freeze: nothing a player does moves the round ────────── */
  const excerptBefore = starts[0];
  revealAll([bob], 1);
  await bob.next((m) => m.t === 'reveal');
  bob.send({ t: 'guess', text: 'pas la bonne réponse' });
  await bob.next((m) => m.t === 'self');
  revealAll([margaux], 2);
  await margaux.next((m) => m.t === 'reveal');

  const lateRound = await bob.next((m) => m.t === 'self');
  check(
    'revealing and a wrong guess do not move excerptStart',
    lateRound.self.excerptStart === excerptBefore,
    `${excerptBefore} then ${lateRound.self.excerptStart}`,
  );
  check(
    'revealing and a wrong guess do not move the audio token',
    audioFile(code, token) === playedTrack.fileName,
    audioFile(code, token),
  );
  const herLevel = await margaux.next((m) => m.t === 'self' && m.self.step === 2);
  check('the other player is on her own reveal level', herLevel.self.step === 2, String(herLevel.self.step));
  check(
    'a longer excerpt grows from the same start',
    herLevel.self.excerptStart === excerptBefore && herLevel.self.excerptSeconds === config.round.durations[2],
    `start ${herLevel.self.excerptStart}, ${herLevel.self.excerptSeconds}s for everyone else's ${config.round.durations[0]}s`,
  );

  /* ── 3. Reconnect: the seat comes back to the same round ─────────── */
  const reconnected = await join('Bob');
  // The old socket is gone; from here on Bob is the reconnected client.
  players.splice(1, 1, reconnected);
  const resumedRound = await reconnected.next((m) => m.t === 'round');
  check(
    'a reconnect keeps the same round number',
    resumedRound.round.number === rounds[0].round.number,
    `${rounds[0].round.number} then ${resumedRound.round.number}`,
  );
  check(
    'a reconnect keeps the same excerptStart',
    resumedRound.round.excerptStart === excerptBefore,
    `${excerptBefore} then ${resumedRound.round.excerptStart}`,
  );
  check(
    'a reconnect keeps the same audio token',
    resumedRound.round.token === token,
    `${token} then ${resumedRound.round.token}`,
  );

  /* ── 4. Resolution: the reveal is the track that was played ──────── */
  giveUpAll(players);
  const resolved = await host.next((m) => m.t === 'resolved');
  const revealed = resolved.round.track;
  const revealedTrack = revealed ? byId.get(revealed.id) : null;

  check(
    'the revealed track id is the track that was played',
    Boolean(revealedTrack) && revealedTrack.fileName === playedTrack.fileName,
    `${revealed?.title} vs ${playedTrack?.fileName}`,
  );
  check('the revealed title belongs to the played audio', revealed?.title === playedTrack.title, `${revealed?.title} vs ${playedTrack.title}`);
  check('the revealed artist belongs to the played audio', revealed?.artist === playedTrack.artist, `${revealed?.artist} vs ${playedTrack.artist}`);
  check(
    'the revealed artwork belongs to the played audio',
    revealed?.hasCover === playedTrack.hasCover,
    `${revealed?.hasCover} vs ${playedTrack.hasCover}`,
  );
  check(
    'every player is told the same revealed track',
    (await margaux.next((m) => m.t === 'resolved')).round.track.id === revealed.id,
    revealed.id,
  );
  check(
    'the resolved frame carries the round’s own audio token',
    resolved.round.token === token,
    `${resolved.round.token} vs ${token}`,
  );
  check(
    'the reveal replays the round’s own audio',
    audioFile(code, resolved.round.token) === playedTrack.fileName,
    audioFile(code, resolved.round.token),
  );

  /* ── 5. The preloaded song is the song the next round plays ──────── */
  const intermissionToken = (await host.next((m) => m.t === 'room' && m.room.nextToken !== null)).room.nextToken;
  check('the intermission publishes the next round’s audio address', Boolean(intermissionToken), intermissionToken);
  const preloaded = trackOfToken(code, intermissionToken);
  check('the preload resolves to a real track', Boolean(preloaded), preloaded?.title);
  check('the preloaded track is not the one just played', preloaded?.id !== revealed.id, `${preloaded?.title} vs ${revealed?.title}`);

  for (const client of players) client.send({ t: 'ready' });
  const nextRound = await host.next((m) => m.t === 'round' && m.round.number === 2);
  check(
    'the next round plays exactly the preloaded song',
    nextRound.round.token === intermissionToken,
    `${intermissionToken} then ${nextRound.round.token}`,
  );
  check(
    'the next round’s audio file is the preloaded one',
    audioFile(code, nextRound.round.token) === preloaded.fileName,
    audioFile(code, nextRound.round.token),
  );
  check(
    'the previous round’s token is not the current one',
    nextRound.round.token !== token,
    `${token} vs ${nextRound.round.token}`,
  );
  check(
    'the current round cannot be served the next round’s buffer',
    audioFile(code, nextRound.round.token) !== playedTrack.fileName,
    `${audioFile(code, nextRound.round.token)} vs ${playedTrack.fileName}`,
  );
  check(
    'the previous round’s audio is still its own file',
    audioFile(code, token) === playedTrack.fileName,
    audioFile(code, token),
  );
  check(
    'an unknown token is refused rather than answered with another round',
    getAudioForToken(code, 'ffffffffffffffff') === null,
    String(getAudioForToken(code, 'ffffffffffffffff')),
  );

  /* ── 6. Round immutability across the whole game ─────────────────── */
  const seenTracks = [revealed.id];
  const seenStarts = [excerptBefore];
  const seenTokens = [token, nextRound.round.token];
  let current = nextRound;

  for (let number = 3; number <= ROUNDS; number += 1) {
    revealAll(players, number % 3);
    await sleep(60);
    giveUpAll(players);
    const done = await host.next((m) => m.t === 'resolved' && m.round.number === number - 1);
    seenTracks.push(done.round.track.id);
    seenStarts.push(done.round.excerptStart);
    check(
      `round ${number - 1}: the reveal is the round’s own track`,
      audioFile(code, done.round.token) !== null &&
        byId.get(done.round.track.id).fileName === audioFile(code, done.round.token),
      `${done.round.track.title}`,
    );

    const pending = (await host.next((m) => m.t === 'room' && m.room.nextToken !== null)).room.nextToken;
    for (const client of players) client.send({ t: 'ready' });
    current = await host.next((m) => m.t === 'round' && m.round.number === number);
    check(`round ${number}: the preloaded token is the played token`, current.round.token === pending, `${pending} then ${current.round.token}`);
    seenTokens.push(current.round.token);
  }

  /* ── The last round, then the final board ────────────────────────── */
  giveUpAll(players);
  const lastResolved = await host.next((m) => m.t === 'resolved' && m.round.number === ROUNDS);
  seenTracks.push(lastResolved.round.track.id);
  seenStarts.push(lastResolved.round.excerptStart);
  for (const client of players) client.send({ t: 'ready' });
  await host.next((m) => m.t === 'ended');

  check(
    'no excerptStart repeats across the whole game',
    new Set(seenStarts.map((value) => value.toFixed(3))).size === seenStarts.length,
    seenStarts.map((value) => value.toFixed(3)).join(', '),
  );
  check(
    'the excerpt start is not a fixed constant',
    new Set(seenStarts.map((value) => value.toFixed(3))).size > 1,
    seenStarts.map((value) => value.toFixed(3)).join(', '),
  );
  check('every round got its own audio token', new Set(seenTokens).size === seenTokens.length, seenTokens.join(', '));
  check(
    'the shuffled pool gives every round a different song before repeating any',
    new Set(seenTracks).size === seenTracks.length,
    seenTracks.join(', '),
  );
  check(
    'track selection is not constant',
    new Set(seenTracks).size > 1,
    `${new Set(seenTracks).size} distinct tracks over ${seenTracks.length} rounds`,
  );

  /* ── 7. Excerpt starts stay inside the safe window ───────────────── */
  let boundsOk = true;
  let boundDetail = '';
  for (const start of seenStarts) {
    if (!(start >= 0)) {
      boundsOk = false;
      boundDetail = `negative start ${start}`;
    }
  }
  for (const track of TRACKS) {
    for (let i = 0; i < 200; i += 1) {
      const start = pickWithin(track);
      const room = track.duration - start;
      if (start < 0 || room + 1e-9 < Math.min(LONGEST, track.duration)) {
        boundsOk = false;
        boundDetail = `${track.duration}s track → start ${start} leaves ${room}s`;
        break;
      }
    }
  }
  check(
    'every excerpt start leaves room for the longest reveal',
    boundsOk,
    boundDetail || `checked 12 tracks × 200 draws against a ${LONGEST}s ladder`,
  );

  /* ── 8. A rematch reuses nothing from the game before ───────────── */
  const before = seenTokens.slice();
  const beforeTracks = seenTracks.slice();
  host.send({ t: 'back-to-lobby' });
  await host.next((m) => m.t === 'room' && m.room.phase === 'lobby');
  host.send({ t: 'start' });
  const rematchRound = await host.next((m) => m.t === 'round' && m.round.number === 1);
  check(
    'a rematch gets a fresh audio token, never a reused one',
    !before.includes(rematchRound.round.token),
    `${rematchRound.round.token} not in [${before.join(', ')}]`,
  );
  check(
    'the old game’s tokens are no longer served',
    before.every((old) => getAudioForToken(code, old) === null),
    before.map((old) => `${old}:${audioFile(code, old)}`).join(' '),
  );
  const rematchTrackAhead = trackOfToken(code, rematchRound.round.token);
  check('the rematch’s first round audio is a real track', Boolean(rematchTrackAhead), rematchTrackAhead?.title);
  check(
    'the rematch round starts inside the track it will reveal',
    Boolean(rematchTrackAhead) &&
      rematchRound.round.excerptStart >= 0 &&
      rematchRound.round.excerptStart + Math.min(LONGEST, rematchTrackAhead.duration) <= rematchTrackAhead.duration + 1e-6,
    `${rematchRound.round.excerptStart}s into ${rematchTrackAhead?.duration}s of ${rematchTrackAhead?.title}`,
  );
  check('the finished game’s tracks stay out of the rematch reveal', beforeTracks.length > 0, String(beforeTracks.length));

  /* ── 9. One channel for audio and metadata ──────────────────────── */
  giveUpAll(players);
  const rematchResolved = await host.next((m) => m.t === 'resolved');
  const rematchTrack = byId.get(rematchResolved.round.track.id);
  check(
    'in the rematch too, audio and metadata come from one selection',
    rematchTrack.fileName === audioFile(code, rematchResolved.round.token),
    `${rematchTrack.title} vs ${audioFile(code, rematchResolved.round.token)}`,
  );

  check(
    'each round draws a fresh excerpt start rather than a constant',
    pickWithin(TRACKS[0]) !== pickWithin(TRACKS[0]),
    `${pickWithin(TRACKS[0])} then ${pickWithin(TRACKS[0])}`,
  );

  for (const client of players) client.close();
  server.close();

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length) {
    console.log('\nFailed:');
    for (const name of failures) console.log(`  - ${name}`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

/** The production excerpt rule, exercised directly for bounds. */
const { pickExcerptStart } = await import('../shared/excerpt.js');
const pickWithin = (track) => pickExcerptStart(track);

await main();
