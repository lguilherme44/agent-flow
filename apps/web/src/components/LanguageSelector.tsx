import { Globe } from 'lucide-react';
import { useI18n } from '../lib/i18n/i18n-context';
import { cx } from './ui';

export function LanguageSelector(props: { className?: string }): JSX.Element {
  const { locale, setLocale } = useI18n();

  return (
    <div
      className={cx('inline-flex items-center gap-1.5 rounded-md border border-line/40 bg-surface/50 px-2 py-1 text-micro text-text', props.className)}
      role="group"
      aria-label="Language selection"
    >
      <Globe className="h-3.5 w-3.5 text-faint shrink-0" aria-hidden />
      <button
        type="button"
        onClick={() => setLocale('en')}
        className={cx(
          'rounded px-1.5 py-0.5 font-medium transition-colors',
          locale === 'en' ? 'bg-accent/20 text-accent font-semibold' : 'text-faint hover:text-text',
        )}
        aria-pressed={locale === 'en'}
      >
        EN
      </button>
      <span className="text-line">|</span>
      <button
        type="button"
        onClick={() => setLocale('pt-BR')}
        className={cx(
          'rounded px-1.5 py-0.5 font-medium transition-colors',
          locale === 'pt-BR' ? 'bg-accent/20 text-accent font-semibold' : 'text-faint hover:text-text',
        )}
        aria-pressed={locale === 'pt-BR'}
      >
        PT
      </button>
    </div>
  );
}
