import { createContext, useContext, useState, useEffect, useMemo, type ReactNode } from 'react';
import { en, type TranslationDictionary } from './translations/en';
import { ptBR } from './translations/pt-BR';

export type SupportedLocale = 'en' | 'pt-BR';

export interface I18nContextValue {
  readonly locale: SupportedLocale;
  readonly setLocale: (locale: SupportedLocale) => void;
  readonly t: TranslationDictionary;
}

const STORAGE_KEY = 'agent-flow:locale';

const translations: Record<SupportedLocale, TranslationDictionary> = {
  en,
  'pt-BR': ptBR,
};

const I18nContext = createContext<I18nContextValue | null>(null);

function detectInitialLocale(): SupportedLocale {
  if (typeof window === 'undefined') return 'en';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'pt-BR') return saved;

    const browserLang = navigator.language.toLowerCase();
    if (browserLang.startsWith('pt')) return 'pt-BR';
  } catch {
    // Ignore storage/navigator failures in headless environments
  }
  return 'en';
}

export function I18nProvider(props: { children: ReactNode; initialLocale?: SupportedLocale }): JSX.Element {
  const [locale, setLocaleState] = useState<SupportedLocale>(() => props.initialLocale ?? detectInitialLocale());

  const setLocale = (newLocale: SupportedLocale) => {
    setLocaleState(newLocale);
    try {
      localStorage.setItem(STORAGE_KEY, newLocale);
      document.documentElement.lang = newLocale;
    } catch {
      // Ignore
    }
  };

  useEffect(() => {
    try {
      document.documentElement.lang = locale;
    } catch {
      // Ignore
    }
  }, [locale]);

  const value = useMemo(
    () => ({
      locale,
      setLocale,
      t: translations[locale] ?? en,
    }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    return {
      locale: 'en',
      setLocale: () => {},
      t: en,
    };
  }
  return ctx;
}
