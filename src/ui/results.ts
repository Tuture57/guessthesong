/** End-of-run summary: the score, the numbers behind it, and every round. */
import { coverUrl } from '../core/audio';
import type { Game } from '../core/game';
import { fill, points, seconds, t } from '../i18n';
import { h, icon } from './dom';

export function createResults(game: Game): HTMLElement {
  const root = h('div', { class: 'screen results' });
  const shell = h('div', { class: 'shell' });
  const inner = h('div', { class: 'results-inner' });

  const played = game.history.length;
  const solved = game.history.filter((result) => result.solved).length;

  inner.append(
    h('p', { class: 'results-title', text: t.results.title }),
    h('p', { class: 'results-score', text: points(game.score) }),
    h('p', { class: 'results-sub', text: fill(t.results.guessed, { solved, played }) }),
    h(
      'dl',
      { class: 'results-stats' },
      stat(t.results.correctLabel, `${played ? Math.round((solved / played) * 100) : 0} %`),
      stat(t.results.bestStreakLabel, String(game.bestStreak)),
      stat(t.results.bestEverLabel, points(game.stats.bestScore)),
    ),
    buildList(game),
    h(
      'div',
      { class: 'results-actions' },
      h('button', {
        class: 'btn btn-ghost',
        text: t.results.menu,
        attrs: { type: 'button' },
        onclick: () => game.quit(),
      }),
      h(
        'button',
        {
          class: 'btn btn-primary',
          attrs: { type: 'button' },
          onclick: () => game.playAgain(),
        },
        h('span', { text: t.results.playAgain }),
        icon('arrow', 17),
      ),
    ),
  );

  shell.append(inner);
  root.append(shell);

  if (game.beatPersonalBest) {
    inner.querySelector('.results-sub')?.append(h('span', { text: `   ·   ${t.results.personalBest}` }));
  }

  return root;
}

function stat(label: string, value: string): HTMLElement {
  return h('div', {}, h('dt', { text: label }), h('dd', { text: value }));
}

function buildList(game: Game): HTMLElement {
  const list = h('ol', { class: 'results-list' });

  game.history.forEach((result, index) => {
    const art = h('img', { class: 'results-art', attrs: { src: coverUrl(result.track.id), alt: '', loading: 'lazy' } });
    art.addEventListener('error', () => art.replaceWith(h('span', { class: 'results-art' })));

    const row = h(
      'li',
      { class: `results-row${result.solved ? '' : ' is-miss'}` },
      art,
      h(
        'div',
        { class: 'results-row-text' },
        h('div', { class: 'results-row-title', text: result.track.title }),
        h('div', { class: 'results-row-artist', text: result.track.artist || t.common.dash }),
      ),
      h('span', {
        class: 'results-row-step',
        text: result.solved ? `${seconds(result.duration)} s` : t.results.gaveUp,
      }),
      h('span', { class: 'results-row-points', text: result.points > 0 ? `+${points(result.points)}` : t.common.dash }),
    );
    row.style.animationDelay = `${Math.min(index * 45, 450)}ms`;
    list.append(row);
  });

  return list;
}
