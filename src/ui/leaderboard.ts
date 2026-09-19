/**
 * Live standings for a multiplayer match.
 *
 * Spoiler safety is structural, not a rule this file has to remember: the only
 * number it reads is `player.score`, which the server adds to *after* a round
 * has resolved. During a round nobody's total moves, so the board can say
 * nothing about the song being played — no reveal level, no in-round points,
 * no answer speed.
 *
 * The order is the final scoreboard's order, computed the same way, so the
 * last update of a match is by construction the final standings.
 *
 * Presentation is the stylesheet's business: a quiet column beside the game on
 * a wide screen, a one-line summary that opens an overlay on a phone. The DOM
 * is identical either way.
 */
import type { MpPlayer } from '../core/types';
import { points, t } from '../i18n';
import { h, icon } from './dom';

/** Fallback ranks are not part of the game — only the label's shape is. */
function rankLabel(rank: number): string {
  return rank === 1 ? '1ᵉʳ' : `${rank}ᵉ`;
}

interface Entry {
  row: HTMLElement;
  rank: HTMLElement;
  name: HTMLElement;
  score: HTMLElement;
  value: number;
  frame: number | null;
  popTimer: number | null;
}

const WIDE = '(min-width: 1000px)';
const TWEEN_MS = 420;

export class LiveLeaderboard {
  readonly root: HTMLElement;

  private head: HTMLButtonElement;
  private headYou: HTMLElement;
  private list: HTMLElement;
  private empty: HTMLElement;
  private entries = new Map<string, Entry>();
  private open = false;
  private wide: boolean;
  /** False until a round has resolved: there is no ranking to show. */
  private hasRows = false;

  constructor() {
    this.wide = window.matchMedia?.(WIDE).matches ?? false;

    this.headYou = h('span', { class: 'mp-board-you' });
    this.head = h(
      'button',
      {
        class: 'mp-board-head',
        attrs: { type: 'button', 'aria-expanded': 'false' },
        onclick: () => this.toggle(),
      },
      icon('podium', 13, 2),
      h('span', { class: 'mp-board-title', text: t.mp.standings }),
      this.headYou,
      icon('chevron', 14, 2.2, 'mp-board-chevron'),
    );

    this.list = h('ol', { class: 'mp-board-list' });
    this.empty = h('p', { class: 'mp-board-empty', text: t.mp.noRankingYet });

    this.root = h('aside', { class: 'mp-board', attrs: { 'aria-label': t.mp.standings } }, this.head, this.list, this.empty);

    this.applyMode();
    window.matchMedia?.(WIDE).addEventListener?.('change', (event) => {
      this.wide = event.matches;
      this.applyMode();
    });
  }

  /**
   * On a wide screen the list is always on; on a phone it folds away. Before
   * the first round resolves there is nothing to fold, so the header stops
   * being a control and just carries the note that says so.
   */
  private applyMode(): void {
    this.open = this.wide ? true : this.open;
    this.root.dataset.open = String(this.open);
    this.head.setAttribute('aria-expanded', String(this.open));
    this.head.disabled = this.wide || !this.hasRows;
    this.head.title = this.head.disabled ? '' : this.open ? t.mp.standingsCollapse : t.mp.standingsToggle;
  }

  private toggle(): void {
    if (this.wide) return;
    this.open = !this.open;
    this.applyMode();
  }

  close(): void {
    if (this.wide) return;
    this.open = false;
    this.applyMode();
  }

  /**
   * @param players the room's public player list
   * @param meId this client's player id
   * @param started true once at least one round has been played out
   */
  update(players: MpPlayer[], meId: string | null, started: boolean): void {
    const filled = started && players.length > 0;
    if (filled !== this.hasRows) {
      this.hasRows = filled;
      this.applyMode();
    }
    if (!filled) {
      this.list.hidden = true;
      this.empty.hidden = false;
      this.headYou.textContent = '';
      // Drop the rows rather than leave them behind an empty board: the room
      // view before the first round still carries zeros, and a zero is not a
      // standing anyone should be able to read.
      this.list.replaceChildren();
      this.entries.clear();
      return;
    }
    this.list.hidden = false;
    this.empty.hidden = true;

    const ordered = [...players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const ids = ordered.map((player) => player.id);

    for (const [index, player] of ordered.entries()) {
      const entry = this.entryFor(player);
      entry.rank.textContent = String(index + 1);
      if (entry.name.textContent !== player.name) entry.name.textContent = player.name;
      entry.row.classList.toggle('is-you', player.id === meId);
      entry.row.classList.toggle('is-away', !player.connected);
      this.setScore(entry, player.score);
    }

    this.dropMissing(ids);
    this.reorder(ids);

    const mine = ordered.findIndex((player) => player.id === meId);
    if (mine >= 0) {
      this.headYou.textContent = t.mp.standingsYou
        .replace('{rank}', rankLabel(mine + 1))
        .replace('{score}', points(ordered[mine].score));
    } else {
      this.headYou.textContent = '';
    }
  }

  private entryFor(player: MpPlayer): Entry {
    const existing = this.entries.get(player.id);
    if (existing) return existing;

    const rank = h('span', { class: 'mp-board-rank' });
    const name = h('span', { class: 'mp-board-name', text: player.name });
    const score = h('span', { class: 'mp-board-score', text: '0' });
    const row = h('li', { class: 'mp-board-row', dataset: { id: player.id } }, rank, name, score);

    const entry: Entry = { row, rank, name, score, value: 0, frame: null, popTimer: null };
    this.entries.set(player.id, entry);
    return entry;
  }

  private dropMissing(ids: string[]): void {
    for (const [id, entry] of this.entries) {
      if (ids.includes(id)) continue;
      if (entry.frame !== null) cancelAnimationFrame(entry.frame);
      if (entry.popTimer !== null) clearTimeout(entry.popTimer);
      entry.row.remove();
      this.entries.delete(id);
    }
  }

  /**
   * Count the number up rather than swapping it: a round's points landing is
   * the one moment the board is worth watching. Any animation already running
   * for that row is abandoned first, so a fast sequence cannot fight itself.
   */
  private setScore(entry: Entry, value: number): void {
    if (entry.value === value && entry.frame === null) return;
    const from = entry.value;
    entry.value = value;
    if (entry.frame !== null) {
      cancelAnimationFrame(entry.frame);
      entry.frame = null;
    }

    if (from === 0 || value <= from || prefersReducedMotion()) {
      entry.score.textContent = points(value);
      if (value > from) this.pop(entry);
      return;
    }

    const started = performance.now();
    const step = (now: number): void => {
      const progress = Math.min(1, (now - started) / TWEEN_MS);
      const eased = 1 - (1 - progress) ** 3;
      entry.score.textContent = points(from + (value - from) * eased);
      if (progress < 1) {
        entry.frame = requestAnimationFrame(step);
      } else {
        entry.frame = null;
        this.pop(entry);
      }
    };
    entry.frame = requestAnimationFrame(step);
  }

  private pop(entry: Entry): void {
    entry.row.classList.remove('is-scored');
    void entry.row.offsetWidth;
    entry.row.classList.add('is-scored');
    if (entry.popTimer !== null) clearTimeout(entry.popTimer);
    entry.popTimer = window.setTimeout(() => {
      entry.popTimer = null;
      entry.row.classList.remove('is-scored');
    }, 900);
  }

  /**
   * Move the rows into their new order and let them slide there (FLIP): the
   * old offset is captured, the row is put in its new place, then it starts
   * displaced by the difference and transitions home.
   */
  private reorder(ids: string[]): void {
    const current = [...this.list.children].map((child) => (child as HTMLElement).dataset.id ?? '');
    if (current.join('|') === ids.join('|')) return;

    const before = new Map<string, number>();
    for (const id of current) {
      const entry = this.entries.get(id);
      if (entry) before.set(id, entry.row.offsetTop);
    }

    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry) this.list.append(entry.row);
    }

    const animate = !prefersReducedMotion();
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      const from = before.get(id);
      if (from === undefined) continue;
      const delta = from - entry.row.offsetTop;
      if (!animate || delta === 0) continue;
      entry.row.style.transition = 'none';
      entry.row.style.transform = `translateY(${delta}px)`;
      void entry.row.offsetHeight;
      entry.row.style.transition = 'transform 0.42s cubic-bezier(0.22, 1, 0.36, 1)';
      entry.row.style.transform = '';
    }
  }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
