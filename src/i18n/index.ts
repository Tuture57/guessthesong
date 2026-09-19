/**
 * The copy layer.
 *
 * Components read `t.<screen>.<key>`. Nothing else in `src/` holds a sentence.
 *
 * The dictionary is deliberately *widened* rather than kept as literal types,
 * so a second language is a new file typed `Dictionary` plus one import change
 * here — no component is touched:
 *
 *   import { fr } from './fr';
 *   import { en } from './en';
 *   export const t: Dictionary = pickLanguage() === 'en' ? en : fr;
 */
import { fill as fillTemplate } from '../../shared/messages.fr.js';
import { fr } from './fr';
import type { FrDictionary } from './fr';

type Widen<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? Widen<U>[]
    : T extends object
      ? { [K in keyof T]: Widen<T[K]> }
      : T;

export type Dictionary = Widen<FrDictionary>;

export const t: Dictionary = fr;

/**
 * Replace `{key}` placeholders. Anything without a value is left as-is rather
 * than blanked, so a missing parameter is visible instead of silently empty.
 */
export function fill(template: string, params: Record<string, string | number> = {}): string {
  return fillTemplate(template, params);
}

/**
 * French counts: 0 and 1 take the singular ("0 manche", "1 manche"), only 2+
 * take the plural. The English rule — singular only at exactly 1 — would write
 * "0 manches" here.
 */
export function n(count: number, one: string, many = `${one}s`): string {
  return Math.abs(count) < 2 ? one : many;
}

/** `"1 240"` — thin grouping, easier to scan than `1,240`. */
export function points(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** `0.1` → `"0,1"`, `2` → `"2"` — French decimal comma, no trailing zeros. */
export function seconds(value: number): string {
  return String(Math.round(value * 1000) / 1000).replace('.', ',');
}

/** `"3 sur 5"`-style counts, used by the results screens. */
export function countOf(count: number, one: string, many = `${one}s`): string {
  return `${count} ${n(count, one, many)}`;
}
