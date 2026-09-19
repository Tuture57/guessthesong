/**
 * Headless multiplayer protocol test — fast feedback on the authoritative
 * server without a browser. Node 22 has a global WebSocket.
 *
 *   node server/index.js --prod
 *   node tools/mp-smoke.mjs
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
    // A message that satisfies a waiting reader is consumed, not also queued —
    // otherwise a later read would hand back the stale one.
    const waiterIndex = waiters.findIndex((waiter) => waiter.match(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      waiter.resolve(message);
      return;
    }
    inbox.push(message);
  });
  const client = {
    socket,
    inbox,
    send: (message) => socket.send(JSON.stringify(message)),
    /** Wait for the next message matching `type` (or a predicate). */
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
    close: () => socket.close(),
  };
  return new Promise((resolve) => socket.addEventListener('open', () => resolve(client)));
}

/** Open the socket, then wait until it is actually listening. */
async function open(client) {
  await client;
  return client;
}

/**
 * The scoring invariant, exhaustively: the best possible score at a worse
 * reveal level must stay below the worst possible score at a better one.
 * Nothing here depends on the server — it is the formula itself.
 */
async function checkScoringInvariant() {
  const config = (await import('../config.js')).default;
  const { scoreAnswer } = await import('../shared/scoring.js');
  const table = config.scoring.pointsByStep;

  let worstAtBetter = Infinity;
  let ok = true;
  const rows = [];

  for (let step = 0; step < table.length; step += 1) {
    const best = scoreAnswer(step, 0); // fastest possible at this level
    const worst = scoreAnswer(step, config.scoring.speedBonusWindowSeconds * 10); // slowest
    rows.push(`${config.round.durations[step]}s: ${worst}..${best}`);
    if (step > 0 && best >= worstAtBetter) ok = false;
    worstAtBetter = worst;
  }

  check('a faster answer at a worse reveal level never beats a slower better one', ok, rows.join('  '));

  // Speed must be worth something within a level, and nothing beyond the window.
  check('speed bonus rewards a faster answer at the same level', scoreAnswer(0, 0.2) > scoreAnswer(0, 5));
  check('speed bonus fades to zero past its window', scoreAnswer(0, config.scoring.speedBonusWindowSeconds + 1) === table[0]);
  check('a faster answer at a worse level still loses to the better level', scoreAnswer(1, 0) < scoreAnswer(0, 999));
}

async function main() {
  const library = await (await fetch(`${BASE}/api/library`)).json();
  const titles = library.tracks.map((track) => track.title);
  console.log(`\nMultiplayer protocol test against ${WS}\n`);

  await checkScoringInvariant();

  const a = await open(connect());
  const b = await open(connect());

  /* ── Create + join ──────────────────────────────────────────────── */
  a.send({ t: 'create', name: 'Arthur', clientId: 'test-a', rounds: 5 });
  const joinedA = await a.next('joined');
  const code = joinedA.room.code;
  check('a room code is generated', /^[A-Z0-9]{4,6}$/.test(code), code);

  b.send({ t: 'join', code, name: 'Bob', clientId: 'test-b' });
  const joinedB = await b.next('joined');
  check('a second player joins', joinedB.room.players.length === 2);
  check('the creator is the host', joinedA.room.hostId === joinedA.playerId, joinedA.room.hostId);

  /* ── Rejections ─────────────────────────────────────────────────── */
  const c = await open(connect());
  c.send({ t: 'join', code: 'ZZZZZ', name: 'Ghost', clientId: 'test-c' });
  const invalid = await c.next('error');
  check('an invalid room code is rejected', invalid.code === 'room-not-found', invalid.code);

  c.send({ t: 'join', code, name: 'Arthur', clientId: 'test-c2' });
  const duplicate = await c.next('error');
  check('a duplicate name is rejected', duplicate.code === 'duplicate-name', duplicate.code);

  const late = await open(connect());
  late.send({ t: 'join', code, name: 'Late', clientId: 'test-late' });
  await late.next('joined');

  // A full room refuses the next player, with a message that says so.
  const fullRoom = await open(connect());
  fullRoom.send({ t: 'create', name: 'Crowded', clientId: 'full-0', rounds: 3 });
  const fullCode = (await fullRoom.next('joined')).room.code;
  const maxPlayers = (await import('../config.js')).default.multiplayer.maxPlayers;
  const crowd = [fullRoom];
  for (let i = 1; i < maxPlayers; i += 1) {
    const extra = await open(connect());
    extra.send({ t: 'join', code: fullCode, name: `Player ${i}`, clientId: `full-${i}` });
    await extra.next('joined');
    crowd.push(extra);
  }
  const overflow = await open(connect());
  overflow.send({ t: 'join', code: fullCode, name: 'One too many', clientId: 'full-x' });
  const fullError = await overflow.next('error');
  check('a full room refuses another player', fullError.code === 'full', fullError.code);
  for (const client of crowd) client.close();
  overflow.close();
  await sleep(200);

  /* ── Host starts ────────────────────────────────────────────────── */
  a.send({ t: 'start' });
  const roundA = await a.next('round');
  const roundB = await b.next('round');
  const roundLate = await late.next('round');
  check('every player receives the same round number', roundA.round.number === roundB.round.number);
  check(
    'every player receives the same frozen excerptStart',
    roundA.round.excerptStart === roundB.round.excerptStart && roundB.round.excerptStart === roundLate.round.excerptStart,
    String(roundA.round.excerptStart),
  );

  const selfA = await a.next('self');
  const selfB = await b.next('self');
  check('players start at the first reveal level', selfA.self.step === 0 && selfB.self.step === 0);

  const jumper = await open(connect());
  jumper.send({ t: 'join', code, name: 'Gatecrasher', clientId: 'test-jump' });
  const inProgress = await jumper.next('error');
  check('joining a game already in progress is refused', inProgress.code === 'in-progress', inProgress.code);
  jumper.close();

  /* ── Independent reveal ladders ─────────────────────────────────── */
  b.send({ t: 'reveal' });
  await b.next('reveal');
  b.send({ t: 'reveal' });
  await b.next('reveal');
  const selfB2 = await b.next((m) => m.t === 'self' && m.self.step === 2);
  // A never revealed, so every self it received must still say step 0.
  const aStayed = a.inbox.filter((m) => m.t === 'self').every((m) => m.self.step === 0);
  check('one player can reveal without moving the other', selfB2.self.step === 2 && aStayed, `B=${selfB2.self.step}`);

  /* ── A wrong guess does not end anything ────────────────────────── */
  a.send({ t: 'guess', text: 'definitely not the song' });
  const wrong = await a.next('feedback');
  check('a wrong guess comes back as wrong', wrong.kind === 'wrong', wrong.kind);

  /* ── First correct answer does NOT end the round ────────────────── */
  let solvedTitle = null;
  for (const title of titles) {
    a.send({ t: 'guess', text: title });
    const feedback = await a.next('feedback', 4000);
    if (feedback.kind === 'correct') {
      solvedTitle = title;
      break;
    }
  }
  check('a correct answer is accepted', Boolean(solvedTitle), solvedTitle ?? 'none matched');
  const aFinishedSelf = await a.next((m) => m.t === 'self' && m.self.status === 'finished');
  check('the correct answer carries points', aFinishedSelf.self.roundPoints > 0, String(aFinishedSelf.self.roundPoints));

  let resolvedEarly = false;
  await sleep(400);
  if (a.inbox.some((m) => m.t === 'resolved') || b.inbox.some((m) => m.t === 'resolved')) resolvedEarly = true;
  check('the first correct answer does not end the round', !resolvedEarly);

  /* ── No spoilers while the round is live ────────────────────────── */
  const spoilers = [
    ...a.inbox.filter((m) => m.t !== 'resolved'),
    ...b.inbox.filter((m) => m.t !== 'resolved'),
  ].flatMap((m) => JSON.stringify(m));
  const leaked = spoilers.filter((text) => solvedTitle && text.includes(solvedTitle));
  check('unfinished players receive no track title before the reveal', leaked.length === 0, leaked[0] ?? '');

  /* ── The last active player giving up resolves for everyone ─────── */
  b.send({ t: 'giveup' });
  await b.next('feedback');
  late.send({ t: 'giveup' });
  await late.next('feedback');
  const resolvedA = await a.next('resolved', 8000);
  const resolvedB = await b.next('resolved', 8000);
  check('resolution reaches every player', resolvedA.round.track?.title === resolvedB.round.track?.title);
  check('the reveal names the real track', resolvedA.round.track?.title === solvedTitle, resolvedA.round.track?.title);

  const winner = resolvedA.results[0];
  const loserByGivingUp = resolvedA.results.find((r) => r.name === 'Bob');
  check('the round winner is the one who answered', winner.name === 'Arthur' && winner.points > 0, `${winner.name} ${winner.points}`);
  check('giving up scores zero', loserByGivingUp?.points === 0, String(loserByGivingUp?.points));

  /* ── Ready flow ─────────────────────────────────────────────────── */
  a.send({ t: 'ready' });
  await sleep(150);
  const advancedEarly = a.inbox.some((m) => m.t === 'round');
  check('one ready does not start the next round on its own', !advancedEarly);

  b.send({ t: 'ready' });
  late.send({ t: 'ready' });
  const nextRoundA = await a.next('round', 8000);
  check('everyone ready starts the next round immediately', nextRoundA.round.number === 2, String(nextRoundA.round.number));

  /* ── Disconnects ────────────────────────────────────────────────── */
  late.close();
  await sleep(300);
  const roomAfterLeave = await a.next((m) => m.t === 'room' && m.room.players.some((p) => !p.connected));
  const away = roomAfterLeave.room.players.find((p) => !p.connected);
  check('a disconnect is visible as away', Boolean(away), away?.name);

  // Both remaining players finish: the away player must not block the round.
  for (const title of titles) {
    a.send({ t: 'guess', text: title });
    const feedback = await a.next('feedback', 4000);
    if (feedback.kind === 'correct') break;
  }
  b.send({ t: 'giveup' });
  const resolvedAgain = await a.next('resolved', 8000);
  check('a disconnected player does not block resolution', Boolean(resolvedAgain.round.track?.title), resolvedAgain.round.track?.title);

  /* ── Host disconnect transfers the host ─────────────────────────── */
  a.close();
  await sleep(400);
  const hostMoved = await b.next((m) => m.t === 'room' && m.room.hostId !== joinedA.playerId, 6000).catch(() => null);
  check('the host role transfers to a connected player', Boolean(hostMoved), hostMoved ? String(hostMoved.room.hostId) : 'no room update');

  b.close();
  await sleep(200);
  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length) {
    console.log('\nFailed:');
    for (const name of failures) console.log(`  - ${name}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
