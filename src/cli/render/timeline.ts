import type { RunTimeline } from '../../core/run-timeline.js';
import { en, type Phrases } from '../../core/phrases/index.js';

/**
 * Where a run's wall clock went, as a terminal table.
 *
 * **Rendering only.** Which minute belongs to whom is decided in `core/run-timeline.ts`, so
 * this and the Deck's bar print one answer. What is left here is the shape of the lines.
 *
 * Minutes with one decimal, because the question is "where did five hours go" and seconds
 * are noise at that scale. Cost only beside model and rework, the two rows that spent any,
 * and only when a runner reported it; the stage table says "not reported" rather than
 * printing a zero nobody measured.
 */
export function renderTimeline(timeline: RunTimeline, runId: string, say: Phrases = en): string[] {
  const t = say.timeline;
  const share = (ms: number) =>
    timeline.wallMs === 0 ? '' : `${String(Math.round((ms / timeline.wallMs) * 100)).padStart(3)}%`;
  const usd = (value: number | undefined) => (value === undefined ? '' : `$${value.toFixed(2)}`);

  const rows: [string, number, number | undefined][] = [
    [t.model, timeline.modelMs, timeline.modelCostUsd],
    [t.validation, timeline.validationMs, undefined],
    [t.human, timeline.waitingForHumanMs, undefined],
    [t.quota, timeline.quotaWaitMs, undefined],
    [t.rework, timeline.reworkMs, timeline.reworkCostUsd],
    [t.other, timeline.otherMs, undefined],
  ];
  const width = Math.max(t.wall.length, ...rows.map(([label]) => label.length)) + 2;

  const lines = [
    t.heading(runId),
    `  ${t.wall.padEnd(width)}${minutes(timeline.wallMs).padStart(8)} ${t.minutes}` +
      (timeline.costUsd === undefined ? '' : `   ${usd(timeline.costUsd)}`),
    ...rows.map(
      ([label, ms, cost]) =>
        `  ${label.padEnd(width)}${minutes(ms).padStart(8)}  ${share(ms)}` +
        (cost === undefined ? '' : `   ${usd(cost)}`),
    ),
  ];

  if (timeline.stages.length > 0) {
    const stageWidth = Math.max(t.stage.length, ...timeline.stages.map((row) => row.stage.length)) + 2;
    lines.push(
      '',
      t.byStage,
      `  ${t.stage.padEnd(stageWidth)}${t.attempts.padStart(12)}${t.minutes.padStart(10)}  ${t.cost}`,
      ...timeline.stages.map(
        (row) =>
          `  ${row.stage.padEnd(stageWidth)}${String(row.attempts).padStart(12)}` +
          `${minutes(row.modelMs).padStart(10)}  ` +
          (row.costUsd === undefined ? t.notReported : row.costUsd.toFixed(2)),
      ),
    );
  }

  const notes = [
    ...(timeline.stale === true ? [t.staleNote] : []),
    ...(timeline.quotaWaitMs > 0 ? [t.quotaNote] : []),
    ...(timeline.costUsd === undefined ? [] : [t.notABill]),
  ];
  if (notes.length > 0) lines.push('', ...notes);

  return lines;
}

function minutes(ms: number): string {
  return (ms / 60_000).toFixed(1);
}
