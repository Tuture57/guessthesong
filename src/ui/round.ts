/**
 * The round screen.
 *
 * Built once and then patched in place: re-creating the DOM on every state
 * change would steal focus from the answer field and kill the transitions that
 * make the reveal ladder feel responsive.
 *
 * Layout follows the game's visual language: the stacked attempt/history rows
 * carry the middle of the screen, the timeline shows where the excerpt stands
 * with a pointer, the green play button sits under it, and the answer field
 * with Give Up lives at the bottom.
 */
import { audio, coverUrl } from '../core/audio';
import type { PlaybackKind } from '../core/audio';
import { scoreRound } from '../core/scoring';
import { gameConfig, type AttemptEvent, type Round } from '../core/types';
import type { Game } from '../core/game';
import type { Library } from '../core/library';
import type { Suggestion } from '../core/matching';
import { fill, points, seconds, t } from '../i18n';
import { flameIcon, formatClock, h, icon } from './dom';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_RADIUS = 46;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const HAS_POINTER = window.matchMedia?.('(hover: hover)').matches ?? true;

/** Attempt rows on screen at once; older ones scroll away rather than push. */
const MAX_ROWS = 6;
const MIN_ROWS = 6;

/**
 * How long to let the reveal land before the song starts. A correct answer
 * gets a beat longer so the green field registers first.
 */
const SONG_DELAY_SOLVED = 320;
const SONG_DELAY_MISSED = 180;

type TransportState = 'playing' | 'paused' | 'ended';

interface Transport {
  root: HTMLElement;
  toggle: HTMLButtonElement;
  hint: HTMLElement;
  fill: HTMLElement;
}

export class RoundView {
  readonly root: HTMLElement;

  private game: Game;
  private library: Library;

  private hudRound!: HTMLElement;
  private hudScore!: HTMLElement;
  private hudStreak!: HTMLElement;
  private tabRow!: HTMLElement;
  private durationValue!: HTMLElement;
  private durationUnit!: HTMLElement;
  private durationLabel!: HTMLElement;
  private ladderSteps: HTMLElement[] = [];
  private ladderTrack!: HTMLElement;
  private pointer!: HTMLElement;
  private playButton!: HTMLButtonElement;
  private playStatus!: HTMLElement;
  private playWrap!: HTMLElement;
  private playStatusTimer: number | null = null;
  private ringProgress!: SVGCircleElement;
  private field!: HTMLElement;
  private fieldIcon!: SVGSVGElement;
  private input!: HTMLInputElement;
  private suggestionList!: HTMLElement;
  private skipButton!: HTMLButtonElement;
  private skipLabel!: HTMLElement;
  private skipChip!: HTMLElement;
  private rowsHost!: HTMLElement;
  private tabs: HTMLElement[] = [];

  private suggestions: Suggestion[] = [];
  private activeIndex = 0;
  /** True once the player picked a suggestion with the arrow keys. */
  private chooseExplicitly = false;
  private overlay: HTMLElement | null = null;
  private transport: Transport | null = null;
  private ringFrame: number | null = null;
  private ringResetTimer: number | null = null;
  private songTimer: number | null = null;
  private transportFrame: number | null = null;

  private lastTrackId: string | null = null;
  private lastStep = -1;
  /** null forces the next render: an empty stack must still be redrawn. */
  private rowsSignature: string | null = null;
  private lastScoreFlash = 0;

  constructor(game: Game, library: Library) {
    this.game = game;
    this.library = library;
    this.root = h('div', { class: 'screen round' });
    this.build();

    audio.onEnded = (kind) => this.onPlaybackEnded(kind);
    window.addEventListener('keydown', this.onKeyDown);
  }

  dispose(): void {
    this.hideReveal();
    audio.onEnded = null;
    this.stopRing();
    if (this.playStatusTimer !== null) {
      clearTimeout(this.playStatusTimer);
      this.playStatusTimer = null;
    }
    window.removeEventListener('keydown', this.onKeyDown);
  }

  /* ── Construction ─────────────────────────────────────────────────── */

  private build(): void {
    const shell = h('div', { class: 'shell' });

    /* HUD — kept slim; the reference has no dashboard. */
    const hudRoundValue = h('span', { class: 'hud-value mono' });
    this.hudRound = hudRoundValue;
    this.hudScore = h('span', { class: 'hud-value mono', text: '0' });
    this.hudStreak = h('span', { class: 'hud-value mono', text: '0' });

    const hud = h(
      'div',
      { class: 'hud' },
      h('div', { class: 'hud-item' }, h('span', { class: 'hud-label', text: t.round.hudRound }), hudRoundValue),
      h('div', { class: 'hud-sep' }),
      h('div', { class: 'hud-item' }, h('span', { class: 'hud-label', text: t.round.hudScore }), this.hudScore),
      h('div', { class: 'hud-sep' }),
      h('div', { class: 'hud-item' }, h('span', { class: 'hud-label', text: t.round.hudStreak }), this.hudStreak),
    );

    /* Category tabs — switch which folder the next songs come from. */
    this.tabRow = h('nav', { class: 'cat-tabs', attrs: { 'aria-label': 'Music category' } });

    /* Stacked attempt / history rows — the main area. */
    this.rowsHost = h('ol', { class: 'rows' });

    /* Timeline: the reveal ladder with a pointer on the current step. */
    this.durationValue = h('span', { class: 'duration-value', text: '0,1' });
    this.durationUnit = h('span', { class: 'duration-unit', text: t.common.seconds });
    this.durationLabel = h('div', { class: 'duration-hero' }, this.durationValue, this.durationUnit);

    this.ladderSteps = this.game.durations.map((duration, index) =>
      h(
        'li',
        { class: 'ladder-step', dataset: { step: String(index) } },
        h('span', { class: 'ladder-bar' }),
        h('span', { class: 'ladder-label', text: `${seconds(duration)} s` }),
      ),
    );
    this.pointer = h('span', { class: 'ladder-pointer' });
    this.ladderTrack = h('div', { class: 'ladder-track' }, h('ol', { class: 'ladder' }, ...this.ladderSteps), this.pointer);
    this.ladderTrack.style.setProperty('--steps', String(this.game.durations.length));
    const timeline = h('div', { class: 'timeline' }, this.durationLabel, this.ladderTrack);

    /* Play */
    const ring = this.buildRing();
    this.playButton = h(
      'button',
      {
        class: 'play',
        attrs: { type: 'button', 'aria-label': t.round.playAria },
        onclick: () => void this.playExcerpt(),
      },
      ring,
      icon('play', 30, 1.9, 'play-icon'),
      h('span', { class: 'play-spinner' }),
    );
    this.playStatus = h('span', { class: 'play-status', attrs: { hidden: true } });
    this.playWrap = h(
      'div',
      { class: 'play-wrap' },
      this.playButton,
      this.playStatus,
      h('span', { class: 'play-hint', text: t.round.spaceHint }),
    );

    /* Answer field */
    this.fieldIcon = icon('search', 17, 1.9, 'field-icon');
    this.input = h('input', {
      class: 'field-input',
      attrs: {
        type: 'text',
        placeholder: this.placeholder(),
        autocomplete: 'off',
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
        'aria-label': t.round.answerAria,
      },
      oninput: () => this.onInput(),
      onkeydown: (event: KeyboardEvent) => this.onFieldKeyDown(event),
      onfocus: () => this.onInput(),
    });
    this.suggestionList = h('div', { class: 'suggestions', attrs: { role: 'listbox' } });
    this.field = h(
      'form',
      { class: 'field', onsubmit: (event: Event) => { event.preventDefault(); this.submit(); } },
      this.fieldIcon,
      this.input,
      this.suggestionList,
    );

    this.skipLabel = h('span', { text: t.round.listenMore });
    this.skipChip = h('span', { class: 'skip-next' });
    this.skipButton = h(
      'button',
      { class: 'skip', attrs: { type: 'button' }, onclick: () => this.game.revealMore() },
      this.skipLabel,
      this.skipChip,
    );
    const answer = h('div', { class: 'answer' }, this.field, this.skipButton);

    const stage = h('div', { class: 'stage' }, this.tabRow, this.rowsHost, timeline, this.playWrap, answer);
    shell.append(hud, stage);
    this.root.append(shell);
  }

  private placeholder(): string {
    return this.game.requiresArtist ? t.round.searchTitleOrArtist : t.round.searchTitle;
  }

  private buildRing(): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'play-ring');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('aria-hidden', 'true');

    const track = document.createElementNS(SVG_NS, 'circle');
    track.setAttribute('class', 'ring-track');
    track.setAttribute('cx', '50');
    track.setAttribute('cy', '50');
    track.setAttribute('r', String(RING_RADIUS));

    this.ringProgress = document.createElementNS(SVG_NS, 'circle');
    this.ringProgress.setAttribute('class', 'ring-progress');
    this.ringProgress.setAttribute('cx', '50');
    this.ringProgress.setAttribute('cy', '50');
    this.ringProgress.setAttribute('r', String(RING_RADIUS));
    this.ringProgress.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
    this.ringProgress.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));

    svg.append(track, this.ringProgress);
    return svg;
  }

  /* ── Playback ─────────────────────────────────────────────────────── */

  async playExcerpt(): Promise<void> {
    const round = this.game.round;
    if (!round) return;

    const wasReady = audio.isReady(round.track.id);
    this.stopRing();
    void audio.unlock();

    if (!wasReady) this.playButton.classList.add('is-loading');

    const started = await audio.play(round.track.id, round.startSec, this.game.excerptLengthSeconds());
    this.playButton.classList.remove('is-loading');
    if (!started) {
      // Silence with no explanation looks like a broken button; say why.
      this.showPlayStatus(t.round.audioFailed, true);
      return;
    }

    this.playButton.classList.add('is-playing');
    this.ringProgress.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));
    this.startRing();
  }

  private startRing(): void {
    const tick = () => {
      if (!audio.isPlaying) {
        this.finishRing();
        return;
      }
      const progress = audio.getProgress();
      this.ringProgress.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE * (1 - progress)));
      this.ringFrame = requestAnimationFrame(tick);
    };
    this.ringFrame = requestAnimationFrame(tick);
  }

  private onPlaybackEnded(kind: PlaybackKind): void {
    if (kind === 'excerpt') this.finishRing();
    else this.setTransportState('ended');
  }

  /** A line under PLAY that says what just happened, then goes away. */
  private showPlayStatus(text: string, isError = false): void {
    this.playStatus.textContent = text;
    this.playStatus.classList.toggle('is-error', isError);
    this.playStatus.hidden = false;
    if (this.playStatusTimer !== null) clearTimeout(this.playStatusTimer);
    this.playStatusTimer = window.setTimeout(() => {
      this.playStatusTimer = null;
      this.playStatus.hidden = true;
      this.playStatus.classList.remove('is-error');
    }, 2800);
  }

  /** Hold the completed ring for a beat, then rewind it for the next play. */
  private finishRing(): void {
    this.stopRing();
    this.playButton.classList.remove('is-playing');
    this.ringProgress.setAttribute('stroke-dashoffset', '0');
    this.ringResetTimer = window.setTimeout(() => {
      this.ringResetTimer = null;
      this.ringProgress.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));
    }, 380);
  }

  private stopRing(): void {
    if (this.ringFrame !== null) {
      cancelAnimationFrame(this.ringFrame);
      this.ringFrame = null;
    }
    if (this.ringResetTimer !== null) {
      clearTimeout(this.ringResetTimer);
      this.ringResetTimer = null;
    }
  }

  /* ── Answering ────────────────────────────────────────────────────── */

  private onInput(): void {
    const query = this.input.value;
    this.chooseExplicitly = false;
    this.suggestions = this.library.search(query);
    this.activeIndex = 0;
    this.renderSuggestions();
  }

  /**
   * What the player actually meant. If they were mid-way through typing a
   * title that the library recognises, take the suggestion; otherwise take
   * them at their word and let the matcher decide.
   */
  private resolveSubmission(): string {
    const typed = this.input.value.trim();
    if (!typed) return '';

    const active = this.suggestions[this.activeIndex];
    if (!active) return typed;
    if (this.chooseExplicitly) return active.track.title;

    const typedKey = this.library.normalize(typed);
    const titleKey = this.library.normalize(active.track.title);
    if (typedKey && titleKey.startsWith(typedKey)) return active.track.title;
    return typed;
  }

  /**
   * @param explicit a title the player picked outright (clicking a
   *   suggestion), which skips the prefix heuristic below.
   */
  private submit(explicit?: string): void {
    if (this.game.phase === 'revealed') return;

    const text = explicit ?? this.resolveSubmission();
    if (!text.trim()) return;

    const outcome = this.game.guess(text);

    if (outcome === 'correct') {
      this.input.value = this.game.round?.track.title ?? '';
      this.field.classList.add('is-correct');
      this.fieldIcon.replaceChildren(icon('check', 17));
      this.input.disabled = true;
      this.closeSuggestions();
      return;
    }

    if (outcome === 'wrong') {
      this.flashWrong();
      this.input.value = '';
      this.closeSuggestions();
    }
  }

  private flashWrong(): void {
    this.field.classList.remove('is-wrong');
    void this.field.offsetWidth; // restart the animation
    this.field.classList.add('is-wrong');
  }

  private onFieldKeyDown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (this.suggestions.length === 0) return;
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      this.activeIndex = (this.activeIndex + delta + this.suggestions.length) % this.suggestions.length;
      this.chooseExplicitly = true;
      this.renderSuggestions();
      return;
    }
    if (event.key === 'Escape') {
      this.suggestions = [];
      this.renderSuggestions();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      this.submit();
    }
  }

  private renderSuggestions(): void {
    this.suggestionList.replaceChildren();

    if (this.suggestions.length === 0 || document.activeElement !== this.input) return;

    this.suggestions.forEach((suggestion, index) => {
      const button = h(
        'button',
        {
          class: `suggestion${index === this.activeIndex ? ' is-active' : ''}`,
          attrs: { type: 'button', role: 'option', 'aria-selected': index === this.activeIndex },
          onmousedown: (event: MouseEvent) => {
            // mousedown, not click: the field must not blur first.
            event.preventDefault();
            this.input.value = suggestion.track.title;
            this.submit(suggestion.track.title);
          },
        },
        h('span', { class: 'suggestion-title', text: suggestion.track.title }),
        suggestion.track.artist ? h('span', { class: 'suggestion-artist', text: suggestion.track.artist }) : null,
      );
      this.suggestionList.append(button);
    });
  }

  private closeSuggestions(): void {
    this.suggestions = [];
    this.suggestionList.replaceChildren();
  }

  /* ── Keyboard ─────────────────────────────────────────────────────── */

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'Space' && event.key !== ' ') return;
    if (isTypingTarget(event.target)) return;

    // During the reveal SPACE keeps meaning "the audio" — it pauses or resumes
    // the song rather than activating the focused Next button.
    if (this.overlay) {
      if (!this.transport) return;
      event.preventDefault();
      void this.toggleTransport();
      return;
    }

    if (!gameConfig.ui.spaceToPlay) return;
    event.preventDefault();
    void this.playExcerpt();
  };

  /* ── Rendering ────────────────────────────────────────────────────── */

  update(): void {
    const game = this.game;
    const round = game.round;
    if (!round) {
      this.root.replaceChildren();
      return;
    }

    const isNewTrack = round.track.id !== this.lastTrackId;
    const stepChanged = round.step !== this.lastStep;

    if (isNewTrack) {
      this.hideReveal();
      this.lastTrackId = round.track.id;
      this.rowsSignature = null;
      this.input.value = '';
      this.input.disabled = false;
      this.input.placeholder = this.placeholder();
      this.field.classList.remove('is-correct', 'is-wrong');
      this.fieldIcon.replaceChildren(icon('search', 17));
      this.closeSuggestions();
      // Only pull focus on pointer devices — on a phone that would throw the
      // keyboard up before the player has heard anything.
      if (HAS_POINTER) this.input.focus({ preventScroll: true });
    }

    /* HUD */
    const total = game.totalRounds;
    this.hudRound.replaceChildren(document.createTextNode(String(game.roundNumber)));
    if (Number.isFinite(total)) this.hudRound.append(h('i', { text: ` / ${total}` }));
    this.hudScore.textContent = points(game.score);
    this.hudStreak.textContent = String(game.streak);
    this.hudStreak.classList.toggle('is-hot', game.streak >= 2);

    if (game.scoreFlash !== this.lastScoreFlash) {
      this.lastScoreFlash = game.scoreFlash;
      this.hudScore.classList.remove('is-flashing');
      void this.hudScore.offsetWidth;
      this.hudScore.classList.add('is-flashing');
    }

    /* Category tabs */
    this.renderTabs();

    /* Stacked rows: what this player did on THIS song, nothing else. */
    this.renderRows();

    /* Excerpt duration + timeline */
    if (stepChanged || isNewTrack) {
      this.durationValue.textContent = seconds(game.currentDuration);
      this.durationUnit.textContent = game.currentDuration === 1 ? t.common.second : t.common.seconds;
      this.durationLabel.classList.remove('is-swapping');
      void this.durationLabel.offsetWidth;
      this.durationLabel.classList.add('is-swapping');
    }

    this.ladderSteps.forEach((step, index) => {
      step.classList.toggle('is-done', index < round.step);
      step.classList.toggle('is-current', index === round.step);
    });
    this.movePointer(round.step);

    /*
     * The last step hands the answer over, so that one really is giving up —
     * every step before it only lengthens the excerpt, and says so.
     */
    const next = game.nextDuration;
    if (next === null) {
      this.skipLabel.textContent = t.round.giveUp;
      this.skipChip.textContent = '';
      this.skipButton.classList.add('is-final');
      this.skipButton.setAttribute('aria-label', t.round.giveUpAria);
    } else {
      this.skipLabel.textContent = t.round.listenMore;
      this.skipChip.textContent = `+${seconds(next)} s`;
      this.skipButton.classList.remove('is-final');
      this.skipButton.setAttribute('aria-label', fill(t.round.listenMoreAria, { seconds: seconds(next) }));
    }

    /* Reveal */
    if (game.phase === 'revealed' && !this.overlay) {
      this.input.disabled = true;
      this.showReveal();
    }

    this.lastStep = round.step;
  }

  private renderTabs(): void {
    const categories = this.library.categories;
    if (this.tabs.length !== categories.length) {
      this.tabs = categories.map((category) =>
        h('button', {
          class: 'cat-tab',
          text: category.name,
          attrs: { type: 'button', 'data-category': category.value },
          onclick: () => {
            this.game.setCategory(category.value);
            this.update();
          },
        }),
      );
      this.tabRow.replaceChildren(...this.tabs);
    }
    this.tabs.forEach((tab) => tab.classList.toggle('is-active', tab.dataset.category === (this.game.category || 'all')));
  }

  /**
   * The attempt rows.
   *
   * Each submitted guess occupies one row, newest at the bottom; a skip shows
   * as a neutral "Skipped" slot. Empty rows wait below. Nothing here survives
   * the song — when the next round starts the stack is empty again.
   */
  private renderRows(): void {
    const round = this.game.round;
    if (!round) return;

    const events = round.events;
    const signature = events.map((event) => `${event.kind}:${event.step}:${event.text ?? ''}:${event.correct ? 1 : 0}`).join('|');
    if (signature === this.rowsSignature) return;
    this.rowsSignature = signature;

    const slots: (AttemptEvent | null)[] = events.slice(-MAX_ROWS);
    while (slots.length < MIN_ROWS) slots.push(null);

    this.rowsHost.replaceChildren(...slots.map((event) => attemptRow(event)));
    // A long stack scrolls: the newest attempt is the one that matters.
    this.rowsHost.scrollTop = this.rowsHost.scrollHeight;
  }

  /** The pointer slides under the active step — the "you are here" marker. */
  private movePointer(step: number): void {
    const count = this.ladderSteps.length || 1;
    const center = ((step + 0.5) / count) * 100;
    this.pointer.style.left = `${center}%`;
    this.pointer.dataset.step = String(step);
  }

  /* ── Reveal panel ─────────────────────────────────────────────────── */

  private showReveal(): void {
    const round = this.game.round;
    if (!round) return;

    const solved = round.solved;
    const breakdown = this.game.breakdown ?? scoreRound(round.step, round.attempts.length, 0);
    const award = solved ? breakdown.total : 0;

    const art = h('div', { class: 'reveal-art' });
    if (round.track.hasCover) {
      art.append(
        h('img', {
          attrs: { src: coverUrl(round.track.id), alt: '', loading: 'eager' },
          onerror: (event: Event) => {
            (event.target as HTMLImageElement).replaceWith(
              h('div', { class: 'reveal-art-fallback' }, icon('note', 30)),
            );
          },
        }),
      );
    } else {
      art.append(h('div', { class: 'reveal-art-fallback' }, icon('note', 30)));
    }

    const shown = seconds(this.game.durations[round.step] ?? 0);
    const meta = h('div', { class: 'reveal-meta' });
    meta.append(
      h('span', { text: fill(solved ? t.reveal.foundAt : t.reveal.ranOutAt, { seconds: shown }) }),
    );
    if (solved && round.answerSeconds !== null) {
      meta.append(h('span', { class: 'dot' }), h('span', { text: `${seconds(round.answerSeconds)} s` }));
    }
    if (round.attempts.length > 0) {
      meta.append(
        h('span', { class: 'dot' }),
        h('span', {
          text: fill(
            round.attempts.length === 1 ? t.reveal.wrongOne : t.reveal.wrongMany,
            { count: round.attempts.length },
          ),
        }),
      );
    }
    // Streak bonuses change the payout, so say so rather than let the number
    // look arbitrary.
    const bonus = solved ? (this.game.breakdown?.streakBonus ?? 0) : 0;
    if (bonus > 0) {
      const streak = h('span', { class: 'reveal-streak' }, flameIcon(13));
      streak.append(
        h('span', {
          text: fill(t.reveal.streakBonus, { streak: this.game.streak, percent: Math.round(bonus * 100) }),
        }),
      );
      meta.append(h('span', { class: 'dot' }), streak);
    }

    const isLastRound = this.game.mode === 'rounds' && this.game.history.length >= this.game.roundsPerGame;
    const nextButton = h(
      'button',
      {
        class: 'btn btn-primary reveal-next',
        attrs: { type: 'button' },
        text: isLastRound ? t.reveal.seeResults : t.reveal.nextSong,
        onclick: () => this.game.next(),
      },
      icon('arrow', 17),
    );

    const transport = this.buildTransport(round);
    this.transport = transport;

    const card = h(
      'div',
      { class: 'reveal-card' },
      art,
      h('div', { class: 'reveal-kicker', text: solved ? t.reveal.correct : t.reveal.answerWas }),
      h('h2', { class: 'reveal-title', text: round.track.title }),
      round.track.artist ? h('p', { class: 'reveal-artist', text: round.track.artist }) : null,
      h(
        'div',
        { class: `reveal-points${award > 0 ? '' : ' is-zero'}` },
        `+${points(award)}`,
        h('small', { text: t.common.points }),
      ),
      meta,
      transport.root,
      nextButton,
      transport.hint,
    );

    // No backdrop-to-dismiss: the song is playing now, and a stray click
    // should not cut it off. "Next song" and ENTER are the way forward.
    const overlay = h(
      'div',
      { class: `reveal${solved ? ' is-success' : ''}`, dataset: { state: solved ? 'hit' : 'miss' } },
      card,
    );

    this.overlay = overlay;
    document.body.append(overlay);
    nextButton.focus({ preventScroll: true });

    // Let the panel land first, then start the song from the round's frozen
    // excerpt position so the player hears where the excerpt came from.
    this.songTimer = window.setTimeout(
      () => {
        this.songTimer = null;
        void this.startSong();
      },
      solved ? SONG_DELAY_SOLVED : SONG_DELAY_MISSED,
    );
  }

  /* ── Reveal playback ──────────────────────────────────────────────── */

  private buildTransport(round: Round): Transport {
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
    const root = h(
      'div',
      { class: 'reveal-audio', dataset: { state: 'loading' } },
      toggle,
      h(
        'div',
        { class: 'transport-body' },
        h('span', { class: 'transport-label', text: fill(t.reveal.playingFrom, { time: formatClock(round.startSec) }) }),
        h('div', { class: 'transport-track' }, fillEl),
      ),
    );

    // Paint the opening position straight away so the bar never jumps.
    const total = round.track.duration || audio.duration;
    if (total > 0) fillEl.style.width = `${Math.min((round.startSec / total) * 100, 100).toFixed(2)}%`;

    const hint = h('p', { class: 'reveal-hint', text: t.reveal.hintPlaying });
    return { root, toggle, hint, fill: fillEl };
  }

  /** Start the song from the position this round's excerpt was taken from. */
  private async startSong(): Promise<void> {
    const round = this.game.round;
    const transport = this.transport;
    if (!round || !transport) return;

    const started = await audio.playSong(round.track.id, round.startSec);
    // The reveal may have been closed while the track was loading.
    if (this.transport !== transport) return;
    if (!started) {
      // Unreadable file: drop the whole control rather than leave a dead one.
      transport.root.hidden = true;
      transport.hint.hidden = true;
      return;
    }
    this.setTransportState('playing');
  }

  private async toggleTransport(): Promise<void> {
    const transport = this.transport;
    if (!transport) return;

    const state = transport.root.dataset.state as TransportState;
    // Still loading: the scheduled start is about to run, so leave it alone.
    if (state !== 'playing' && state !== 'paused' && state !== 'ended') return;

    if (state === 'playing') {
      audio.pause();
      this.setTransportState('paused');
      return;
    }

    transport.toggle.disabled = true;
    const resumed = state === 'paused' ? await audio.resume() : await this.restartSong();
    transport.toggle.disabled = false;
    this.setTransportState(resumed ? 'playing' : 'ended');
  }

  private async restartSong(): Promise<boolean> {
    const round = this.game.round;
    if (!round) return false;
    return audio.playSong(round.track.id, round.startSec);
  }

  private setTransportState(state: TransportState): void {
    const transport = this.transport;
    if (!transport) return;

    transport.root.dataset.state = state;
    transport.toggle.replaceChildren(
      state === 'playing'
        ? icon('pause', 15, 1.9, 'transport-icon')
        : icon(state === 'ended' ? 'refresh' : 'play', 15, 1.9, 'transport-icon'),
    );
    transport.toggle.setAttribute('aria-label', state === 'playing' ? t.reveal.pauseAria : t.reveal.playAria);
    transport.hint.textContent =
      state === 'playing' ? t.reveal.hintPlaying : state === 'paused' ? t.reveal.hintPaused : t.reveal.hintEnded;

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
    const duration = audio.duration || this.game.round?.track.duration || 0;
    if (duration <= 0) return;
    const ratio = Math.min(Math.max(audio.position / duration, 0), 1);
    transport.fill.style.width = `${(ratio * 100).toFixed(2)}%`;
  }

  private hideReveal(): void {
    if (this.songTimer !== null) {
      clearTimeout(this.songTimer);
      this.songTimer = null;
    }
    this.stopTransportTicker();
    // Leaving the reveal always silences the song, however we got here.
    audio.stop();
    this.overlay?.remove();
    this.overlay = null;
    this.transport = null;
  }
}

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

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
}
