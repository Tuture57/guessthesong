/**
 * Application shell: the top bar, the screen router, and the keyboard
 * shortcuts that belong to the app rather than to a single screen.
 *
 * Three worlds share one page: singleplayer (home → round → results),
 * multiplayer (menu → lobby → game → results), and the empty-library notice.
 */
import { audio } from '../core/audio';
import type { Game } from '../core/game';
import type { Library } from '../core/library';
import { multiplayer } from '../core/multiplayer';
import { countOf, fill, t } from '../i18n';
import { h, icon } from './dom';
import { HomeView } from './home';
import { MultiplayerGame, MultiplayerLobby, MultiplayerMenu, MultiplayerResults } from './multi';
import { createResults } from './results';
import { RoundView } from './round';
import { VolumeControl } from './volume';

export class App {
  private game: Game;
  private library: Library;
  private screenHost = h('main', { class: 'screen-host' });
  private libraryChip!: HTMLButtonElement;
  private chipText!: HTMLElement;
  private homeView: HomeView | null = null;
  private roundView: RoundView | null = null;
  private mpMenu: MultiplayerMenu | null = null;
  private mpLobby: MultiplayerLobby | null = null;
  private mpGame: MultiplayerGame | null = null;
  private mpResults: MultiplayerResults | null = null;
  private screenKey = '';
  private chipResetTimer: number | null = null;
  /** True while the chip is showing a rescan result rather than the count. */
  private chipPinned = false;

  constructor(game: Game, library: Library) {
    this.game = game;
    this.library = library;
  }

  mount(container: HTMLElement): void {
    this.screenHost.style.display = 'contents';
    container.append(this.buildTopbar(), this.screenHost);

    this.game.subscribe(() => this.render());
    this.library.subscribe(() => this.render());
    multiplayer.subscribe(() => this.render());
    window.addEventListener('keydown', this.onKeyDown);

    // The first real gesture is the only chance to wake the AudioContext, so
    // it is awake long before anyone presses PLAY.
    window.addEventListener('pointerdown', () => multiplayer.warmAudio(), { once: true, capture: true });

    this.render();
  }

  private buildTopbar(): HTMLElement {
    this.chipText = h('span', { class: 'chip-text', text: t.topbar.loading });
    this.libraryChip = h(
      'button',
      {
        class: 'chip',
        attrs: { type: 'button', title: t.topbar.rescanTitle },
        onclick: () => void this.rescan(),
      },
      icon('refresh', 14, 2),
      this.chipText,
    );

    /*
     * The volume control sits in the top bar so it is on every screen at once
     * — solo, multiplayer, results — and so it can never push the controls a
     * round needs off the bottom of the page.
     */
    const volumeControl = new VolumeControl();

    return h(
      'header',
      { class: 'shell topbar' },
      h('div', { class: 'brand' }, icon('note', 15, 2), h('span', { text: t.brand.name })),
      h('div', { class: 'topbar-actions' }, volumeControl.root, this.libraryChip),
    );
  }

  /* ── Top bar ──────────────────────────────────────────────────────── */

  private updateChip(): void {
    const { library } = this;
    this.libraryChip.disabled = library.loading;

    // A rescan reports its result for a moment; a repaint must not wipe it.
    if (this.chipPinned) return;

    if (library.loading) this.chipText.textContent = t.topbar.loading;
    else if (library.error) this.chipText.textContent = t.topbar.offline;
    else this.chipText.textContent = countOf(library.size, t.common.trackOne, t.common.trackMany);
  }

  private async rescan(): Promise<void> {
    if (this.library.loading) return;
    this.libraryChip.classList.add('is-busy');
    this.chipText.textContent = t.topbar.scanning;

    const before = this.library.size;
    const stats = await this.library.refresh();

    this.libraryChip.classList.remove('is-busy');
    this.updateChip();

    if (!stats) return;
    const delta = this.library.size - before;
    const message =
      delta === 0
        ? t.topbar.upToDate
        : delta > 0
          ? fill(t.topbar.added, { count: delta })
          : fill(t.topbar.removed, { count: -delta });

    this.chipText.textContent = message;
    this.chipPinned = true;
    this.libraryChip.classList.add('is-updated');
    if (this.chipResetTimer !== null) clearTimeout(this.chipResetTimer);
    this.chipResetTimer = window.setTimeout(() => {
      this.libraryChip.classList.remove('is-updated');
      this.chipResetTimer = null;
      this.chipPinned = false;
      this.updateChip();
    }, 2600);
  }

  /* ── Screen router ────────────────────────────────────────────────── */

  private render(): void {
    this.updateChip();

    const key = this.routeKey();
    if (key !== this.screenKey) {
      this.screenKey = key;
      this.teardown();

      switch (key) {
        case 'home':
          this.homeView = new HomeView(this.game, this.library);
          this.screenHost.replaceChildren(this.homeView.root);
          break;
        case 'results':
          this.screenHost.replaceChildren(createResults(this.game));
          window.scrollTo({ top: 0 });
          break;
        case 'game':
          this.roundView = new RoundView(this.game, this.library);
          this.screenHost.replaceChildren(this.roundView.root);
          break;
        case 'mp-menu':
          this.mpMenu = new MultiplayerMenu(this.library);
          this.screenHost.replaceChildren(this.mpMenu.root);
          break;
        case 'mp-lobby':
          this.mpLobby = new MultiplayerLobby(this.library);
          this.screenHost.replaceChildren(this.mpLobby.root);
          break;
        case 'mp-game':
          this.mpGame = new MultiplayerGame(this.library);
          this.screenHost.replaceChildren(this.mpGame.root);
          break;
        case 'mp-results':
          this.mpResults = new MultiplayerResults();
          this.screenHost.replaceChildren(this.mpResults.root);
          break;
        case 'empty':
        default:
          this.screenHost.replaceChildren(createEmptyLibrary(this.library));
          break;
      }
    }

    this.homeView?.update();
    this.roundView?.update();
    this.mpMenu?.update();
    this.mpLobby?.update();
    this.mpGame?.update();
    this.mpResults?.update();
  }

  /** Which screen belongs on stage right now. */
  private routeKey(): string {
    if (multiplayer.screen !== 'off') {
      if (multiplayer.screen === 'lobby' && !multiplayer.room) return 'mp-menu';
      return `mp-${multiplayer.screen}`;
    }
    const { screen, round } = this.game;
    // "game" with no round means the library turned out to be unusable.
    return screen === 'game' && !round ? 'empty' : screen;
  }

  private teardown(): void {
    audio.stop();
    this.roundView?.dispose();
    this.roundView = null;
    this.mpGame?.dispose();
    this.mpGame = null;
    this.homeView = null;
    this.mpMenu = null;
    this.mpLobby = null;
    this.mpResults = null;
  }

  /* ── Global keyboard ──────────────────────────────────────────────── */

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter') return;
    if (this.game.screen !== 'results' || multiplayer.screen !== 'off') return;
    event.preventDefault();
    this.game.playAgain();
  };
}

/** Shown when a run was started against an empty library. */
function createEmptyLibrary(library: Library): HTMLElement {
  return h(
    'div',
    { class: 'screen home' },
    h(
      'div',
      { class: 'shell home-main' },
      h(
        'div',
        { class: 'notice' },
        h('h2', { text: t.home.nothingToPlayTitle }),
        h('p', { text: t.home.nothingToPlayBody }),
        h('button', {
          class: 'btn btn-ghost',
          text: t.home.rescan,
          attrs: { type: 'button' },
          onclick: () => void library.refresh(),
        }),
      ),
    ),
  );
}
