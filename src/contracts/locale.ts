import { z } from 'zod';

/**
 * The languages this product speaks, named once.
 *
 * **A locale is a property of a *request*, never of the machine.** The CLI is always
 * English: a terminal's output is quoted into issues, pasted into scripts and grepped by
 * people who did not write it, and a command whose text changed with an environment
 * variable would break all three. The browser asks for what its reader chose.
 *
 * Declared in `src/contracts` because both sides of the boundary need it: the core takes
 * a phrase book keyed by this, and the HTTP layer parses it off a query string.
 */
export const LOCALES = ['en', 'pt-BR'] as const;
export const LocaleSchema = z.enum(LOCALES);
export type Locale = (typeof LOCALES)[number];

/** The one a request gets when it does not ask, which is what every CLI invocation is. */
export const DEFAULT_LOCALE: Locale = 'en';
