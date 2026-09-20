# Guess The Song

Hear **0.1 seconds** of a track from your own music folder and name it.

Got it instantly? Maximum points. Stuck? Reveal more of the same excerpt —
**0.1s → 0.5s → 2s → 4s → 8s → 15s** — and watch your score drop with every
reveal.

There is a **multiplayer mode** too: everyone in a room hears the same clip at
the same moment, each player reveals audio at their own pace, and the player
who needs the *least* audio wins the round. No accounts, no matchmaking — just
a room code you share.

Everything runs on your machine. No uploads, no streaming service: the app
reads the folder you point it at and serves the audio to your own browser.

The whole interface is in French, and every string a player can read lives in
one file: [`src/i18n/fr.ts`](src/i18n/fr.ts). To deploy it on a host, see
[DEPLOY-INFOMANIAK.md](DEPLOY-INFOMANIAK.md).

---

## Getting started

Requires **Node.js 18 or newer** ([nodejs.org](https://nodejs.org)).

```bash
npm install
npm run dev
```

Open **http://localhost:5173**.

For a production run — one process, one port, no dev tooling:

```bash
npm run serve      # builds, then serves on http://localhost:8787
```

After that first build, `npm start` is enough to launch it again.

---

## Your music

Songs live in **`songs/`** next to this README. Subfolders work too — and every
top-level folder automatically becomes a category tab in the interface.

```
songs/
  Rock/Another Track.flac
  Hip Hop/One More.mp3
  Boulbi.mp3
```

Supported: **mp3, wav, flac, m4a, ogg, opus, aac, webm**.

**Just drop new files in — no restart needed.** The folder is watched, and the
new tracks appear in the game within a couple of seconds. The track counter in
the top-right corner is also a button: click it any time to rescan by hand.

### How tracks are named

The game reads embedded tags first (title, artist, album, cover art, duration).
If a file has no tags it falls back to the filename, understanding the usual
shapes (`Artist - Title.mp3`, `Artist - Title - Artist.mp3`, `Artist_Title.mp3`).

Tags are cleaned up on the way in: download-site suffixes, `(Official Video)`
markers and an artist name repeated at the front of the title are stripped, so
the answer you have to type is the one you would actually say out loud.

Artist names are canonicalised through `library.artistAliases` in `config.js`,
so `RoK`, `rok` and `R.O.K` all display as one artist.

---

## Playing

| Key | Action |
| --- | --- |
| `SPACE` | Play the excerpt — or, on the reveal panel, pause/resume the song |
| `ENTER` | Submit your answer — or take the highlighted suggestion |
| `↑` `↓` | Move through suggestions |
| `ESC` | Close the suggestions |
| `ENTER` | Next song, on the reveal panel |

### Singleplayer

- **Quick Play** — endless.
- **Rounds** — a fixed run, then a results screen.

The category tabs pick which folder the songs come from. The stacked rows are
your attempts on the song playing right now — one row per guess, plus a neutral
row for each reveal you skipped, all cleared when the next song starts. The
timeline marks where the excerpt currently stands, and the green button plays
it.

Every reveal step is worth less: **1200 → 1000 → 800 → 600 → 400 → 200**. A
wrong guess costs 25 points (never taking more than 75% of the step), and each
hit already landed in the run adds +10%, up to +50%.

### Multiplayer

**Multiplayer → Create room**, share the five-character code, everyone else
joins with **Join room** and a display name.

What is shared, and what is not:

| Shared by the server | Personal to each player |
| --- | --- |
| the song and the frozen excerpt position | how much audio they have revealed |
| the round number, start and server timer | their guesses, answer time and score |
| the rules the host chose | when they give up or finish |
| the reveal at the end of the round | their own attempt rows |

The first correct answer **does not** end the round — everyone plays it out,
and the round resolves when the last active player finishes or the round timer
runs out. Nobody sees the title, artist or cover until then.

#### The room settings

The host sets these in the lobby (and in the create-room dialog). Everyone
sees them, only the host can change them, and they lock when the game starts —
the lobby comes back after the final board, with the same players and the same
rules, for a rematch.

| Setting | Choices | What it does |
| --- | --- | --- |
| **Rounds** | 3 · 5 · 10 · 20 | How many songs the game runs |
| **Attempts** | Unlimited · Per reveal · One shot | How many guesses each player gets |
| **Time to guess** | 20s · 30s · 45s · 60s · 90s · Custom (10–180) | The whole room's clock for one song |
| **Category** | All · any real music folder | Which songs can come up |

**Unlimited** — guess as often as you like; only *Skip* moves you forward.

**Per reveal** — one guess at each duration. A wrong guess is recorded and the
next level opens by itself, so the attempt rows end up matching the ladder:

```
[ tell me - Kanii ]          wrong
[ Good Feeling - Flo Rida ]  wrong
[ Skipped ]                  you pressed skip instead
[ Boulbi ]                   correct
```

**One shot** — listen, skip, decide, and spend your single guess. Wrong ends
your round.

**Scoring.** Base points come from the reveal level that was needed; a small
speed bonus is added for answering quickly *at that level*:

```
points = basePoints[revealLevel] + speedBonus(secondsSinceThatLevelOpened)
```

The bonus is capped at **100**, while the base table falls by **200** per step.
The invariant — *a worse reveal level can never outscore a better one through
speed* — is therefore guaranteed by construction, not by tuning. `npm run
qa:mp` checks it exhaustively.

| Reveal | Base | Best possible | Slowest answer |
| --- | --- | --- | --- |
| 0.1s | 1200 | 1300 | 1200 |
| 0.5s | 1000 | 1100 | 1000 |
| 2s | 800 | 900 | 800 |
| 4s | 600 | 700 | 600 |
| 8s | 400 | 500 | 400 |
| 15s | 200 | 300 | 200 |

Giving up scores 0 and locks the round for that player. Between rounds everyone
presses **Ready** to shorten the countdown. If the host leaves, the next
connected player becomes host; a disconnected player never blocks the round
from resolving, and empty rooms are deleted after a minute.

### The live standings

The running classification is on screen for the whole match: a column beside
the game on a wide screen, a one-line summary (`Classement · 2ᵉ · 4 980`) that
opens an overlay on a phone. It ranks players exactly as the final scoreboard
does — same totals, same tie order — so the last update of a match *is* the
final board.

It is spoiler-free by construction rather than by rule: the only number it
reads is `player.score`, and the server adds to that total **when a round
resolves**. During a round nobody's total moves, so the board cannot say
anything about the song being played — no reveal level, no in-round points, no
answer speed. Before the first round resolves it shows nothing at all, because
a table of zeros is not a standing.

### Where the excerpt comes from

Not from the very start — that is silence or a fade on most music. By default a
random point in the body of the track is chosen (past the intro, far enough
from the end that the longest excerpt still fits). That position is picked once
per round and frozen: revealing more extends the same excerpt forward, it never
jumps somewhere else. In multiplayer the *server* picks it, so everyone hears
the same one.

### No waiting on PLAY

Every round fetches and decodes its song the moment the round starts — before
you press anything — and the next song is decoded during the reveal countdown.
PLAY therefore schedules a buffer that is already in memory: measured, the
first press of a multiplayer round went from **2.0–3.0 s** of decoding to
**under 5 ms**. While a round is still preparing, the button says so instead of
pretending to be ready. Decoded audio is held in a two-track cache and released
when you leave a room.

### Hearing the answer

As soon as a round is over the song starts from that same frozen position and
carries on past the end of the excerpt. The reveal panel shows where the
excerpt came from ("Playing from 1:17") with a small pause button; `SPACE` does
the same thing. Starting the next round stops it immediately.

### Volume

One setting for the whole game, in the top bar: a speaker that mutes, and a
slider from 0 to 100 %. It is not per-screen and not per-mode — a solo excerpt,
a multiplayer excerpt, the reveal's full song, a replay and the element
fallback all obey it, and it is stored in `localStorage` as `gts-volume`, so it
survives rounds, switching between solo and multiplayer, and a reload.

`gts-volume-muted` holds the switch separately from the level, which is what
makes un-muting return to the exact level you had rather than to full volume.

Inside the engine there is one gain node, and it is the only thing that ever
sets the output level:

```
AudioBufferSourceNode → per-playback fade → master gain → destination
```

A per-playback fade (the click-free entry and exit of an excerpt) sits *below*
the master, so moving the slider mid-excerpt is heard immediately and disturbs
no envelope. The master is ramped over 20 ms rather than stepped, because a
step in gain is an audible click. The fallback `<audio>` element is not on that
graph and mirrors the same value on its own `.volume`.

### Which song comes next

The server keeps a shuffled pool of the room's category, and every round takes
the next entry — so a game hears each song once before any song twice, and the
order differs every game. Songs only repeat when the host asks for more rounds
than there are songs to play.

That choice is made **once**, at the end of the previous round, and the round
that follows promotes it rather than drawing again. This is the whole of the
multiplayer synchronisation guarantee:

```
end of round N:  the next round is drawn  → { track, excerptStart, token }
                 every client preloads that token's audio
start of round N+1: the round *is* that draw — nothing is re-rolled
end of round N+1:  the reveal looks the track up by the round's own track id
```

Each round's audio is addressed by an opaque random **token**, minted with
the track and never reused (`/api/multi/audio/<room>/<token>`). It is the
reason a client can cache decoded audio safely: the URL cannot mean "whatever
this room is playing now", so a cached buffer can never turn into a different
song — across a rematch in the same room, a reconnect, a slow request, or a
reveal that arrives late. A token that is no longer current, no longer the one
just resolved and not the one being preloaded is refused rather than answered
with something else.

---

## Configuration

Everything tunable lives in **[`config.js`](config.js)** — reveal durations,
scoring, excerpt strategy, matching strictness, folder path, multiplayer
timers. It is plain data shared by the server and the browser; edit it and
restart.

```js
round:       { durations: [0.1, 0.5, 2, 4, 8, 15] }
scoring:     { pointsByStep: [1200, 1000, 800, 600, 400, 200],
               speedBonusMax: 100, speedBonusWindowSeconds: 15 }
excerpt:     { strategy: 'random' }      // 'random' | 'stable' | 'fixed'
multiplayer: { roundSeconds: 45, intermissionSeconds: 6, maxPlayers: 8 }
library:     { path: 'songs', artistAliases: { rok: 'R.O.K' } }
```

`pointsByStep` must line up with `durations` — one value per reveal step.

The room time is a host setting (10–180 s, default 45); `roundSeconds` here is
only the starting value. Two environment overrides exist for tuning and for the
tests:

```bash
GTS_MP_ROUND_SECONDS=20 GTS_MP_INTERMISSION_SECONDS=4 npm start
````

`GTS_MP_ROUND_SECONDS` pins every room's round time, which is how the test
suites keep a full game short.

### Environment

A hosting platform sets the port and expects one process, so the server reads
everything it needs from the environment — nothing has to be edited to deploy.

| Variable | What it does | Default |
|---|---|---|
| `PORT` | Port to listen on. **Set by the host**; the local default is a convenience | `8787` |
| `NODE_ENV` | `production` behaves like `--prod` | — |
| `MUSIC_DIR` | Music folder — relative to the project, or absolute | `songs` |
| `DATA_DIR` | Metadata cache and extracted covers (must be writable) | `.cache` |
| `WATCH` | `0` turns the folder watcher off; rescanning still works | `1` |
| `HOST` | Interface to bind. Unset means every interface, which is what a host's proxy needs | *(all)* |
| `GTS_MAX_ROOMS` | Ceiling on rooms held in memory | `500` |
| `GTS_ALLOWED_ORIGINS` | Comma-separated origins allowed to open a socket. Empty means anyone | *(empty)* |

```bash
MUSIC_DIR=./songs WATCH=0 NODE_ENV=production node server/index.js --prod
```

`DATA_DIR` matters on a host: the cache and the covers are written at runtime,
so they need a writable directory. If the project folder is read-only, point it
somewhere that is not — the songs themselves are only ever read.

### Language

Every string a player can read is in **[`src/i18n/fr.ts`](src/i18n/fr.ts)**.
Components read `t.screen.key`; nothing else in `src/` holds a sentence.
`src/i18n/index.ts` widens the dictionary and exports it, so adding a language
means copying that file, translating the values, and changing one import —
no component is touched. Numeric formatting (`points`, `seconds`, the French
decimal comma) lives there too.

Terms that matter: **« Écouter plus »** lengthens the excerpt, **« Abandonner »**
gives up on the song. They are deliberately different actions and never share a
word.

---

## Answer matching

Forgiving where it should be, strict where it matters. Case, accents,
apostrophes, punctuation, hyphens, `feat.` clauses and bracketed suffixes
(`(Remix)`, `[tubedel'hiver]`) are all ignored, the artist can be typed before
or after the title, and a single typo in a long title still counts.

It is never forgiving enough to accept a different song: the whole title has to
be there. In multiplayer the server runs the same matching, and its verdict is
the one that counts.

---

## Project layout

```
config.js              all tunable values, shared by server and client
shared/                excerpt picking, scoring and matching rules — the same
                       code runs on the server and in the browser
server/
  index.js             HTTP API: library, audio, cover art, categories, rooms
  multiplayer.js       authoritative rooms over WebSocket (/ws)
  guess.js             server-side answer checking
  library.js           folder scan, metadata cache, file watcher
  metadata.js          tag reading, filename parsing, title cleanup
  scan.js              npm run scan — print what the game would see
src/
  core/                audio engine, game state, matching, scoring, rooms
  ui/                  screens: home, round, reveal, results, multiplayer
  styles/              CSS, one file per area
tools/
  qa-single.mjs        singleplayer end-to-end test
  qa-multi.mjs         multiplayer end-to-end test (two browsers)
  mp-smoke.mjs         multiplayer protocol + scoring-invariant test
  mp-sync-invariants.mjs  the multiplayer round invariants, seeded
  mp-audio-sync.mjs    two browsers, audio fingerprinted, rematch included
  qa-volume.mjs        the global volume control
  shots.mjs            screenshot walkthrough for visual review
```

The client is TypeScript and plain DOM — no framework. `npm run dev` runs Vite
for the interface and the Node server for the API and the rooms; `npm run
serve` collapses everything into one process and one port.

---

## Testing

```bash
npm run build
npm run qa                # singleplayer end-to-end
npm run qa:multi          # multiplayer end-to-end — starts its own server on :8791
npm run qa:mp             # room protocol and scoring invariant
npm run qa:modes          # attempt modes, settings, host authority
npm run qa:fr             # the French interface, screen by screen
npm run qa:ui             # layout audit at 12 viewports (writes .audit/)
npm run latency           # audio timing report (see "No waiting on PLAY")

npm run qa:sync-invariants # round invariants against the real room engine
npm run qa:sync            # two browsers, audio fingerprinted (starts :8795)
npm run qa:volume          # volume: output gain, mute, persistence, layout
npm run qa:all             # typecheck + every suite above, in order
```

`npm run qa` drives a real browser through a full game — playback timing at
0.1s, wrong answers, the reveal ladder, autocomplete, a correct guess, the
results screen, post-round playback (position, pause/resume, no overlaps), the
category tabs reacting to folders appearing and disappearing, the element
fallback with the decoder deliberately broken, live library updates and a real
touch device.

`npm run qa:multi` opens two browsers, creates a room, and checks the whole
room lifecycle: independent reveal ladders, no spoilers (it inspects the actual
WebSocket frames each client receives), the scoring invariant in both
directions, give-up, disconnects, the round timer, the ready flow and the final
board. Screenshots land in `.qa/`.

`npm run qa:modes` drives the room protocol through all three attempt modes and
checks the settings rules: host-only changes, live sync to everyone, server-side
clamping, and the lock once a game starts.

`npm run qa:sync-invariants` is the multiplayer invariant suite: three real
WebSocket clients against the real room engine, with `Math.random` replaced by
a seeded generator so "the excerpt start varies" and "the track selection
varies" are structural facts instead of two rounds that happened to differ. It
checks the whole checklist — one authoritative track and excerpt per round, the
freeze across reveals, wrong guesses, skips and reconnects, the reveal's
metadata matching the audio that was played, the preloaded song being the song
the next round plays, a rematch reusing nothing, and every excerpt start leaving
room for the longest reveal.

`npm run qa:sync` opens two browsers and **fingerprints the audio itself**: it
taps every `AudioBufferSourceNode.start`, hashes the samples handed to the audio
hardware, and compares that hash with the file of the track the server revealed —
so "both players heard the same song, from the same second" is measured, not
inferred. It plays a game and then a rematch in the same room with one player
reloaded, which is where a cache key based on the round number used to hand a
player the previous game's song.

`npm run qa:volume` drives the volume control and reads the master gain node out
of the page, so the slider saying 40 % is only accepted alongside the output
gain being 0.4. It covers the default, persistence across a reload, mute and
un-mute keeping the level, keyboard use, the fallback element, a change made
while an excerpt is playing, and the four required viewports.

`npm run qa:ui` measures the layout of every screen — home, round, reveal,
multiplayer menu, lobby, in-game, results, error states — at twelve viewports
from 2560x1440 down to 360x800, including a simulated mobile keyboard. It fails
if any control leaves the viewport, escapes the column gutters, drops below its
touch size, or if the timeline pointer drifts off its segment, and writes
screenshots to `.audit/`.

`npm run shots` walks every screen and writes screenshots to `.shots/` for a
visual pass.

To inspect the index without starting the game:

```bash
npm run scan            # cached
npm run scan -- --force # re-read every file's tags
```

---

## Troubleshooting

**"No music found"** — the folder in `config.js` is missing or empty. Put audio
files in `songs/` and hit *Rescan folder*.

**A song does not play** — the file is listed but unreadable (corrupt, or a
codec the browser cannot decode). It is skipped when picking songs rather than
breaking a round.

**Two songs with the same title** — both stay in the library, but a guess
matches only one of them. Worth renaming one.

**Multiplayer players cannot connect** — everyone has to reach the same server.
On one machine that is `localhost`; for friends on the same network, share
`http://<your-lan-ip>:8787` and allow the port through the firewall.

**Port already in use** — change `server.port` in `config.js`. The dev proxy
follows it automatically.
