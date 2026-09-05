import type { ReactNode } from 'react';
import type { StageViewResponse } from '@contracts/index.js';
import { priorityTone, stageTone, words, type Tone } from '../lib/tone';

/** A status word, toned once. */
export function Chip({ tone, children, plain = false, title }: { tone: Tone; children: ReactNode; plain?: boolean; title?: string }) {
  return (
    <span className={plain ? 'chip chip--plain' : 'chip'} data-tone={tone} title={title}>
      {children}
    </span>
  );
}

export function Pri({ priority }: { priority: string }) {
  return (
    <span className="pri" data-tone={priorityTone(priority)} aria-label={`priority ${priority}`}>
      {priority}
    </span>
  );
}

export function Meter({ label, done, total, tone }: { label?: string; done: number; total: number; tone?: Tone }) {
  const pct = total <= 0 ? 0 : Math.round((done / total) * 100);
  return (
    <span className="meter" role="img" aria-label={`${label ?? 'progress'} ${String(done)} of ${String(total)}`}>
      {label === undefined ? <span /> : <span className="meter__label">{label}</span>}
      <span className="meter__track" data-tone={tone ?? 'idle'}>
        <span className="meter__fill" style={{ width: `${String(pct)}%` }} />
      </span>
    </span>
  );
}

const STAGE_SHORT: Record<string, string> = {
  discovery: 'discover',
  'architecture-impact': 'arch',
  sdd: 'sdd',
  planning: 'plan',
  'plan-review': 'review',
  approval: 'approve',
  implementation: 'build',
  'code-review': 'code rev',
  verification: 'verify',
  'final-review': 'final',
};

/**
 * The pipeline as ten cells, one encoding at every size.
 *
 * Reads the server's stage view and nothing else: the cell for `approval` is whatever
 * `/stages` said, and a tape with a label is the same tape without one, taller.
 */
export function Tape({ stages, tall = false }: { stages: readonly StageViewResponse[] | undefined; tall?: boolean }) {
  const cells = stages ?? [];
  return (
    <div className="tape-box">
      <div className={tall ? 'tape tape--tall' : 'tape'} role="img" aria-label={cells.map((s) => `${s.stage} ${s.status}`).join(', ')}>
        {cells.length === 0
          ? Array.from({ length: 10 }, (_, index) => <span key={index} className="tape__cell" data-tone="ghost" />)
          : cells.map((stage) => (
              <span key={stage.stage} className="tape__cell" data-tone={stageTone(stage.status)} title={`${words(stage.stage)} · ${words(stage.status)}`}>
                {tall ? <span className="tape__label">{STAGE_SHORT[stage.stage] ?? stage.stage}</span> : null}
              </span>
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

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="loading" style={{ display: 'grid', gap: 10, padding: 16 }}>
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
