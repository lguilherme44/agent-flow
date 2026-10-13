import type { RunTimelineView } from '@contracts/index.js';
import { api, keys, type RunAddress } from '../../lib/api';
import { useResource } from '../../lib/store';
import { formatDuration } from '../../lib/time';
import { useT, word, type Dictionary } from '../../lib/i18n';
import { Empty, Skeleton } from '../../components/ui';

type Part = 'model' | 'validation' | 'human' | 'quota' | 'rework' | 'other';

/** The order the bar reads in, and the tone each cause wears. Tones are the shared tokens. */
const PARTS: readonly { part: Part; tone: string; ms: (view: RunTimelineView) => number }[] = [
  { part: 'model', tone: 'live', ms: (view) => view.modelMs },
  { part: 'validation', tone: 'ok', ms: (view) => view.validationMs },
  { part: 'human', tone: 'warn', ms: (view) => view.waitingForHumanMs },
  { part: 'quota', tone: 'idle', ms: (view) => view.quotaWaitMs },
  { part: 'rework', tone: 'bad', ms: (view) => view.reworkMs },
  { part: 'other', tone: 'ghost', ms: (view) => view.otherMs },
];

/**
 * Where the run's wall clock went: one bar, six causes, and the stages behind the model's share.
 *
 * Every number is the server's (`core/run-timeline.ts` decides which minute is whose); the
 * widths are those numbers over the run's own wall clock, which is arithmetic over one
 * response rather than a second opinion about it. The six parts partition the wall clock
 * by construction, so the bar has no gap and no overlap to explain.
 *
 * **Money appears here, and only here, and only as reported.** The rest of this tab counts
 * tokens and never prices them. This block shows what the runners themselves said a call
 * cost — absent when none said — and says beside it that it is not a bill.
 */
export function TimeSpent({ address }: { readonly address: RunAddress }) {
  const t = useT();
  const timeline = useResource<RunTimelineView>(keys.timeline(address), () => api.timeline(address));

  if (timeline.error !== undefined) return <Empty error>{t.timeSpent.couldNotRead}</Empty>;
  if (timeline.data === undefined) return <Skeleton rows={2} />;

  const view = timeline.data;
  if (view.wallMs === 0) return <Empty>{t.timeSpent.nothingYet}</Empty>;

  return (
    <section className="doctor-section time-spent" aria-label={t.timeSpent.title}>
      <div className="doctor-section__head">
        <h3>{t.timeSpent.title}</h3>
        <p className="doctor-note">{t.timeSpent.wall(formatDuration(view.wallMs))}</p>
      </div>

      <div className="time-spent__bar" role="img" aria-label={t.timeSpent.bar}>
        {PARTS.map(({ part, tone, ms }) =>
          ms(view) <= 0 ? null : (
            <span
              key={part}
              className="time-spent__part"
              data-part={part}
              data-tone={tone}
              style={{ width: `${String((ms(view) / view.wallMs) * 100)}%` }}
              title={`${t.timeSpent[part]} · ${formatDuration(ms(view))}`}
            />
          ),
        )}
      </div>

      <ul className="time-spent__legend">
        {PARTS.map(({ part, tone, ms }) => (
          <li key={part} data-part={part}>
            <span className="time-spent__swatch" data-tone={tone} aria-hidden="true" />
            <span className="time-spent__name">{t.timeSpent[part]}</span>
            <span className="time-spent__value">
              {formatDuration(ms(view))}
              {costOf(t, part, view)}
            </span>
          </li>
        ))}
      </ul>

      {view.stages.length === 0 ? null : (
        <table className="time-spent__stages" aria-label={t.timeSpent.byStage}>
          <thead>
            <tr>
              <th scope="col">{t.timeSpent.stage}</th>
              <th scope="col">{t.timeSpent.attempts}</th>
              <th scope="col">{t.timeSpent.minutes}</th>
              <th scope="col">{t.timeSpent.cost}</th>
            </tr>
          </thead>
          <tbody>
            {view.stages.map((row) => (
              <tr key={row.stage} data-stage={row.stage}>
                <td>{word(t, row.stage)}</td>
                <td>{row.attempts}</td>
                <td>{(row.modelMs / 60_000).toFixed(1)}</td>
                <td>{row.costUsd === undefined ? t.timeSpent.notReported : row.costUsd.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {view.stale === true ? <p className="doctor-note" data-note="stale">{t.timeSpent.staleNote}</p> : null}
      {view.quotaWaitMs > 0 ? <p className="doctor-note" data-note="quota">{t.timeSpent.quotaNote}</p> : null}
      {view.costUsd === undefined ? null : <p className="doctor-note">{t.timeSpent.notABill}</p>}
    </section>
  );
}

/** Model and rework are the two parts that spend; each says its own figure, when reported. */
function costOf(t: Dictionary, part: Part, view: RunTimelineView): string {
  const cost = part === 'model' ? view.modelCostUsd : part === 'rework' ? view.reworkCostUsd : undefined;
  return cost === undefined ? '' : ` · ${t.timeSpent.usd(cost.toFixed(2))}`;
}
