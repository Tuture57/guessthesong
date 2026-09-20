/**
 * Multiplayer screens: menu (create / join), lobby, in-game and results.
 *
 * These views never decide anything. They render the server's room state and
 * send intents back — which is what makes one player's skip invisible to
 * everyone else, and makes the reveal land for the whole room at once.
 */
import { audio, coverUrl } from '../core/audio';
import type { PlaybackKind } from '../core/audio';
import { multiplayer } from '../core/multiplayer';
import type { Library } from '../core/library';
import { gameConfig } from '../core/types';
import type { AttemptEvent, MpAttemptMode, MpPlayer, MpResolved, MpStanding, MpStatus } from '../core/types';
import { countOf, fill, n, points, seconds, t } from '../i18n';
import { h, icon } from './dom';
import { LiveLeaderboard } from './leaderboard';
import { VolumeControl } from './volume';

const HAS_POINTER = window.matchMedia?.('(hover: hover)').matches ?? false;
const SONG_DELAY = 240;

/** Attempt rows on screen at once. Older ones scroll away rather than push. */
const MAX_ROWS = 6;
const MIN_ROWS = 6;

const ROUND_TIME_PRESETS = [20, 30, 45, 60, 90];
const ROUND_TIME_MIN = 10;
const ROUND_TIME_MAX = 180;

const ATTEMPT_MODES: { value: MpAttemptMode; label: string; hint: string }[] = [
  { value: 'unlimited', label: t.mp.modeUnlimitedLabel, hint: t.mp.modeUnlimitedHint },
  { value: 'perReveal', label: t.mp.modePerRevealLabel, hint: t.mp.modePerRevealHint },
  { value: 'single', label: t.mp.modeSingleLabel, hint: t.mp.modeSingleHint },
];

export function statusLabel(status: MpStatus, mode: MpAttemptMode): string {
  switch (status) {
    case 'lobby':
      return t.mp.statusReady;
    case 'guessing':
      return t.mp.statusGuessing;
    case 'finished':
      return t.mp.statusFinished;
    case 'gaveup':
      return t.mp.statusGaveUp;
    case 'timedout':
      return t.mp.statusTimeout;
    case 'exhausted':
      return mode === 'single' ? t.mp.statusExhaustedSingle : t.mp.statusExhausted;
    case 'away':
    default:
      return t.mp.statusAway;
  }
}

function attemptModeMeta(mode: MpAttemptMode) {
  return ATTEMPT_MODES.find((entry) => entry.value === mode) ?? ATTEMPT_MODES[0];
}

/** The room's rules as one readable line: "10 manches · Illimités · 45 s". */
function rulesLine(rounds: number, mode: MpAttemptMode, roundSeconds: number): HTMLElement {
  return h(
    'p',
    { class: 'mp-summary' },
    h('span', { text: countOf(rounds, t.common.roundOne, t.common.roundMany) }),
    h('span', { class: 'dot' }),
    h('span', { text: attemptModeMeta(mode).label }),
    h('span', { class: 'dot' }),
    h('span', { text: `${roundSeconds} s` }),
  );
}

/* ── Menu: create or join ───────────────────────────────────────────── */

export class MultiplayerMenu {
  readonly root: HTMLElement;

  private library: Library;
  private nameInput!: HTMLInputElement;
  private codeInput!: HTMLInputElement;
  private roundsSelect!: HTMLSelectElement;
  private categorySelect!: HTMLSelectElement;
  private modeSelect!: HTMLSelectElement;
  private timeSelect!: HTMLSelectElement;
  private notice!: HTMLElement;
  private createButton!: HTMLButtonElement;
  private joinButton!: HTMLButtonElement;

  constructor(library: Library) {
    this.library = library;
    this.root = h('div', { class: 'screen mp-menu' });
    this.build();
    this.update();
  }

  private build(): void {
    const shell = h('div', { class: 'shell mp-shell' });

    this.nameInput = h('input', {
      class: 'text-input mp-name',
      attrs: {
        type: 'text',
        placeholder: t.mp.yourNamePlaceholder,
        maxlength: '24',
        autocomplete: 'off',
        'aria-label': t.mp.yourName,
      },
      oninput: () => {
        multiplayer.name = this.nameInput.value;
      },
    });

    this.roundsSelect = h('select', { class: 'select mp-rounds', attrs: { 'aria-label': t.mp.roundsLabel } });
    for (const count of gameConfig.multiplayer.roundsChoices) {
      this.roundsSelect.append(
        h('option', { text: fill(t.mp.roundsOption, { count }), attrs: { value: String(count) } }),
      );
    }
    this.roundsSelect.value = String(gameConfig.multiplayer.defaultRounds);

    this.modeSelect = h('select', { class: 'select mp-attempt-mode', attrs: { 'aria-label': t.mp.attemptsLabel } });
    for (const mode of ATTEMPT_MODES) {
      this.modeSelect.append(h('option', { text: mode.label, attrs: { value: mode.value } }));
    }
    this.modeSelect.value = 'unlimited';

    this.timeSelect = h('select', { class: 'select mp-round-time', attrs: { 'aria-label': t.mp.roundTimeLabel } });
    for (const value of ROUND_TIME_PRESETS) {
      this.timeSelect.append(h('option', { text: fill(t.mp.secondsOption, { count: value }), attrs: { value: String(value) } }));
    }
    this.timeSelect.value = String(gameConfig.multiplayer.roundSeconds);

    this.categorySelect = h('select', { class: 'select mp-category', attrs: { 'aria-label': t.mp.categoryLabel } });

    this.createButton = h(
      'button',
      {
        class: 'btn btn-primary mp-create',
        attrs: { type: 'button' },
        onclick: () => {
          void multiplayer.createRoom({
            rounds: Number(this.roundsSelect.value),
            category: this.categorySelect.value || 'all',
            attemptMode: this.modeSelect.value as MpAttemptMode,
            roundSeconds: Number(this.timeSelect.value),
          });
        },
      },
      h('span', { text: t.mp.create }),
    );

    this.codeInput = h('input', {
      class: 'text-input mp-code-input',
      attrs: {
        type: 'text',
        placeholder: t.mp.roomCodePlaceholder,
        maxlength: '5',
        autocomplete: 'off',
        autocapitalize: 'characters',
        spellcheck: 'false',
        'aria-label': t.mp.roomCodeLabel,
      },
      oninput: () => {
        this.codeInput.value = this.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      },
      onkeydown: (event: KeyboardEvent) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void multiplayer.joinRoom(this.codeInput.value);
        }
      },
    });

    this.joinButton = h(
      'button',
      {
        class: 'btn btn-ghost mp-join',
        attrs: { type: 'button' },
        onclick: () => void multiplayer.joinRoom(this.codeInput.value),
      },
      h('span', { text: t.mp.join }),
    );

    this.notice = h('p', { class: 'mp-notice' });

    shell.append(
      h('h1', { class: 'mp-title', text: t.mp.title }),
      h('p', { class: 'mp-sub', text: t.mp.subtitle }),
      h('div', { class: 'mp-card mp-card-name' }, h('label', { class: 'mp-label', text: t.mp.yourName }), this.nameInput),
      h(
        'div',
        { class: 'mp-cards' },
        h(
          'section',
          { class: 'mp-card' },
          h('h2', { class: 'mp-card-title', text: t.mp.createTitle }),
          h(
            'div',
            { class: 'mp-fields' },
            h('div', { class: 'mp-field' }, h('label', { class: 'mp-label', text: t.mp.roundsLabel }), this.roundsSelect),
            h('div', { class: 'mp-field' }, h('label', { class: 'mp-label', text: t.mp.attemptsLabel }), this.modeSelect),
            h('div', { class: 'mp-field' }, h('label', { class: 'mp-label', text: t.mp.roundTimeLabel }), this.timeSelect),
            h('div', { class: 'mp-field' }, h('label', { class: 'mp-label', text: t.mp.categoryLabel }), this.categorySelect),
          ),
          this.createButton,
        ),
        h(
          'section',
          { class: 'mp-card' },
          h('h2', { class: 'mp-card-title', text: t.mp.joinTitle }),
          h('div', { class: 'mp-field' }, h('label', { class: 'mp-label', text: t.mp.roomCodeLabel }), this.codeInput),
          this.joinButton,
        ),
      ),
      this.notice,
      h(
        'button',
        { class: 'btn btn-ghost mp-back', attrs: { type: 'button' }, onclick: () => multiplayer.close() },
        h('span', { text: t.common.back }),
      ),
    );

    this.root.append(shell);
  }

  update(): void {
    if (this.nameInput.value !== multiplayer.name) this.nameInput.value = multiplayer.name;

    const categories = this.library.categories;
    if (this.categorySelect.options.length !== categories.length) {
      this.categorySelect.replaceChildren(
        ...categories.map((category) => h('option', { text: category.name, attrs: { value: category.value } })),
      );
    }

    const busy = multiplayer.connecting;
    this.createButton.disabled = busy;
    this.joinButton.disabled = busy;

    const notice = multiplayer.notice;
    this.notice.textContent = notice?.message ?? '';
    this.notice.dataset.kind = notice?.kind ?? '';
  }
}

/* ── Lobby ──────────────────────────────────────────────────────────── */

export class MultiplayerLobby {
  readonly root: HTMLElement;

  private library: Library;
  private codeEl!: HTMLElement;
  private copyButton!: HTMLButtonElement;
  private copyLabel!: HTMLElement;
  private playersList!: HTMLElement;
  private settingsHost!: HTMLElement;
  private roundsRow!: HTMLElement;
  private modesRow!: HTMLElement;
  private timesRow!: HTMLElement;
  private customTime!: HTMLInputElement;
  private customChip!: HTMLButtonElement;
  private categorySelect!: HTMLSelectElement;
  private summary!: HTMLElement;
  private startButton!: HTMLButtonElement;
  private hint!: HTMLElement;
  private copyTimer: number | null = null;
  private customOpen = false;

  constructor(library: Library) {
    this.library = library;
    this.root = h('div', { class: 'screen mp-lobby' });
    this.build();
    this.update();
  }

  private build(): void {
    const shell = h('div', { class: 'shell mp-shell' });

    this.codeEl = h('span', { class: 'mp-code-value' });
    this.copyLabel = h('span', { text: t.mp.copy });
    this.copyButton = h(
      'button',
      { class: 'mp-copy', attrs: { type: 'button', title: t.mp.copyTitle }, onclick: () => void this.copy() },
      icon('copy', 15, 1.9),
      this.copyLabel,
    );

    this.playersList = h('ul', { class: 'mp-players' });

    /* Rounds */
    this.roundsRow = h('div', { class: 'mp-chips', attrs: { 'aria-label': t.mp.roundsLabel } });
    for (const count of gameConfig.multiplayer.roundsChoices) {
      this.roundsRow.append(
        h('button', {
          class: 'mp-chip',
          text: String(count),
          attrs: { type: 'button', 'aria-pressed': 'false' },
          onclick: () => multiplayer.setRounds(count),
        }),
      );
    }

    /* Attempt mode */
    this.modesRow = h('div', { class: 'mp-modes', attrs: { 'aria-label': t.mp.attemptsLabel } });
    for (const mode of ATTEMPT_MODES) {
      this.modesRow.append(
        h(
          'button',
          {
            class: 'mp-mode',
            attrs: { type: 'button', 'data-mode': mode.value, 'aria-pressed': 'false' },
            onclick: () => multiplayer.setAttemptMode(mode.value),
          },
          h('span', { class: 'mp-mode-label', text: mode.label }),
          h('span', { class: 'mp-mode-hint', text: mode.hint }),
        ),
      );
    }

    /* Round time */
    this.customTime = h('input', {
      class: 'text-input mp-custom-time',
      attrs: {
        type: 'number',
        min: String(ROUND_TIME_MIN),
        max: String(ROUND_TIME_MAX),
        step: '5',
        inputmode: 'numeric',
        'aria-label': t.mp.customTimeAria,
      },
      onchange: () => {
        const value = Number(this.customTime.value);
        if (Number.isFinite(value)) multiplayer.setRoundSeconds(value);
      },
    });

    this.timesRow = h('div', { class: 'mp-chips', attrs: { 'aria-label': t.mp.roundTimeLabel } });
    for (const value of ROUND_TIME_PRESETS) {
      this.timesRow.append(
        h('button', {
          class: 'mp-chip',
          text: `${value} s`,
          attrs: { type: 'button', 'data-seconds': String(value), 'aria-pressed': 'false' },
          onclick: () => {
            this.customOpen = false;
            multiplayer.setRoundSeconds(value);
          },
        }),
      );
    }
    this.customChip = h('button', {
      class: 'mp-chip mp-chip-custom',
      text: t.mp.custom,
      attrs: { type: 'button', 'aria-pressed': 'false' },
      onclick: () => {
        this.customOpen = !this.customOpen;
        if (this.customOpen) {
          this.customTime.value = String(multiplayer.room?.settings.roundSeconds ?? 45);
          this.customTime.focus({ preventScroll: true });
        }
        this.update();
      },
    });
    this.timesRow.append(this.customChip);
    this.customTime.hidden = true;

    this.categorySelect = h('select', {
      class: 'select mp-category',
      attrs: { 'aria-label': t.mp.categoryLabel },
      onchange: () => multiplayer.setCategory(this.categorySelect.value),
    });

    /* The rules, in one line, always readable. */
    this.summary = h('p', { class: 'mp-summary' });

    this.startButton = h(
      'button',
      { class: 'btn btn-primary mp-start', attrs: { type: 'button' }, onclick: () => multiplayer.startGame() },
      h('span', { text: t.mp.start }),
    );

    this.hint = h('p', { class: 'mp-hint' });

    this.settingsHost = h(
      'div',
      { class: 'mp-settings' },
      h('div', { class: 'mp-setting' }, h('span', { class: 'mp-label', text: t.mp.roundsLabel }), this.roundsRow),
      h('div', { class: 'mp-setting' }, h('span', { class: 'mp-label', text: t.mp.attemptsLabel }), this.modesRow),
      h(
        'div',
        { class: 'mp-setting' },
        h('span', { class: 'mp-label', text: t.mp.roundTimeLabel }),
        this.timesRow,
        this.customTime,
      ),
      h(
        'div',
        { class: 'mp-setting mp-setting-row' },
        h('span', { class: 'mp-label', text: t.mp.categoryLabel }),
        this.categorySelect,
      ),
    );

    shell.append(
      h(
        'div',
        { class: 'mp-lobby-head' },
        h('span', { class: 'mp-label', text: t.mp.roomCodeLabel }),
        h('div', { class: 'mp-code-row' }, this.codeEl, this.copyButton),
      ),
      this.playersList,
      this.settingsHost,
      this.summary,
      h(
        'div',
        { class: 'mp-lobby-actions' },
        this.startButton,
        h(
          'button',
          { class: 'btn btn-ghost', attrs: { type: 'button' }, onclick: () => multiplayer.leave() },
          h('span', { text: t.mp.leave }),
        ),
      ),
      this.hint,
    );

    this.root.append(shell);
  }

  private async copy(): Promise<void> {
    const code = multiplayer.room?.code ?? '';
    const copied = await copyText(code);
    if (!copied) {
      // No clipboard (an insecure origin, a locked-down browser): select the
      // code so the player can copy it by hand rather than claim success.
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(this.codeEl);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }

    this.copyButton.classList.add('is-copied');
    this.copyLabel.textContent = copied ? t.mp.copied : t.mp.copyManual;
    this.copyButton.replaceChildren(icon(copied ? 'check' : 'copy', 15, copied ? 2 : 1.9), this.copyLabel);
    if (this.copyTimer !== null) clearTimeout(this.copyTimer);
    this.copyTimer = window.setTimeout(() => {
      this.copyTimer = null;
      this.copyButton.classList.remove('is-copied');
      this.copyLabel.textContent = t.mp.copy;
      this.copyButton.replaceChildren(icon('copy', 15, 1.9), this.copyLabel);
    }, 1600);
  }

  update(): void {
    const room = multiplayer.room;
    if (!room) return;

    this.codeEl.textContent = room.code;
    this.root.dataset.code = room.code;

    /* Player list — host first, then join order. */
    const ordered = [...room.players].sort((a, b) => Number(b.isHost) - Number(a.isHost) || a.name.localeCompare(b.name));
    this.playersList.replaceChildren(
      ...ordered.map((player) =>
        h(
          'li',
          { class: `mp-player${player.isHost ? ' is-host' : ''}${player.connected ? '' : ' is-away'}` },
          h('span', { class: 'mp-player-name', text: player.name }),
          player.id === multiplayer.playerId ? h('span', { class: 'mp-player-you', text: t.mp.you }) : null,
          !player.connected ? h('span', { class: 'mp-player-tag', text: t.mp.away }) : null,
          player.isHost ? h('span', { class: 'mp-player-tag is-host' }, icon('crown', 12, 2), h('span', { text: t.mp.host })) : null,
        ),
      ),
    );

    /* Settings: host steers, everyone else reads along. */
    const isHost = multiplayer.isHost;
    const settings = room.settings;

    for (const button of Array.from(this.roundsRow.children) as HTMLButtonElement[]) {
      button.setAttribute('aria-pressed', String(Number(button.textContent) === settings.rounds));
      button.disabled = !isHost;
    }

    for (const button of Array.from(this.modesRow.children) as HTMLButtonElement[]) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === settings.attemptMode));
      button.disabled = !isHost;
    }

    const presetMatch = ROUND_TIME_PRESETS.includes(settings.roundSeconds);
    for (const button of Array.from(this.timesRow.children) as HTMLButtonElement[]) {
      if (button === this.customChip) continue;
      button.setAttribute('aria-pressed', String(Number(button.dataset.seconds) === settings.roundSeconds));
      button.disabled = !isHost;
    }
    this.customChip.setAttribute('aria-pressed', String(this.customOpen || !presetMatch));
    this.customChip.textContent =
      !presetMatch && !this.customOpen ? fill(t.mp.customWithValue, { seconds: settings.roundSeconds }) : t.mp.custom;
    this.customChip.disabled = !isHost;
    this.customTime.hidden = !this.customOpen || !isHost;
    if (this.customOpen && document.activeElement !== this.customTime) {
      this.customTime.value = String(settings.roundSeconds);
    }
    this.customTime.disabled = !isHost;

    const categories = this.library.categories;
    if (this.categorySelect.options.length !== categories.length) {
      this.categorySelect.replaceChildren(
        ...categories.map((category) => h('option', { text: category.name, attrs: { value: category.value } })),
      );
    }
    this.categorySelect.value = settings.category;
    this.categorySelect.disabled = !isHost;

    /* The rules in one line, plus the category this library actually has. */
    const categoryName = categories.find((category) => category.value === settings.category)?.name ?? 'Toutes';
    const summary = rulesLine(settings.rounds, settings.attemptMode, settings.roundSeconds);
    summary.append(h('span', { class: 'dot' }), h('span', { text: categoryName }));
    this.summary.replaceWith(summary);
    this.summary = summary;

    this.startButton.hidden = !isHost;
    this.startButton.disabled = room.players.filter((player) => player.connected).length < 1;

    this.hint.textContent = isHost ? t.mp.waitingHost : t.mp.waitingPlayer;
  }
}

/* ── In-game ────────────────────────────────────────────────────────── */

export class MultiplayerGame {
  readonly root: HTMLElement;

  private library: Library;
  private codeChip!: HTMLElement;
  private roundEl!: HTMLElement;
  private timerEl!: HTMLElement;
  private scoreEl!: HTMLElement;
  private statusStrip!: HTMLElement;
  private board = new LiveLeaderboard();
  private rowsHost!: HTMLElement;
  private ladderSteps: HTMLElement[] = [];
  private pointer!: HTMLElement;
  private durationValue!: HTMLElement;
  private durationUnit!: HTMLElement;
  private playButton!: HTMLButtonElement;
  private playStatus!: HTMLElement;
  private revealButton!: HTMLButtonElement;
  private revealLabel!: HTMLElement;
  private giveUpButton!: HTMLButtonElement;
  private field!: HTMLElement;
  private fieldIcon!: SVGSVGElement;
  private input!: HTMLInputElement;
  private note!: HTMLElement;
  private suggestionList!: HTMLElement;
  private overlay: HTMLElement | null = null;
  private transport: { root: HTMLElement; toggle: HTMLButtonElement; fill: HTMLElement } | null = null;
  /** The reveal's own speaker — the top bar is under the overlay. */
  private revealVolume: VolumeControl | null = null;
  private songTimer: number | null = null;
  private transportFrame: number | null = null;
  private ticker: number | null = null;
  private noteTimer: number | null = null;
  private playStatusTimer: number | null = null;
  /** Shown under PLAY when a clip refuses to play, until the timer clears it. */
  private playError: string | null = null;

  /** The round whose audio is being fetched and decoded ahead of PLAY. */
  private preparedKey: string | null = null;
  private preparing = false;
  /** The round already warmed during the previous intermission. */
  private warmedKey: string | null = null;

  private suggestions: { track: { id: string; title: string; artist: string } }[] = [];
  private lastRoundNumber = -1;
  private lastStep = -1;
  private lastResolvedKey = '';
  /** null forces the next render: an empty stack must still be redrawn. */
  private lastRowsSignature: string | null = null;

  constructor(library: Library) {
    this.library = library;
    this.root = h('div', { class: 'screen round mp-game' });
    this.build();
    audio.onEnded = (kind) => this.onPlaybackEnded(kind);
    window.addEventListener('keydown', this.onKeyDown);
    this.startTicker();
  }

  dispose(): void {
    this.stopTicker();
    this.hideOverlay();
    audio.onEnded = null;
    this.stopTransportTicker();
    if (this.noteTimer !== null) clearTimeout(this.noteTimer);
    if (this.playStatusTimer !== null) clearTimeout(this.playStatusTimer);
    this.noteTimer = null;
    this.playStatusTimer = null;
    window.removeEventListener('keydown', this.onKeyDown);
  }

  private build(): void {
    const shell = h('div', { class: 'shell' });

    this.codeChip = h('span', { class: 'mp-code-chip' });
    this.roundEl = h('span', { class: 'hud-value mono' });
    this.timerEl = h('span', { class: 'hud-value mono mp-timer' });
    this.scoreEl = h('span', { class: 'hud-value mono' });

    const hud = h(
      'div',
      { class: 'hud mp-hud' },
      h('div', { class: 'hud-item' }, h('span', { class: 'hud-label', text: t.mp.hudRoom }), this.codeChip),
      h('div', { class: 'hud-sep' }),
      h('div', { class: 'hud-item' }, h('span', { class: 'hud-label', text: t.mp.hudRound }), this.roundEl),
      h('div', { class: 'hud-sep' }),
      h('div', { class: 'hud-item' }, h('span', { class: 'hud-label', text: t.mp.hudTime }), this.timerEl),
      h('div', { class: 'hud-sep' }),
      h('div', { class: 'hud-item' }, h('span', { class: 'hud-label', text: t.mp.hudScore }), this.scoreEl),
    );

    /* Where everyone stands — a strip, deliberately not a second table. */
    this.statusStrip = h('div', { class: 'mp-status' });

    /* The attempt rows: this player's guesses and skips on this song. */
    this.rowsHost = h('ol', { class: 'rows mp-attempt-rows' });

    this.durationValue = h('span', { class: 'duration-value', text: '0,1' });
    this.durationUnit = h('span', { class: 'duration-unit', text: t.common.seconds });
    const label = h('div', { class: 'duration-hero' }, this.durationValue, this.durationUnit);

    this.ladderSteps = gameConfig.round.durations.map((duration, index) =>
      h(
        'li',
        { class: 'ladder-step', dataset: { step: String(index) } },
        h('span', { class: 'ladder-bar' }),
        h('span', { class: 'ladder-label', text: `${seconds(duration)} s` }),
      ),
    );
    this.pointer = h('span', { class: 'ladder-pointer' });
    const track = h('div', { class: 'ladder-track' }, h('ol', { class: 'ladder' }, ...this.ladderSteps), this.pointer);
    track.style.setProperty('--steps', String(gameConfig.round.durations.length));
    const timeline = h('div', { class: 'timeline' }, label, track);

    this.playButton = h(
      'button',
      {
        class: 'play',
        attrs: { type: 'button', 'aria-label': t.round.playAria },
        onclick: () => void this.playExcerpt(),
      },
      icon('play', 30, 1.9, 'play-icon'),
      h('span', { class: 'play-spinner' }),
    );
    this.playStatus = h('span', { class: 'play-status' });
    const playWrap = h('div', { class: 'play-wrap' }, this.playButton, this.playStatus);

    this.fieldIcon = icon('search', 17, 1.9, 'field-icon');
    this.input = h('input', {
      class: 'field-input',
      attrs: {
        type: 'text',
        placeholder: t.round.searchTitle,
        autocomplete: 'off',
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
        'aria-label': t.round.answerAria,
      },
      oninput: () => this.onInput(),
      onkeydown: (event: KeyboardEvent) => this.onFieldKeyDown(event),
    });
    this.suggestionList = h('div', { class: 'suggestions', attrs: { role: 'listbox' } });
    this.field = h(
      'form',
      { class: 'field', onsubmit: (event: Event) => { event.preventDefault(); this.submit(); } },
      this.fieldIcon,
      this.input,
      this.suggestionList,
    );

    this.revealLabel = h('span', { text: t.mp.listenMore });
    this.revealButton = h(
      'button',
      { class: 'mp-reveal', attrs: { type: 'button' }, onclick: () => multiplayer.reveal() },
      this.revealLabel,
    );
    this.giveUpButton = h(
      'button',
      { class: 'mp-giveup', attrs: { type: 'button' }, onclick: () => multiplayer.giveUp() },
      h('span', { text: t.mp.giveUp }),
    );

    const answer = h('div', { class: 'answer mp-answer' }, this.field, this.revealButton, this.giveUpButton);
    this.note = h('p', { class: 'mp-note' });

    /*
     * The board is a sibling of the game column, not part of it: the
     * stylesheet turns that pair into a row with a ranking column on a wide
     * screen, and into a stacked pair with a one-line summary on a phone —
     * without either layout being able to push the game off the screen.
     */
    const body = h(
      'div',
      { class: 'mp-body' },
      h('div', { class: 'stage' }, this.statusStrip, this.rowsHost, timeline, playWrap, answer, this.note),
      this.board.root,
    );

    shell.append(hud, body);
    this.root.append(shell);
  }

  /* ── Round audio: prepared before the player can press play ───────── */

  /**
   * Fetch and decode the round's audio the moment the round starts, so PLAY
   * schedules a buffer that is already in memory. Measured before this change:
   * a cold PLAY spent ~1.9–2.9 s decoding the file.
   */
  private async prepareRound(): Promise<void> {
    const token = multiplayer.round?.token ?? '';
    const url = multiplayer.audioUrl(token);
    const key = multiplayer.audioKey(token);
    if (!url || !key || key === this.preparedKey) return;

    this.preparedKey = key;
    this.preparing = true;
    this.updatePlayState();

    // A failure here is not fatal: PLAY falls back to loading on demand.
    await audio.prepare(key, url);
    // The room may have moved on while this was decoding.
    if (this.preparedKey !== key) return;
    this.preparing = false;
    this.updatePlayState();
  }

  /**
   * Warm the next round's audio while the players are watching the reveal.
   * The server exposes it under its own opaque URL for exactly that window, so
   * the next round opens with the excerpt already decoded.
   */
  private warmNextRound(): void {
    const room = multiplayer.room;
    if (!room || room.phase !== 'resolved' || !room.nextToken) return;

    // The token is the round's own: warming it can only ever fetch the song
    // the next round will actually play, and never a repeat of this one.
    const key = multiplayer.audioKey(room.nextToken);
    const url = multiplayer.audioUrl(room.nextToken);
    if (!key || !url || key === this.warmedKey) return;
    this.warmedKey = key;
    void audio.prepare(key, url);
  }

  /**
   * The line under PLAY. It is repainted on every render, so the "could not
   * play that" message is held in state rather than written straight to the
   * DOM — otherwise the next update would wipe it before it could be read.
   */
  private updatePlayState(): void {
    const active = multiplayer.roundActive;
    this.playButton.classList.toggle('is-loading', this.preparing);
    this.playButton.disabled = this.preparing || !active;
    const message = this.preparing ? t.mp.preparing : (this.playError ?? '');
    const isError = !this.preparing && Boolean(this.playError);
    this.playStatus.textContent = message;
    this.playStatus.classList.toggle('is-error', isError);
    this.playStatus.hidden = message === '';
  }

  private async playExcerpt(): Promise<void> {
    const round = multiplayer.round;
    const url = multiplayer.audioUrl(round?.token ?? '');
    const key = multiplayer.audioKey(round?.token ?? '');
    if (!round || !url || !key) return;

    const step = multiplayer.self?.step ?? 0;
    const duration = multiplayer.self?.excerptSeconds ?? multiplayer.durations[step] ?? 0;
    if (duration <= 0) return;

    const wasReady = audio.isReady(key);
    if (!wasReady) {
      this.playButton.classList.add('is-loading');
      this.playStatus.textContent = t.mp.preparing;
      this.playStatus.hidden = false;
    }

    const started = await audio.playRemote(key, url, round.excerptStart, duration);
    this.playButton.classList.remove('is-loading');
    if (!started) {
      this.showPlayError();
      return;
    }
    this.updatePlayState();
    this.playButton.classList.add('is-playing');
  }

  private onPlaybackEnded(kind: PlaybackKind): void {
    if (kind === 'excerpt') this.playButton.classList.remove('is-playing');
    else this.setTransportState('ended');
  }

  /* ── Answering ────────────────────────────────────────────────────── */

  private onInput(): void {
    this.suggestions = this.library.search(this.input.value) as unknown as { track: { id: string; title: string; artist: string } }[];
    this.renderSuggestions();
  }

  private submit(explicit?: string): void {
    if (!multiplayer.roundActive) return;
    const text = (explicit ?? this.input.value).trim();
    if (!text) return;
    multiplayer.guess(text);
    this.input.value = '';
    this.suggestions = [];
    this.renderSuggestions();
  }

  private onFieldKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      const active = this.suggestions[0];
      const typed = this.input.value.trim();
      const guess = active && typed.length >= 2 ? active.track.title : typed;
      this.submit(guess);
      return;
    }
    if (event.key === 'Escape') {
      this.suggestions = [];
      this.renderSuggestions();
    }
  }

  private renderSuggestions(): void {
    this.suggestionList.replaceChildren();
    if (this.suggestions.length === 0 || document.activeElement !== this.input) return;

    for (const suggestion of this.suggestions) {
      this.suggestionList.append(
        h(
          'button',
          {
            class: 'suggestion',
            attrs: { type: 'button', role: 'option' },
            onmousedown: (event: MouseEvent) => {
              event.preventDefault();
              this.submit(suggestion.track.title);
            },
          },
          h('span', { class: 'suggestion-title', text: suggestion.track.title }),
          suggestion.track.artist ? h('span', { class: 'suggestion-artist', text: suggestion.track.artist }) : null,
        ),
      );
    }
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'Space' && event.key !== ' ') return;
    if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return;
    if (this.overlay) {
      event.preventDefault();
      void this.toggleTransport();
      return;
    }
    event.preventDefault();
    void this.playExcerpt();
  };

  /** "That file would not play" — said once, then out of the way. */
  private showPlayError(): void {
    this.playError = t.round.audioFailed;
    this.updatePlayState();
    if (this.playStatusTimer !== null) clearTimeout(this.playStatusTimer);
    this.playStatusTimer = window.setTimeout(() => {
      this.playStatusTimer = null;
      this.playError = null;
      this.updatePlayState();
    }, 2800);
  }

  /** A short-lived line under the field, for the server's answers. */
  private showNote(text: string): void {
    this.note.textContent = text;
    this.note.classList.add('is-visible');
    if (this.noteTimer !== null) clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => {
      this.noteTimer = null;
      this.note.classList.remove('is-visible');
    }, 2600);
  }

  /* ── Rendering ────────────────────────────────────────────────────── */

  update(): void {
    const room = multiplayer.room;
    const self = multiplayer.self;
    const round = multiplayer.round;
    if (!room) return;

    const isNewRound = round ? round.number !== this.lastRoundNumber : false;
    if (isNewRound && round) {
      this.lastRoundNumber = round.number;
      this.hideOverlay();
      this.board.close();
      this.input.value = '';
      this.input.disabled = false;
      this.input.placeholder = t.round.searchTitle;
      this.field.classList.remove('is-correct', 'is-wrong');
      this.fieldIcon.replaceChildren(icon('search', 17));
      this.suggestions = [];
      this.renderSuggestions();
      this.preparedKey = null;
      this.preparing = false;
      this.playError = null;
      this.lastRowsSignature = null;
      void this.prepareRound();
      if (HAS_POINTER && room.phase === 'playing') this.input.focus({ preventScroll: true });
    }

    this.codeChip.textContent = room.code;
    this.roundEl.textContent = `${room.roundNumber} / ${room.totalRounds}`;
    this.scoreEl.textContent = points(self?.totalScore ?? 0);

    this.renderStatusStrip(room.players);
    this.renderAttemptRows();
    /*
     * Totals only move when a round resolves, so this is spoiler-free by
     * construction — there is nothing to add up during a round. The board only
     * exists once there is something to rank: before the first resolve, every
     * total is zero and a table of zeros is noise.
     */
    const ranked = room.phase === 'playing' ? room.roundNumber > 1 : room.roundNumber > 0;
    this.board.update(room.players, multiplayer.playerId, ranked);

    const step = self?.step ?? 0;
    if (step !== this.lastStep || isNewRound) {
      this.lastStep = step;
      this.durationValue.textContent = seconds(multiplayer.durations[step] ?? 0);
      this.durationUnit.textContent = t.common.seconds;
      this.durationValue.classList.remove('is-swapping');
      void this.durationValue.offsetWidth;
      this.durationValue.classList.add('is-swapping');
    }
    this.ladderSteps.forEach((element, index) => {
      element.classList.toggle('is-done', index < step);
      element.classList.toggle('is-current', index === step);
    });
    const count = this.ladderSteps.length || 1;
    this.pointer.style.left = `${((step + 0.5) / count) * 100}%`;

    const active = multiplayer.roundActive;
    const atMax = step >= multiplayer.durations.length - 1;
    this.revealButton.hidden = !active || atMax;
    this.revealLabel.textContent = fill(t.mp.listenMoreNext, { seconds: seconds(multiplayer.durations[step + 1] ?? 0) });
    this.giveUpButton.hidden = !active;
    this.input.disabled = !active;
    this.updatePlayState();
    // A finished player hears nothing more until the room resolves.
    if (!active && !this.overlay) audio.stop();

    /* The server's verdict on this player's submissions. */
    const feedback = multiplayer.feedback;
    if (feedback && this.field.dataset.feedback !== String(feedback.at)) {
      this.field.dataset.feedback = String(feedback.at);
      if (feedback.kind === 'wrong') {
        this.field.classList.remove('is-wrong');
        void this.field.offsetWidth;
        this.field.classList.add('is-wrong');
      } else if (feedback.kind === 'correct') {
        this.field.classList.add('is-correct');
        this.fieldIcon.replaceChildren(icon('check', 17));
        this.input.placeholder = t.mp.correctWaiting;
      } else if (feedback.kind === 'spent') {
        const mode = room.settings.attemptMode;
        this.showNote(
          mode === 'single' ? t.mp.spentSingle : mode === 'perReveal' ? t.mp.spentPerReveal : t.mp.spentUnlimited,
        );
      } else if (feedback.kind === 'exhausted') {
        this.input.placeholder =
          room.settings.attemptMode === 'single' ? t.mp.exhaustedSingle : t.mp.exhaustedLast;
      } else if (feedback.kind === 'too-late') {
        this.showNote(t.mp.tooLate);
      }
    }

    /*
     * The reveal, the countdown and the final board are overlays drawn from
     * server messages: `resolved` for the round, `ended` for the game.
     */
    if (multiplayer.resolved) this.showResolved(multiplayer.resolved);
    if (this.overlay) this.refreshOverlayCountdown();
    this.warmNextRound();
  }

  /** Compact "who is where" strip — statuses only, never reveal levels. */
  private renderStatusStrip(players: MpPlayer[]): void {
    const mode = multiplayer.room?.settings.attemptMode ?? 'unlimited';
    const signature = players.map((player) => `${player.id}:${player.status}:${player.connected}`).join('|');
    if (signature === this.statusStrip.dataset.signature) return;
    this.statusStrip.dataset.signature = signature;

    this.statusStrip.replaceChildren(
      ...players.map((player) =>
        h(
          'span',
          { class: `mp-status-item is-${player.status}${player.id === multiplayer.playerId ? ' is-you' : ''}` },
          h('span', { class: 'row-dot' }),
          h('span', { class: 'mp-status-name', text: player.name }),
          h('span', { class: 'mp-status-label' }, statusLabel(player.status, mode)),
        ),
      ),
    );
  }

  /**
   * The attempt rows: what this player did on THIS song, and nothing else.
   *
   *   perReveal — one slot per reveal level, filled as levels are spent
   *   single    — one slot: the one shot
   *   unlimited — the guesses and skips in order, newest at the bottom
   */
  private renderAttemptRows(): void {
    const mode = multiplayer.room?.settings.attemptMode ?? 'unlimited';
    const events = multiplayer.self?.events ?? [];
    const signature = `${mode}#${events.map((event) => `${event.kind}:${event.step}:${event.text ?? ''}:${event.correct ? 1 : 0}`).join('|')}`;
    if (signature === this.lastRowsSignature) return;
    this.lastRowsSignature = signature;

    const slots: (AttemptEvent | null)[] = [];
    if (mode === 'perReveal') {
      for (let step = 0; step < multiplayer.durations.length; step += 1) {
        slots.push(events.find((event) => event.step === step) ?? null);
      }
    } else if (mode === 'single') {
      slots.push(events.find((event) => event.kind === 'guess') ?? null);
    } else {
      slots.push(...events.slice(-MAX_ROWS));
      while (slots.length < MIN_ROWS) slots.push(null);
    }

    this.rowsHost.replaceChildren(...slots.map((event) => attemptRow(event)));
    // A long stack scrolls: the newest attempt is the one that matters.
    this.rowsHost.scrollTop = this.rowsHost.scrollHeight;
  }

  /* ── Overlay: resolved round ──────────────────────────────────────── */

  private showResolved(resolved: MpResolved): void {
    const key = `${resolved.round.number}:${resolved.round.track?.id ?? 'x'}`;
    if (key === this.lastResolvedKey) return;
    this.lastResolvedKey = key;

    this.hideOverlay();

    const room = multiplayer.room;
    const mode = room?.settings.attemptMode ?? 'unlimited';
    const track = resolved.round.track;

    const art = h('div', { class: 'reveal-art' });
    if (track?.hasCover) {
      art.append(
        h('img', {
          attrs: { src: coverUrl(track.id), alt: '', loading: 'eager' },
          onerror: (event: Event) => (event.target as HTMLImageElement).replaceWith(h('div', { class: 'reveal-art-fallback' }, icon('note', 30))),
        }),
      );
    } else {
      art.append(h('div', { class: 'reveal-art-fallback' }, icon('note', 30)));
    }

    const mine = resolved.results.find((result) => result.id === multiplayer.playerId);
    const solved = mine?.status === 'finished';

    const resultsList = h(
      'ol',
      { class: 'mp-results' },
      ...resolved.results.map((result, index) =>
        h(
          'li',
          { class: `mp-result is-${result.status}${result.id === multiplayer.playerId ? ' is-you' : ''}` },
          h('span', { class: 'mp-result-rank', text: String(index + 1) }),
          h('span', { class: 'mp-result-name', text: result.name }),
          h(
            'span',
            { class: 'mp-result-step' },
            result.status === 'finished' || result.status === 'timedout' || result.status === 'exhausted'
              ? `${seconds(multiplayer.durations[result.step ?? 0] ?? 0)} s`
              : statusLabel(result.status, mode),
          ),
          h(
            'span',
            { class: 'mp-result-time' },
            result.status === 'finished' && result.answerSeconds !== null ? `${result.answerSeconds.toFixed(1)} s` : '—',
          ),
          h('span', { class: 'mp-result-points', text: result.points > 0 ? `+${points(result.points)}` : '0' }),
        ),
      ),
    );

    const transport = this.buildTransport(resolved.round.excerptStart, track);
    this.transport = transport;

    const finalRound = resolved.round.number >= (room?.totalRounds ?? 0);
    const readyButton = h(
      'button',
      { class: 'btn btn-primary mp-ready', attrs: { type: 'button' }, onclick: () => multiplayer.ready() },
      h('span', { text: finalRound ? t.mp.seeResults : t.mp.ready }),
    );

    const card = h(
      'div',
      { class: 'reveal-card mp-results-card' },
      h(
        'div',
        { class: 'reveal-kicker' },
        `${fill(t.mp.roundKicker, { round: resolved.round.number })} · ${solved ? t.mp.foundIt : t.mp.answerWas}`,
      ),
      art,
      h('h2', { class: 'reveal-title', text: track?.title ?? '—' }),
      track?.artist ? h('p', { class: 'reveal-artist', text: track.artist }) : null,
      mine && mine.points > 0 ? h('div', { class: 'reveal-points' }, `+${points(mine.points)}`, h('small', { text: t.common.points })) : null,
      resultsList,
      transport.root,
      readyButton,
      h('p', { class: 'mp-countdown' }),
    );

    const overlay = h('div', { class: 'reveal is-results', dataset: { state: solved ? 'hit' : 'miss' } }, card);
    this.overlay = overlay;
    document.body.append(overlay);

    const token = resolved.round.token;
    this.songTimer = window.setTimeout(() => {
      this.songTimer = null;
      void this.startSong(resolved.round.excerptStart, token);
    }, SONG_DELAY);
  }

  private refreshOverlayCountdown(): void {
    if (!this.overlay) return;
    const room = multiplayer.room;
    const resolved = multiplayer.resolved;
    const finalRound = Boolean(resolved && room && resolved.round.number >= room.totalRounds);
    const countdown = this.overlay.querySelector('.mp-countdown');
    if (countdown && room?.nextAt) {
      const left = Math.max(0, Math.ceil((room.nextAt - Date.now()) / 1000));
      countdown.textContent = fill(finalRound ? t.mp.finalResultsIn : t.mp.nextRoundIn, { seconds: left });
    }
    const readyLabel = this.overlay.querySelector('.mp-ready span');
    if (readyLabel && room) {
      const connected = room.players.filter((player) => player.connected);
      const ready = connected.filter((player) => player.ready).length;
      readyLabel.textContent = `${finalRound ? t.mp.seeResults : t.mp.ready} (${fill(t.mp.readyCount, { ready, total: connected.length })})`;
    }
  }

  /* ── Overlay playback ─────────────────────────────────────────────── */

  private buildTransport(startSec: number, track: { id: string; duration: number } | null) {
    const toggle = h(
      'button',
      {
        class: 'transport-toggle',
        attrs: { type: 'button', 'aria-label': t.reveal.pauseAria },
        onclick: () => void this.toggleTransport(),
      },
      icon('pause', 15, 1.9, 'transport-icon'),
    );
    const fillEl = h('span', { class: 'transport-fill' });
    /*
     * The reveal covers the top bar, and it is where the whole song plays — so
     * it carries its own speaker for the same setting rather than making the
     * player dismiss the panel to turn the music down.
     */
    this.revealVolume = new VolumeControl();
    const root = h(
      'div',
      { class: 'reveal-audio', dataset: { state: 'loading' } },
      toggle,
      h(
        'div',
        { class: 'transport-body' },
        h('span', { class: 'transport-label', text: fill(t.reveal.playingFrom, { time: clock(startSec) }) }),
        h('div', { class: 'transport-track' }, fillEl),
      ),
      this.revealVolume.root,
    );
    const total = track?.duration ?? 0;
    if (total > 0) fillEl.style.width = `${Math.min((startSec / total) * 100, 100).toFixed(2)}%`;
    return { root, toggle, fill: fillEl };
  }

  /**
   * The reveal plays from the resolved round's own token — the very resource
   * the round was played from — so it reuses the decoded buffer instead of
   * decoding the same file twice, and cannot pick up another round's audio.
   */
  private async startSong(startSec: number, token: string): Promise<void> {
    const url = multiplayer.audioUrl(token);
    const key = multiplayer.audioKey(token);
    const started = url && key ? await audio.playSongRemote(key, url, startSec) : false;
    if (this.transport) this.setTransportState(started ? 'playing' : 'ended');
  }

  private async toggleTransport(): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    const state = transport.root.dataset.state;
    if (state === 'playing') {
      audio.pause();
      this.setTransportState('paused');
      return;
    }
    if (state === 'paused') {
      this.setTransportState((await audio.resume()) ? 'playing' : 'ended');
      return;
    }
    const resolved = multiplayer.resolved;
    if (state === 'ended' && resolved) {
      await this.startSong(resolved.round.excerptStart, resolved.round.token);
    }
  }

  private setTransportState(state: 'playing' | 'paused' | 'ended'): void {
    const transport = this.transport;
    if (!transport) return;
    transport.root.dataset.state = state;
    transport.toggle.replaceChildren(
      state === 'playing' ? icon('pause', 15, 1.9, 'transport-icon') : icon(state === 'ended' ? 'refresh' : 'play', 15, 1.9, 'transport-icon'),
    );
    if (state === 'playing') this.startTransportTicker();
    else {
      this.stopTransportTicker();
      this.paintTransport();
    }
  }

  private startTransportTicker(): void {
    this.stopTransportTicker();
    const tick = () => {
      if (!this.transport) return;
      this.paintTransport();
      this.transportFrame = requestAnimationFrame(tick);
    };
    this.transportFrame = requestAnimationFrame(tick);
  }

  private stopTransportTicker(): void {
    if (this.transportFrame !== null) {
      cancelAnimationFrame(this.transportFrame);
      this.transportFrame = null;
    }
  }

  private paintTransport(): void {
    const transport = this.transport;
    if (!transport) return;
    const duration = audio.duration || multiplayer.resolved?.round.track?.duration || 0;
    if (duration <= 0) return;
    const ratio = Math.min(Math.max(audio.position / duration, 0), 1);
    transport.fill.style.width = `${(ratio * 100).toFixed(2)}%`;
  }

  private hideOverlay(): void {
    if (this.songTimer !== null) {
      clearTimeout(this.songTimer);
      this.songTimer = null;
    }
    this.stopTransportTicker();
    audio.stop();
    // A fresh panel builds a fresh control, so this one's document listeners
    // and subscription go with it.
    this.revealVolume?.dispose();
    this.revealVolume = null;
    this.overlay?.remove();
    this.overlay = null;
    this.transport = null;
  }

  /* ── Clock ────────────────────────────────────────────────────────── */

  private startTicker(): void {
    const tick = () => {
      const room = multiplayer.room;
      const self = multiplayer.self;
      if (room?.phase === 'playing' && self?.endsAt) {
        const left = Math.max(0, Math.ceil((self.endsAt - Date.now()) / 1000));
        this.timerEl.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        this.timerEl.classList.toggle('is-hurry', left <= 10);
      } else {
        this.timerEl.textContent = '—';
        this.timerEl.classList.remove('is-hurry');
      }
      this.ticker = requestAnimationFrame(tick);
    };
    this.ticker = requestAnimationFrame(tick);
  }

  private stopTicker(): void {
    if (this.ticker !== null) {
      cancelAnimationFrame(this.ticker);
      this.ticker = null;
    }
  }
}

/* ── Final results ──────────────────────────────────────────────────── */

export class MultiplayerResults {
  readonly root: HTMLElement;

  constructor() {
    this.root = h('div', { class: 'screen results mp-final' });
    this.update();
  }

  update(): void {
    const standings = multiplayer.standings ?? [];
    const room = multiplayer.room;
    const isHost = multiplayer.isHost;
    const winner = standings[0];

    const rules = room ? rulesLine(room.settings.rounds, room.settings.attemptMode, room.settings.roundSeconds) : null;
    rules?.classList.add('mp-final-rules');

    this.root.replaceChildren(
      h(
        'div',
        { class: 'shell results-inner' },
        h('p', { class: 'results-title', text: t.mp.gameOver }),
        winner ? h('p', { class: 'mp-winner', text: fill(t.mp.wins, { name: winner.name }) }) : null,
        rules,
        h(
          'ol',
          { class: 'mp-standings' },
          ...standings.map((standing: MpStanding, index) =>
            h(
              'li',
              { class: `mp-standing${index === 0 ? ' is-first' : ''}${standing.id === multiplayer.playerId ? ' is-you' : ''}` },
              h('span', { class: 'mp-result-rank', text: String(index + 1) }),
              h('span', { class: 'mp-result-name', text: standing.name }),
              h(
                'span',
                { class: 'mp-result-correct' },
                fill(n(standing.correct, t.mp.hitsOne, t.mp.hitsMany), { count: standing.correct }),
              ),
              h('span', { class: 'mp-result-points', text: points(standing.score) }),
            ),
          ),
        ),
        h(
          'div',
          { class: 'results-actions' },
          isHost
            ? h(
                'button',
                { class: 'btn btn-primary', attrs: { type: 'button' }, onclick: () => multiplayer.backToLobby() },
                h('span', { text: t.mp.backToLobby }),
              )
            : null,
          h(
            'button',
            { class: 'btn btn-ghost', attrs: { type: 'button' }, onclick: () => multiplayer.leave() },
            h('span', { text: t.mp.leaveTitle }),
          ),
        ),
      ),
    );
  }
}

/* ── Bits ───────────────────────────────────────────────────────────── */

/** One attempt row: a guess, a skip, or an empty slot waiting to be used. */
function attemptRow(event: AttemptEvent | null): HTMLElement {
  if (!event) return h('li', { class: 'row is-empty' });

  if (event.kind === 'skip') {
    return h(
      'li',
      { class: 'row is-skipped' },
      h('span', { class: 'row-icon' }, icon('arrow', 13, 2.4)),
      h('span', { class: 'row-text', text: t.round.rowListenMore }),
    );
  }

  const correct = Boolean(event.correct);
  return h(
    'li',
    { class: `row ${correct ? 'is-correct' : 'is-wrong'}` },
    h('span', { class: 'row-icon' }, icon(correct ? 'check' : 'close', 13, 2.4)),
    h('span', { class: 'row-text', text: event.text ?? '' }),
  );
}

function clock(value: number): string {
  const total = Math.max(0, Math.floor(value));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Copy text, falling back to the old selection trick on insecure origins. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
