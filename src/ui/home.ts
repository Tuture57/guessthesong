/**
 * Start screen: the big title, the real category tabs, and the two ways in —
 * singleplayer and multiplayer. Singleplayer keeps its Quick Play / Rounds
 * settings; multiplayer opens its own menu.
 */
import { multiplayer } from '../core/multiplayer';
import { gameConfig } from '../core/types';
import type { Game } from '../core/game';
import type { Library } from '../core/library';
import { fill, n, points, t } from '../i18n';
import { h, icon } from './dom';

const ROUND_CHOICES = [5, 10, 15, 20];

export class HomeView {
  readonly root: HTMLElement;

  private game: Game;
  private library: Library;
  private tabRow!: HTMLElement;
  private segmented!: HTMLElement;
  private modeButtons: HTMLButtonElement[] = [];
  private countsRow!: HTMLElement;
  private startButton!: HTMLButtonElement;
  private foot!: HTMLElement;
  private noticeHost!: HTMLElement;
  private playArea!: HTMLElement;
  private tabs: HTMLElement[] = [];

  constructor(game: Game, library: Library) {
    this.game = game;
    this.library = library;
    this.root = h('div', { class: 'screen home' });
    this.build();
    this.update();
  }

  private build(): void {
    const shell = h('div', { class: 'shell' });
    const main = h('div', { class: 'home-main' });

    /* Category tabs — real folders from the library, never invented ones. */
    this.tabRow = h('nav', { class: 'cat-tabs', attrs: { 'aria-label': 'Music category' } });

    /* Mode picker: where the run comes from. */
    const modeCards: Array<{ mode: 'single' | 'multi'; label: string; hint: string }> = [
      { mode: 'single', label: t.home.modeSoloLabel, hint: t.home.modeSoloHint },
      { mode: 'multi', label: t.home.modeMultiLabel, hint: t.home.modeMultiHint },
    ];
    this.modeButtons = modeCards.map(({ mode, label, hint }) =>
      h(
        'button',
        {
          class: `mode-card${mode === 'single' ? ' is-active' : ''}`,
          attrs: { type: 'button', 'data-mode': mode },
          onclick: () => {
            if (mode === 'multi') multiplayer.openMenu();
            else this.game.setMode(this.game.mode);
          },
        },
        h('span', { class: 'mode-card-label', text: label }),
        h('span', { class: 'mode-card-hint', text: hint }),
      ),
    );

    /* Quick Play / Rounds */
    const thumb = h('span', { class: 'segmented-thumb' });
    this.segmented = h('div', { class: 'segmented', attrs: { role: 'tablist', 'aria-label': 'Game mode' } }, thumb);

    const modes: Array<{ mode: 'quick' | 'rounds'; label: string }> = [
      { mode: 'quick', label: t.home.quickPlay },
      { mode: 'rounds', label: t.home.rounds },
    ];
    const modeButtons = modes.map(({ mode, label }) =>
      h('button', {
        class: '',
        text: label,
        attrs: { type: 'button', role: 'tab', 'data-mode': mode },
        onclick: () => {
          this.game.setMode(mode);
          this.update();
        },
      }),
    );
    this.segmented.append(...modeButtons);
    this.segmented.style.setProperty('--seg-count', String(modes.length));

    /* Rounds per game */
    this.countsRow = h('div', { class: 'round-counts', attrs: { 'aria-label': 'Number of rounds' } });
    for (const count of ROUND_CHOICES) {
      this.countsRow.append(
        h('button', {
          text: String(count),
          attrs: { type: 'button', 'aria-pressed': 'false' },
          onclick: () => {
            this.game.setRoundsPerGame(count);
            this.update();
          },
        }),
      );
    }

    this.startButton = h('button', {
      class: 'btn btn-primary home-start',
      attrs: { type: 'button' },
      onclick: () => this.game.start(this.game.mode, this.game.roundsPerGame),
    });

    this.noticeHost = h('div', { class: 'home-main' });
    this.foot = h('div', { class: 'home-foot' });

    this.playArea = h('div', { class: 'home-main home-play' }, this.segmented, this.countsRow, this.startButton);

    main.append(
      h('h1', { class: 'home-title', text: t.brand.name }),
      h(
        'p',
        { class: 'home-tagline' },
        t.home.taglineBefore,
        h('b', { text: t.home.taglineStrong }),
        t.home.taglineAfter,
      ),
      this.tabRow,
      h('div', { class: 'mode-picker' }, ...this.modeButtons),
      this.playArea,
      this.foot,
    );

    shell.append(main, this.noticeHost);
    this.root.append(shell);
  }

  update(): void {
    const { game, library } = this;

    const hasMusic = library.size > 0;
    this.playArea.hidden = !hasMusic;
    this.foot.hidden = !hasMusic;

    this.renderNotice();
    this.renderTabs();

    /* Mode segment */
    const index = game.mode === 'quick' ? 0 : 1;
    this.segmented.style.setProperty('--seg-index', String(index));
    this.segmented.querySelectorAll('button').forEach((button) => {
      button.setAttribute('aria-selected', String(button.dataset.mode === game.mode));
    });

    /* Rounds chips */
    this.countsRow.hidden = game.mode !== 'rounds';
    for (const button of Array.from(this.countsRow.children) as HTMLButtonElement[]) {
      button.setAttribute('aria-pressed', String(Number(button.textContent) === game.roundsPerGame));
    }

    /* Start label */
    const label = game.mode === 'quick' ? t.home.startQuick : fill(t.home.startRounds, { count: game.roundsPerGame });
    this.startButton.replaceChildren(h('span', { text: label }), icon('arrow', 18));

    this.renderFoot();
  }

  /** One tab per real category, plus All. Dead tabs are never rendered. */
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
    this.tabs.forEach((tab) => {
      tab.classList.toggle('is-active', tab.dataset.category === (this.game.category || 'all'));
    });
  }

  private renderFoot(): void {
    const parts: Node[] = [
      h('span', {}, h('b', { text: String(this.library.size) }), ` ${n(this.library.size, t.common.trackOne, t.common.trackMany)}`),
    ];

    if (this.game.stats.gamesPlayed > 0) {
      parts.push(
        h('span', {}, t.home.bestScore, h('b', { text: points(this.game.stats.bestScore) })),
        h('span', {}, t.home.bestStreak, h('b', { text: String(this.game.stats.bestStreak) })),
      );
    }
    this.foot.replaceChildren(...parts);
  }

  private renderNotice(): void {
    const { library } = this;

    if (library.loading) {
      this.noticeHost.replaceChildren();
      return;
    }

    if (library.error) {
      this.noticeHost.replaceChildren(
        h(
          'div',
          { class: 'notice notice-error' },
          h('h2', { text: t.home.serverDownTitle }),
          h('p', { text: t.home.serverDownBody }),
          h('button', {
            class: 'btn btn-ghost',
            text: t.common.retry,
            attrs: { type: 'button' },
            onclick: () => void library.load(),
          }),
          h('code', { text: library.error }),
        ),
      );
      return;
    }

    if (library.size === 0) {
      this.noticeHost.replaceChildren(
        h(
          'div',
          { class: 'notice' },
          h('h2', { text: t.home.noMusicTitle }),
          h('p', { text: t.home.noMusicBody }),
          h('button', {
            class: 'btn btn-ghost',
            text: t.home.rescan,
            attrs: { type: 'button' },
            onclick: () => void library.refresh(),
          }),
          h('code', { text: library.libraryPath || gameConfig.library.path }),
        ),
      );
      return;
    }

    this.noticeHost.replaceChildren();
  }
}
