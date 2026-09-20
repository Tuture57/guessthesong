/**
 * The volume control: a speaker button that mutes, and a small panel holding
 * the slider and a readout.
 *
 * It lives in the top bar, so it is on every screen at once. The reveal panel
 * is a full-screen overlay that covers that bar, and it is exactly where the
 * whole song plays — so the reveal carries a second instance of this control
 * in its own audio strip. Several views, one setting: the state lives in
 * `core/volume`, which the audio engine also reads, and this file decides
 * nothing.
 *
 * The panel follows the pointer on a desktop and stays open on a tap — the
 * same element has to work with a mouse, a keyboard and a thumb, and a
 * hover-only control is unreachable on a phone.
 */
import { volume } from '../core/volume';
import { fill, t } from '../i18n';
import { h, icon } from './dom';
import type { IconName } from './dom';

const ICONS: Record<'normal' | 'low' | 'muted', IconName> = {
  normal: 'volume',
  low: 'volumeLow',
  muted: 'volumeMute',
};

export class VolumeControl {
  readonly root: HTMLElement;

  private readonly button: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly readout: HTMLElement;
  private open = false;
  private unsubscribe: (() => void) | null = null;

  constructor() {
    this.button = this.buildButton();
    this.slider = this.buildSlider();
    this.readout = h('span', { class: 'volume-readout mono' });
    this.panel = this.buildPanel();
    this.root = this.buildRoot();

    document.addEventListener('pointerdown', this.onOutside, true);
    document.addEventListener('keydown', this.onKeyDown, true);

    this.unsubscribe = volume.subscribe(() => this.update());
    this.update();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    document.removeEventListener('pointerdown', this.onOutside, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
  }

  /** The speaker. Clicking it mutes, and opens the panel so a tap can reach
   *  the slider — there is no hover on a phone. */
  private buildButton(): HTMLButtonElement {
    return h('button', {
      class: 'volume-toggle',
      attrs: { type: 'button', 'aria-expanded': 'false' },
      onclick: () => {
        volume.toggleMute();
        this.setOpen(true);
      },
    });
  }

  private buildSlider(): HTMLInputElement {
    return h('input', {
      class: 'volume-slider',
      attrs: {
        type: 'range',
        min: '0',
        max: '100',
        step: '1',
        'aria-label': t.volume.level,
        // The bare number reads as "75" to a screen reader, which is useless.
        'aria-valuetext': fill(t.volume.levelValue, { percent: volume.percent }),
      },
      oninput: () => volume.setLevel(Number(this.slider.value) / 100),
      onkeydown: (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        this.dismiss();
      },
    });
  }

  private buildPanel(): HTMLElement {
    return h(
      'div',
      { class: 'volume-panel' },
      h(
        'div',
        { class: 'volume-panel-head' },
        h('span', { class: 'volume-label', text: t.volume.level }),
        this.readout,
      ),
      this.slider,
    );
  }

  private buildRoot(): HTMLElement {
    return h(
      'div',
      {
        class: 'volume',
        onpointerenter: () => this.setOpen(true),
        onpointerleave: () => {
          // A keyboard user keeps the panel: `:focus-within` holds it open.
          if (!this.root.contains(document.activeElement)) this.setOpen(false);
        },
      },
      this.button,
      this.panel,
    );
  }

  /**
   * Escape dismisses the panel. Focus leaves the control with it: the panel
   * stays open while anything inside it is focused — that is what keeps it
   * usable from the keyboard — so a dismissal that left focus behind would
   * dismiss nothing.
   */
  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    if (!this.root.contains(document.activeElement)) return;
    event.stopPropagation();
    this.dismiss();
  };

  private dismiss(): void {
    this.setOpen(false);
    if (document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  }

  private onOutside = (event: Event): void => {
    if (!this.open) return;
    if (event.target instanceof Node && this.root.contains(event.target)) return;
    this.setOpen(false);
  };

  private setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.root.classList.toggle('is-open', open);
    this.button.setAttribute('aria-expanded', String(open));
  }

  update(): void {
    const state = volume.state;
    const muted = volume.isMuted;
    this.root.dataset.state = state;
    this.button.replaceChildren(icon(ICONS[state], 17, 1.9));
    this.button.setAttribute('aria-label', muted ? t.volume.unmute : t.volume.mute);
    this.button.setAttribute('aria-pressed', String(muted));
    this.button.title = muted ? t.volume.unmute : t.volume.mute;

    const percent = volume.percent;
    if (this.slider.value !== String(percent)) this.slider.value = String(percent);
    // A muted slider still shows the level it will come back to, so the
    // control never lies about what un-muting will do.
    this.slider.setAttribute('aria-valuetext', fill(t.volume.levelValue, { percent }));
    this.readout.textContent = fill(t.volume.percent, { percent });
  }
}
