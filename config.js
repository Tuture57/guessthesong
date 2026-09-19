/**
 * Central configuration for Guess The Song.
 *
 * This file is imported by BOTH the Node server and the browser client, so it
 * must stay plain data (no Node APIs, no DOM APIs, no imports).
 *
 * Every gameplay-relevant value lives here: change it, restart `npm run dev`,
 * and the game follows.
 */
const config = {
  /* ── Music library ───────────────────────────────────────────────── */
  library: {
    // Folder to index. Relative paths resolve from the project root.
    path: 'songs',
    extensions: ['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.oga', '.opus', '.aac', '.webm'],
    // Metadata cache so restarts only re-parse files that actually changed.
    cacheFile: '.cache/library.json',
    // Live-update the index while the app is running.
    watch: true,
    /**
     * Spellings that mean the same artist. Tags and filenames drift ("RoK",
     * "rok"), and the game should show one consistent name for each artist.
     * Keys are compared with punctuation, case and spacing ignored.
     */
    artistAliases: {
      rok: 'R.O.K',
    },
  },

  /* ── Round flow ──────────────────────────────────────────────────── */
  round: {
    // Excerpt progression, in seconds. The player unlocks these one by one.
    durations: [0.1, 0.5, 2, 4, 8, 15],
    // 'title'      -> guess the song title
    // 'title+artist' -> guess the title, and the artist too when one exists
    answerMode: 'title',
  },

  /* ── Excerpt start position ──────────────────────────────────────── */
  /**
   * Where inside the track the excerpt is taken from. Picking 0s would hit
   * silence or a fade on many tracks, so the default strategy picks a point
   * inside the "body" of the song. The position is chosen once per round and
   * never moves while the player reveals more audio.
   *
   *   strategy: 'random' -> a new point each round (best for replayability)
   *             'stable' -> a fixed point per track, derived from its id
   *             'fixed'  -> always `fixedStartSeconds`
   */
  excerpt: {
    strategy: 'random',
    fixedStartSeconds: 45,
    minStartSeconds: 12, // never start before this
    introSkipRatio: 0.15, // ...nor before this share of the track
    latestStartRatio: 0.6, // ...nor after this share of the track
    tailPaddingSeconds: 2, // keep the longest excerpt clear of the ending
  },

  /* ── Scoring ─────────────────────────────────────────────────────── */
  /**
   * Base points per reveal step. Must line up with `round.durations`.
   * The gap between consecutive rows is always ≥ `speedBonusMax`, which makes
   * the scoring invariant mathematically guaranteed: a worse reveal level can
   * never outscore a better one through speed alone.
   */
  scoring: {
    pointsByStep: [1200, 1000, 800, 600, 400, 200],
    // Wrong guesses shave points off the eventual award (singleplayer)...
    wrongGuessPenalty: 25,
    // ...but never below this share of the step's value.
    minPointsRatio: 0.25,
    // Streak bonus: +10% per consecutive hit, capped at +50%.
    streakBonusPerRound: 0.1,
    maxStreakBonus: 0.5,
    // Same-level speed bonus (multipayer, and singleplayer display).
    // Rises from 0 to `speedBonusMax` as the same-level answer time drops
    // from `speedBonusWindowSeconds` to 0. Always < the base-table gap.
    giveUpPoints: 0,
    speedBonusMax: 100,
    speedBonusWindowSeconds: 15,
  },

  /* ── Game modes ──────────────────────────────────────────────────── */
  game: {
    // Rounds in a "Rounds" run. Quick Play ignores this and never ends.
    roundsPerGame: 10,
  },

  /* ── Answer matching ─────────────────────────────────────────────── */
  matching: {
    ignoreBracketedSuffixes: true, // "(Remix)", "[tubedel'hiver]", "feat. X"
  },

  /* ── Interface ───────────────────────────────────────────────────── */
  /* Behaviour only — every word the player reads lives in src/i18n/fr.ts. */
  ui: {
    autocompleteLimit: 7,
    // Keyboard shortcut: SPACE plays the excerpt (unless typing in the input).
    spaceToPlay: true,
  },

  /* ── Multiplayer ─────────────────────────────────────────────────── */
  multiplayer: {
    maxPlayers: 8,
    roomCodeLength: 5,
    // The host picks the round count from these.
    roundsChoices: [3, 5, 10, 20],
    defaultRounds: 10,
    maxRounds: 20,
    // Default round time. The host can change it per room (10–180 s); the
    // server ends a round when every active player has finished or when this
    // many seconds have passed, whichever comes first.
    roundSeconds: 45,
    // Between rounds: wait for everyone to press Ready, or this many seconds.
    intermissionSeconds: 6,
    // Empty rooms are deleted after this long.
    idleRoomTimeoutSeconds: 60,
  },

  /* ── Server ──────────────────────────────────────────────────────── */
  server: {
    port: 8787,
  },
};

export default config;