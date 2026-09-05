import type { ReactNode } from 'react';
import type { Connection } from '../lib/live';
import { formatClock } from '../lib/time';
import { useNow } from '../lib/use-now';
import { href, onLinkClick, type Route } from './router';

const CONNECTION: Record<Connection, { label: string; tone: 'live' | 'warn' | 'idle' }> = {
  live: { label: 'live', tone: 'live' },
  polling: { label: 'reconnecting · polling', tone: 'warn' },
  connecting: { label: 'connecting', tone: 'idle' },
};

export function Shell({ route, connection, version, children }: { route: Route; connection: Connection; version?: string; children: ReactNode }) {
  const now = useNow(true);
  const state = CONNECTION[connection];

  const link = (name: 'deck' | 'runs' | 'crew', label: string): ReactNode => {
    const current = route.name === name || (name === 'runs' && route.name === 'run');
    const to = name === 'deck' ? href({ name: 'deck' }) : name === 'runs' ? href({ name: 'runs' }) : href({ name: 'crew' });
    return (
      <a className="nav__link" href={to} onClick={onLinkClick} aria-current={current ? 'page' : undefined}>
        {label}
      </a>
    );
  };

  return (
    <div className="shell">
      <header className="topbar">
        <a className="wordmark" href="/" onClick={onLinkClick} aria-label="Agent Flow Deck, home">
          Agent Flow <span className="wordmark__tag">Deck</span>
        </a>
        <nav className="nav" aria-label="Sections">
          {link('deck', 'Deck')}
          {link('runs', 'Runs')}
          {link('crew', 'Crew')}
        </nav>
        <div className="status-cluster">
          <span className="conn" data-tone={state.tone} title="Server-sent events. Polling is the fallback, never the default.">
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
        <span>loopback · no auth · every write goes through the same use case the CLI calls</span>
        <span>{version === undefined ? '' : `agent-flow ${version}`}</span>
      </footer>
    </div>
  );
}
