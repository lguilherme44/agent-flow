import type { ReactNode } from 'react';
import type { Connection } from '../lib/live';
import { formatClock } from '../lib/time';
import { useLocale, useT, type Locale } from '../lib/i18n';
import { useNow } from '../lib/use-now';
import { href, onLinkClick, type Route } from './router';

export function Shell({ route, connection, version, children }: { route: Route; connection: Connection; version?: string; children: ReactNode }) {
  const now = useNow(true);
  const t = useT();
  const { locale, setLocale } = useLocale();

  const state: { label: string; tone: 'live' | 'warn' | 'idle' } =
    connection === 'live'
      ? { label: t.nav.live, tone: 'live' }
      : connection === 'polling'
        ? { label: t.nav.reconnecting, tone: 'warn' }
        : { label: t.nav.connecting, tone: 'idle' };

  const link = (name: 'deck' | 'runs' | 'crew' | 'analytics' | 'doctor' | 'clean', label: string): ReactNode => {
    const current = route.name === name || (name === 'runs' && route.name === 'run');
    const to = href(name === 'deck' ? { name: 'deck' } : name === 'runs' ? { name: 'runs' } : name === 'crew' ? { name: 'crew' } : name === 'analytics' ? { name: 'analytics' } : name === 'doctor' ? { name: 'doctor' } : { name: 'clean' });
    return (
      <a className="nav__link" href={to} onClick={onLinkClick} aria-current={current ? 'page' : undefined}>
        {label}
      </a>
    );
  };

  return (
    <div className="shell">
      <header className="topbar">
        <a className="wordmark" href="/" onClick={onLinkClick} aria-label={t.nav.home}>
          Agent Flow <span className="wordmark__tag">Deck</span>
        </a>
        <nav className="nav" aria-label={t.nav.sections}>
          {link('deck', t.nav.deck)}
          {link('runs', t.nav.runs)}
          {link('crew', t.nav.crew)}
          {link('analytics', t.nav.analytics)}
          {link('doctor', t.nav.doctor)}
          {link('clean', t.nav.clean)}
        </nav>
        <div className="status-cluster">
          {/*
            Two buttons rather than a select, and each label is written in its own
            language: `Português` is what somebody looking for Portuguese scans for, and
            they are not reading the current language when they go looking.
          */}
          <div className="lang" role="group" aria-label={t.nav.language}>
            <LanguageButton locale="pt-BR" current={locale} onPick={setLocale} label={t.nav.languagePt} />
            <LanguageButton locale="en" current={locale} onPick={setLocale} label={t.nav.languageEn} />
          </div>
          <span className="conn" data-tone={state.tone} title={t.nav.connectionTitle}>
            <span className="conn__dot" aria-hidden="true" />
            <span>{state.label}</span>
          </span>
          <time className="clock" dateTime={new Date(now).toISOString()}>
            {formatClock(now)}
          </time>
        </div>
      </header>
      {children}
      <footer className="footer">
        <span>{t.nav.footer}</span>
        <span>{version === undefined ? '' : `agent-flow ${version}`}</span>
      </footer>
    </div>
  );
}

function LanguageButton({ locale, current, onPick, label }: {
  readonly locale: Locale;
  readonly current: Locale;
  readonly onPick: (next: Locale) => void;
  readonly label: string;
}) {
  return (
    <button type="button" className="lang__pick" aria-pressed={current === locale} onClick={() => onPick(locale)} lang={locale}>
      {label}
    </button>
  );
}
