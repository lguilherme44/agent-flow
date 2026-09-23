import type { ReactNode } from 'react';
import type { StageViewResponse } from '@contracts/index.js';
import { priorityTone, stageTone, type Tone } from '../lib/tone';
import { useT, word } from '../lib/i18n';
import { phasesOf } from '../lib/phases';

/** A status word, toned once. */
export function Chip({ tone, children, plain = false, title }: { tone: Tone; children: ReactNode; plain?: boolean; title?: string | undefined }) {
  return (
    <span className={plain ? 'chip chip--plain' : 'chip'} data-tone={tone} title={title}>
      {children}
    </span>
  );
}

export function Pri({ priority }: { priority: string }) {
  const t = useT();
  return (
    <span className="pri" data-tone={priorityTone(priority)} aria-label={t.common.priorityOf(priority)}>
      {priority}
    </span>
  );
}

export function Meter({ label, done, total, tone }: { label?: string; done: number; total: number; tone?: Tone }) {
  const t = useT();
  const pct = total <= 0 ? 0 : Math.round((done / total) * 100);
  return (
    <span className="meter" role="img" aria-label={t.common.progressOf(label ?? t.common.progress, done, total)}>
      {label === undefined ? <span /> : <span className="meter__label">{label}</span>}
      <span className="meter__track" data-tone={tone ?? 'idle'}>
        <span className="meter__fill" style={{ width: `${String(pct)}%` }} />
      </span>
    </span>
  );
}

/**
 * A run's five phases as five cells, the run page's phases at lane size.
 *
 * It was eleven cells, one per pipeline stage, and a finished run showed gaps where a
 * stage had been skipped (a switched-off `e2e`, a `code-review` nobody was routed to) —
 * which read as work still to come.
 */
export function Tape({ stages, finished }: { stages: readonly StageViewResponse[] | undefined; finished: boolean }) {
  const t = useT();
  const phases = stages === undefined ? [] : phasesOf(stages, undefined, finished);
  return (
    <div className="tape-box">
      <div className="tape" role="img" aria-label={phases.map((phase) => `${t.run.phase[phase.id]} ${word(t, phase.status)}`).join(', ')}>
        {phases.length === 0
          ? Array.from({ length: 5 }, (_, index) => <span key={index} className="tape__cell" data-tone="ghost" />)
          : phases.map((phase) => (
              <span key={phase.id} className="tape__cell" data-tone={stageTone(phase.status)} title={`${t.run.phase[phase.id]} · ${word(t, phase.status)}`} />
            ))}
      </div>
    </div>
  );
}

export function Empty({ children, hint, error = false }: { children: ReactNode; hint?: ReactNode; error?: boolean }) {
  return (
    <div className={error ? 'empty empty--error' : 'empty'} role={error ? 'alert' : undefined}>
      {children}
      {hint === undefined ? null : <span className="empty__hint">{hint}</span>}
    </div>
  );
}

/**
 * The first screen anybody sees, and it used to be a skeleton that never resolved.
 *
 * Every page below the deck is *about* a project, and each of them guarded with
 * `projects.loading || project === undefined` — which is two different states wearing one
 * answer. Loading is temporary; having none is permanent until somebody acts, and showing
 * the spinner for both meant a fresh workspace opened onto a page that span forever and
 * explained nothing. Found by pointing `ui` at a directory holding one unregistered
 * repository — the exact shape of a first day.
 *
 * So it says which of the two it is, and points at the thing that ends it.
 */
export function NoProjectsYet({ what }: { what: string }) {
  const t = useT();
  return (
    <Empty
      hint={
        <>
          {t.common.noProjectsHintBefore}
          <a href="/" style={{ textDecoration: 'underline' }}>{t.common.noProjectsHintDeck}</a>
          {t.common.noProjectsHintAfter}
          <b>{t.common.noProjectsHintAction}</b>
          {t.common.noProjectsHintTail}
          <code>{t.common.noProjectsHintInit}</code>
          {t.common.noProjectsHintEnd}
        </>
      }
    >
      {t.common.noProjectsYet(what)}
    </Empty>
  );
}

/**
 * A titled division inside a panel, with the count that says how much is under it.
 *
 * Lived twice — once in the outcome panel and once in the telemetry tab — until the team
 * and collaboration tabs would have made it four. Two copies of a heading is how one of
 * them quietly grows a different margin.
 */
export function Block({ title, count, children }: { title: string; count?: string; children: ReactNode }) {
  return (
    <div className="block">
      <div className="block__head">
        <span className="eyebrow">{title}</span>
        {count === undefined ? null : <span className="section__count">{count}</span>}
      </div>
      {children}
    </div>
  );
}

/** One number and what it counts. The strip a tab opens with. */
export function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'bad' | undefined }) {
  return (
    <div className="stat">
      <span className="stat__value" data-tone={tone}>
        {value}
      </span>
      <span className="stat__label">{label}</span>
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  const t = useT();
  return (
    <div aria-busy="true" aria-label={t.common.loading} style={{ display: 'grid', gap: 10, padding: 16 }}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton" style={{ width: `${String(90 - index * 17)}%` }} />
      ))}
    </div>
  );
}

export function Notice({ tone, k, children }: { tone: Tone; k: string; children: ReactNode }) {
  return (
    <div className="notice" data-tone={tone} role="status">
      <span className="notice__k">{k}</span>
      <span>{children}</span>
    </div>
  );
}
