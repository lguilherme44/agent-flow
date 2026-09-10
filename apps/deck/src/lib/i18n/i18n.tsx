import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setRequestLocale } from '../api';
import { invalidate } from '../store';
import { en } from './translations/en';
import { ptBR } from './translations/pt-BR';
import type { Dictionary } from './translations/en';

/**
 * The Deck in two languages, and pt-BR is the one it opens in.
 *
 * **A dictionary rather than strings in components, and the reason is the second
 * language.** Every string this bundle authors lives in `translations/en.ts`, whose type
 * *is* the contract: `pt-BR.ts` is annotated with it, so a key that is missing, misspelled
 * or extra is a compile error rather than a screen that falls back to English in one
 * corner. The parity test beside this file covers what the compiler cannot — that a
 * function key takes the same number of arguments in both.
 *
 * **Functions, not placeholders.** A count reaches a sentence as an argument
 * (`tasks(3)`), because plural and gender are not the same operation in the two
 * languages: `1 task` / `2 tasks` is a suffix, and `1 tarefa` / `2 tarefas` agrees with a
 * word that a `{n} task(s)` template cannot see. Each dictionary writes its own sentence.
 *
 * **The server's half switches with it.** The attention queue's `what` and `why`, a board
 * card's reason, a delivery's `detail`, the doctor's remediations and every refusal are
 * written in `src/core` and `src/app`, which now take a phrase book of their own; the
 * locale rides on every request as `?lang`, so the two halves of the screen can never be
 * in different languages. That is why switching invalidates the whole store below —
 * every cached answer was fetched in the language the reader has just left.
 *
 * **What no book translates, in either half:** a reviewer's finding, an SDD, a feature
 * description, a message one agent sent another. Those are a model's words, and a
 * renderer that rewrote them would be inventing evidence.
 */

export type Locale = 'pt-BR' | 'en';

/** Where the choice is kept. Namespaced, because the origin is shared with `--classic`. */
const STORAGE_KEY = 'agent-flow:deck:locale';

const DICTIONARIES: Record<Locale, Dictionary> = { 'pt-BR': ptBR, en };

/**
 * pt-BR unless the reader has chosen otherwise.
 *
 * Not `navigator.language`: this product's operator asked for a Portuguese screen, and a
 * browser installed in English would silently overrule that on the first visit. The
 * choice is a click away and it is remembered.
 */
export function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'pt-BR') return saved;
  } catch {
    // A private window, or storage the browser refuses. The default is still an answer.
  }
  return 'pt-BR';
}

interface I18n {
  readonly locale: Locale;
  readonly t: Dictionary;
  readonly setLocale: (next: Locale) => void;
}

const Context = createContext<I18n | undefined>(undefined);

export function I18nProvider({ locale: fixed, children }: { locale?: Locale; children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => {
    const initial = fixed ?? initialLocale();
    // Before the first fetch, not after it: a read that went out in the wrong language
    // would be cached under a key that says otherwise.
    setRequestLocale(initial);
    return initial;
  });

  useEffect(() => {
    // The document's language is an accessibility fact, not decoration: a screen reader
    // picks its voice from it, and a Portuguese page marked `en` is read with an English
    // one, word by word.
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18n>(
    () => ({
      locale,
      t: DICTIONARIES[locale],
      setLocale: (next: Locale) => {
        setLocale(next);
        /*
          The server writes prose too — a gate's sentence, a refusal, the doctor's advice —
          and it writes it in the language the request names. So the language is part of
          every read's address: changing it changes the key, and the store fetches again
          rather than repainting yesterday's answer in a new frame.
        */
        setRequestLocale(next);
        invalidate(() => true);
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {
          // Unremembered is better than unusable.
        }
      },
    }),
    [locale],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/**
 * The dictionary, wherever a component is.
 *
 * Outside a provider it answers pt-BR rather than throwing — which is what a component
 * test renders into, and it means a test asserts the sentence a person actually reads.
 */
export function useT(): Dictionary {
  return useContext(Context)?.t ?? ptBR;
}

export function useLocale(): { locale: Locale; setLocale: (next: Locale) => void } {
  const context = useContext(Context);
  return context === undefined
    ? { locale: 'pt-BR', setLocale: () => undefined }
    : { locale: context.locale, setLocale: context.setLocale };
}
