export { I18nProvider, useT, useLocale, initialLocale, type Locale } from './i18n';
export type { Dictionary } from './translations/en';
export { en } from './translations/en';
export { ptBR } from './translations/pt-BR';

import type { Dictionary } from './translations/en';

/**
 * One machine token, as a word on screen.
 *
 * The replacement for `words()` in `lib/tone.ts`, and it moved for a reason that file
 * states about itself: tone is "the one place a status becomes a colour", and turning a
 * token into *language* is a different job that was living there because both start from
 * the same string.
 *
 * **An unknown token still renders.** The server's vocabularies grow, and a screen that
 * printed nothing for a word this table has not learned yet would hide the fact rather
 * than the gap. The fallback is exactly what `words()` always did — separators to spaces —
 * so a new status reads as English until somebody translates it, which is visible and
 * therefore fixable.
 */
export function word(t: Dictionary, token: string | undefined): string {
  if (token === undefined) return t.common.none;
  const table: Readonly<Record<string, string | undefined>> = t.words;
  return table[token] ?? token.replace(/[_-]+/g, ' ');
}

/**
 * A level — an effort, a risk — as a word.
 *
 * Not `word()`, and the difference is a bug this caught on screen: `low`, `medium` and
 * `high` are both severities and efforts, and the doctor printed `esforço alta` because
 * the one table it asked agrees with *gravidade*. A caller knows which noun its value sits
 * under; the table cannot.
 */
export function level(t: Dictionary, token: string | undefined): string {
  if (token === undefined) return t.common.none;
  const table: Readonly<Record<string, string | undefined>> = t.levels;
  return table[token] ?? word(t, token);
}

/** A runner's credential state, which is feminine in Portuguese and shares no table. */
export function authState(t: Dictionary, token: string | undefined): string {
  if (token === undefined) return t.common.none;
  const table: Readonly<Record<string, string | undefined>> = t.authState;
  return table[token] ?? word(t, token);
}
