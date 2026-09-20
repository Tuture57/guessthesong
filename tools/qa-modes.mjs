/**
 * Attempt-mode and room-settings tests — protocol level, no browser.
 *
 * Checks what the server actually enforces: how many guesses each mode allows,
 * when a wrong guess advances the reveal, and that settings are host-only,
 * validated, and locked once the game starts.
 *
 *   node server/index.js --prod      (or any running server)
 *   node tools/qa-modes.mjs
 */
const BASE = process.env.GTS_URL ?? 'http://localhost:8787';
const WS = BASE.replace(/^http/, 'ws') + '/ws';

const failures = [];
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) failures.push(name);
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  const socket = new WebSocket(WS);
  const inbox = [];
  const waiters = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const index = waiters.findIndex((waiter) => waiter.match(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter.resolve(message);
      return;
    }
    inbox.push(message);
  });

  const client = {
    socket,
    inbox,
    send: (message) => socket.send(JSON.stringify(message)),
    next(type, timeout = 8000) {
      const match = typeof type === 'function' ? type : (message) => message.t === type;
      const index = inbox.findIndex(match);
      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve: null, reject: null };
        const timer = setTimeout(() => {
          // Drop the waiter, or it would swallow a later matching message.
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`timeout waiting for ${String(type)}`));
        }, timeout);
        waiter.resolve = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
        waiters.push(waiter);
      });
    },
    clear: () => inbox.splice(0, inbox.length),
    /** The most recent `self` seen, without consuming it. */
    lastSelf: () => [...inbox].reverse().find((m) => m.t === 'self')?.self ?? null,
    close: () => socket.close(),
  };
  return new Promise((resolve) => socket.addEventListener('open', () => resolve(client)));
}

async function open(client) {
  await client;
  return client;
}

/** Create a room with the given settings, returning host, guest and code. */
async function room(settings) {
  const host = await open(connect());
  host.send({ t: 'create', name: 'Host', clientId: `h-${Math.random()}`, rounds: 3, ...settings });
  const joined = await host.next('joined');
  const guest = await open(connect());
  guest.send({ t: 'join', code: joined.room.code, name: 'Guest', clientId: `g-${Math.random()}` });
  await guest.next('joined');
  return { host, guest, code: joined.room.code };
}

async function main() {
  const library = await (await fetch(`${BASE}/api/library`)).json();
  const titles = library.tracks.map((track) => track.title);
  const wrong = () => `definitely not a song ${Math.random().toString(36).slice(2, 7)}`;

  console.log(`\nAttempt modes and room settings against ${BASE}\n`);

  /* ── Settings: defaults, validation, authority ──────────────────── */

  const { host, guest, code } = await room({ attemptMode: 'perReveal', roundSeconds: 45, rounds: 5 });
  host.clear();
  guest.clear();

  host.clear();
  guest.clear();

  host.send({ t: 'settings', roundSeconds: 90 });
  const afterTime = await guest.next((m) => m.t === 'room' && m.room.settings.roundSeconds === 90, 5000).catch(() => null);
  check('a settings change reaches the other players live', Boolean(afterTime), afterTime ? '90s' : 'no update');

  guest.clear();
  host.send({ t: 'settings', rounds: 7 });
  const afterRounds = await guest.next((m) => m.t === 'room' && m.room.settings.rounds === 7, 5000).catch(() => null);
  check('the host can change the number of rounds', Boolean(afterRounds), afterRounds ? '7' : 'no update');

  guest.clear();
  host.send({ t: 'settings', attemptMode: 'single' });
  const afterMode = await guest.next((m) => m.t === 'room' && m.room.settings.attemptMode === 'single', 5000).catch(() => null);
  check('the host can change the attempt mode', Boolean(afterMode));

  guest.clear();
  host.send({ t: 'settings', roundSeconds: 5000 });
  const clampedHigh = await guest.next((m) => m.t === 'room' && m.room.settings.roundSeconds === 180, 5000).catch(() => null);
  check('an absurd round time is clamped', Boolean(clampedHigh), clampedHigh ? '180' : 'not clamped');

  guest.clear();
  host.send({ t: 'settings', roundSeconds: 1 });
  const clampedLow = await guest.next((m) => m.t === 'room' && m.room.settings.roundSeconds === 10, 5000).catch(() => null);
  check('a too-short round time is clamped', Boolean(clampedLow), clampedLow ? '10' : 'not clamped');

  host.clear();
  host.send({ t: 'settings', attemptMode: 'cheat-mode' });
  await sleep(250);
  const stillSingle = await host.next((m) => m.t === 'room' && m.room.settings.attemptMode !== 'single', 800).catch(() => null);
  check('an unknown attempt mode is ignored', !stillSingle);

  guest.clear();
  guest.send({ t: 'settings', attemptMode: 'unlimited' });
  await sleep(250);
  const guestRejected = !guest.inbox.some((m) => m.t === 'room' && m.room.settings.attemptMode === 'unlimited');
  check('a non-host cannot change the settings', guestRejected);

  host.send({ t: 'settings', rounds: 4, attemptMode: 'perReveal', roundSeconds: 30 });
  await host.next((m) => m.t === 'room' && m.room.settings.roundSeconds === 30, 5000);
  host.send({ t: 'start' });
  const startedRound = await host.next('round');
  await guest.next('round');

  host.send({ t: 'settings', roundSeconds: 120 });
  await sleep(250);
  const locked = !host.inbox.some((m) => m.t === 'room' && m.room.settings.roundSeconds === 120);
  check('settings are locked once the game starts', locked);

  const roundInfo = startedRound;
  const endsAt = roundInfo?.round?.endsAt ?? null;
  if (endsAt) {
    const duration = Math.round((endsAt - Date.now()) / 1000);
    check('the chosen round time is the one actually used', duration >= 25 && duration <= 31, `${duration}s`);
  } else {
    check('the chosen round time is the one actually used', false, 'no round message');
  }
  check('the round carries the room attempt mode', roundInfo?.round?.attemptMode === 'perReveal', roundInfo?.round?.attemptMode);
  host.close();
  guest.close();
  await sleep(200);

  /* ── Mode: unlimited ────────────────────────────────────────────── */

  {
    const { host: h, code: c } = await room({ attemptMode: 'unlimited', roundSeconds: 60 });
    h.send({ t: 'start' });
    await h.next('round');
    await h.next('self');

    h.send({ t: 'guess', text: wrong() });
    check('unlimited: a wrong guess is accepted', (await h.next('feedback')).kind === 'wrong');
    h.send({ t: 'guess', text: wrong() });
    check('unlimited: a second wrong guess is accepted', (await h.next('feedback')).kind === 'wrong');
    h.send({ t: 'guess', text: wrong() });
    check('unlimited: a third wrong guess is accepted', (await h.next('feedback')).kind === 'wrong');

    const self = await h.next((m) => m.t === 'self' && m.self.events.length === 3);
    check('unlimited: the player stays at the first reveal level', self.self.step === 0, `step ${self.self.step}`);
    check('unlimited: every attempt is recorded', self.self.events.filter((e) => e.kind === 'guess').length === 3);

    h.send({ t: 'reveal' });
    const revealed = await h.next('reveal');
    check('unlimited: skipping still advances the reveal', revealed.step === 1 && revealed.atMax === false);
    const afterSkip = await h.next((m) => m.t === 'self' && m.self.step === 1);
    check('unlimited: the skip is recorded as its own row', afterSkip.self.events.some((e) => e.kind === 'skip'));
    h.close();
    await sleep(200);
    void c;
  }

  /* ── Mode: per reveal ───────────────────────────────────────────── */

  {
    const { host: h } = await room({ attemptMode: 'perReveal', roundSeconds: 60 });
    h.send({ t: 'start' });
    await h.next('round');
    // The self that belongs to the round, not the one sent when joining.
    const startSelf = await h.next((m) => m.t === 'self' && m.self.levelStartedAt > 0);
    const level0 = startSelf.self.levelStartedAt;

    // One guess at 0.1s: recorded, then the next level opens by itself.
    h.send({ t: 'guess', text: wrong(), levelAt: level0 });
    check('per reveal: the first guess is accepted', (await h.next('feedback')).kind === 'wrong');
    const advanced = await h.next((m) => m.t === 'self' && m.self.step === 1);
    check('per reveal: a wrong guess reveals the next level automatically', advanced.self.step === 1);
    const autoReveal = await h.next('reveal');
    check('per reveal: the client is told the reveal was automatic', autoReveal.automatic === true);
    check('per reveal: the wrong guess is recorded as a row', advanced.self.events.some((e) => e.kind === 'guess' && e.correct === false));

    // A second guess stamped with the *spent* level is refused, so a rapid
    // double submit cannot burn two levels with one heard excerpt.
    h.clear();
    h.send({ t: 'guess', text: wrong(), levelAt: level0 });
    check('per reveal: a guess for an already-spent reveal is refused', (await h.next('feedback')).kind === 'spent');
    await sleep(200);
    check('per reveal: the refused guess changes nothing', h.inbox.every((m) => m.t !== 'self'), `${h.inbox.length} message(s)`);

    // The same level, guessed properly: accepted.
    const level1 = advanced.self.levelStartedAt;
    h.send({ t: 'guess', text: wrong(), levelAt: level1 });
    check('per reveal: the next level accepts its own guess', (await h.next('feedback')).kind === 'wrong');
    const advanced2 = await h.next((m) => m.t === 'self' && m.self.step === 2);
    check('per reveal: that guess reveals the following level', advanced2.self.step === 2);
    await h.next('reveal');

    // Skipping spends a level without guessing, and shows as its own row.
    h.send({ t: 'reveal' });
    const skip = await h.next('reveal');
    check('per reveal: skipping advances without guessing', skip.step === 3, `step ${skip.step}`);
    const skipped = await h.next((m) => m.t === 'self' && m.self.events.some((e) => e.kind === 'skip'));
    check('per reveal: the skip appears as its own row', skipped.self.events.at(-1).kind === 'skip');

    // Spend the rest of the ladder: a wrong guess at 15s ends the round.
    let level = skipped.self.levelStartedAt;
    for (let step = 3; step < 6; step += 1) {
      h.clear();
      h.send({ t: 'guess', text: wrong(), levelAt: level });
      const feedback = await h.next('feedback', 6000).catch(() => null);
      if (!feedback || feedback.kind === 'exhausted') break;
      const moved = await h.next((m) => m.t === 'self' && m.self.step === step + 1, 4000).catch(() => null);
      if (!moved) break;
      level = moved.self.levelStartedAt;
    }
    const finalSelf = await h.next((m) => m.t === 'self' && m.self.status === 'exhausted', 6000).catch(() => null);
    check('per reveal: a wrong guess at the last level finishes the player', Boolean(finalSelf), finalSelf?.self?.status ?? 'still guessing');

    // Being out of tries sends its own note; drain it before asking what a
    // further submission gets.
    await h.next((m) => m.t === 'feedback' && m.kind === 'exhausted', 2000).catch(() => {});
    h.send({ t: 'guess', text: wrong() });
    const afterOut = await h.next('feedback', 3000).catch(() => null);
    check('per reveal: a finished player cannot guess again', afterOut?.kind === 'too-late', afterOut?.kind);
    h.close();
    await sleep(200);
  }

  /* ── Mode: one shot ─────────────────────────────────────────────── */

  {
    const { host: h } = await room({ attemptMode: 'single', roundSeconds: 60 });
    h.send({ t: 'start' });
    await h.next('round');
    await h.next('self');

    h.send({ t: 'reveal' });
    await h.next('reveal');
    h.send({ t: 'reveal' });
    await h.next('reveal');
    const held = await h.next((m) => m.t === 'self' && m.self.step === 2);
    check('one shot: the player can skip through levels before guessing', held.self.step === 2);

    h.send({ t: 'guess', text: wrong() });
    const shot = await h.next('feedback');
    check('one shot: the first guess is accepted', shot.kind === 'wrong', shot.kind);
    const ended = await h.next((m) => m.t === 'self' && m.self.status === 'exhausted', 6000).catch(() => null);
    check('one shot: a wrong guess finishes the player', Boolean(ended));
    // The server also sends an "out of guesses" note; drain it before asking
    // what happens to a second submission.
    await h.next((m) => m.t === 'feedback' && m.kind === 'exhausted', 2000).catch(() => {});

    h.send({ t: 'guess', text: wrong() });
    const second = await h.next('feedback', 3000).catch(() => null);
    check('one shot: a second submission is refused', second?.kind === 'too-late', second?.kind);
    h.close();
    await sleep(200);
  }

  /* ── Mode: one shot, correct answer still scores ────────────────── */

  {
    const { host: h, code: singleCode } = await room({ attemptMode: 'single', roundSeconds: 60 });
    h.roomCode = singleCode;
    h.send({ t: 'start' });
    const singleRound = await h.next('round');
    await h.next('self');

    // Identify the round's track the tester's way: the byte length of the
    // audio behind the token that round announced.
    const audio = await (await fetch(`${BASE}/api/multi/audio/${h.roomCode}/${singleRound.round.token}`))
      .arrayBuffer()
      .catch(() => null);
    let track = null;
    if (audio) {
      for (const candidate of library.tracks) {
        const head = await fetch(`${BASE}/api/audio/${candidate.id}`, { method: 'HEAD' });
        if (Number(head.headers.get('content-length')) === audio.byteLength) {
          track = candidate;
          break;
        }
      }
    }
    check('the round track can be identified by the tester', Boolean(track), track?.title ?? 'not found');

    if (track) {
      h.send({ t: 'guess', text: track.title });
      const feedback = await h.next('feedback', 6000);
      check('one shot: a correct answer scores', feedback.kind === 'correct' && feedback.points > 0, `${feedback.kind} ${feedback.points}`);
    }
    h.close();
    await sleep(200);
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length) {
    console.log('\nFailed:');
    for (const name of failures) console.log(`  - ${name}`);
    process.exit(1);
  }
  void titles;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
