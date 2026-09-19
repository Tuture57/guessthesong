import './styles/index.css';
import { game } from './core/game';
import { library } from './core/library';
import { multiplayer } from './core/multiplayer';
import { assertScoringInvariant } from './core/scoring';
import { App } from './ui/app';

// A broken scoring table would silently make speed beat recognition — refuse
// to start rather than mis-score a game.
assertScoringInvariant();

const container = document.getElementById('app');
if (container) {
  const app = new App(game, library);
  app.mount(container);
  void library.load();
  // A refresh in mid-lobby or mid-round should land back in the same seat.
  void multiplayer.resumeSession();
}
