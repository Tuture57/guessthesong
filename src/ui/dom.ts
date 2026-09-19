/** Tiny DOM helpers — enough structure to build the screens without a framework. */

type Child = Node | string | number | null | undefined | false;

interface Props {
  class?: string;
  text?: string;
  html?: string;
  style?: Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  [key: `on${string}`]: ((event: never) => void) | undefined;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;

      if (key === 'class') element.className = String(value);
      else if (key === 'text') element.textContent = String(value);
      else if (key === 'html') element.innerHTML = String(value);
      else if (key === 'style') Object.assign(element.style, value);
      else if (key === 'dataset') Object.assign(element.dataset, value as Record<string, string>);
      else if (key === 'attrs') {
        for (const [name, attr] of Object.entries(value as Record<string, unknown>)) {
          if (attr !== null && attr !== undefined && attr !== false) element.setAttribute(name, String(attr));
        }
      } else if (key.startsWith('on') && typeof value === 'function') {
        element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else {
        element.setAttribute(key, String(value));
      }
    }
  }

  append(element, children);
  return element;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

/** Icons are static, trusted markup — built once and cloned per use. */
const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.4-3.4"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5V9H15"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  arrow: '<path d="M4.5 12h14"/><path d="m12.5 6 6 6-6 6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  note: '<path d="M9 17.5V6.2l10-2v11.3"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>',
  play: '<path d="M8 5.2v13.6L19 12z" fill="currentColor" stroke="none"/>',
  pause:
    '<rect x="7" y="5" width="3.6" height="14" rx="1.3" fill="currentColor" stroke="none"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.3" fill="currentColor" stroke="none"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.4"/><path d="M15 5.6A2.6 2.6 0 0 0 12.4 4H6.6A2.6 2.6 0 0 0 4 6.6v5.8A2.6 2.6 0 0 0 5.6 15"/>',
  users:
    '<circle cx="9" cy="8" r="3.2"/><path d="M3.6 19.2a5.4 5.4 0 0 1 10.8 0"/><path d="M16 5.4a3.2 3.2 0 0 1 0 6.2"/><path d="M17.4 14.4a5.4 5.4 0 0 1 3 4.8"/>',
  crown: '<path d="M4 17h16"/><path d="M4.6 15 3 6.4l5 3.4L12 4.6l4 5.2 5-3.4L19.4 15z"/>',
  clock: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.6V12l3.2 2"/>',
  chevron: '<path d="m6 9.5 6 6 6-6"/>',
  podium: '<path d="M4 20V10h4v10"/><path d="M10 20V4h4v16"/><path d="M16 20v-6h4v6"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 18, strokeWidth = 1.9, className?: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  svg.innerHTML = ICONS[name];
  return svg;
}

/** A flame for the streak counter — filled, so it reads at 13px. */
export function flameIcon(size = 13): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<path d="M12 2.4c.7 2.6 2.4 3.9 3.6 5.4A7.4 7.4 0 0 1 17.4 12a5.4 5.4 0 0 1-10.8 0c0-1.2.4-2.3 1-3.2.6 1.3 1.6 2.1 2.8 2.4.5-3.1-.1-6.5 1.6-8.8z"/>';
  return svg;
}

/* ── Formatting ─────────────────────────────────────────────────────── */

/**
 * `77.34` → `"1:17"`. A clock reading, not prose: the number formatting that
 * depends on the language lives in `src/i18n`.
 */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
