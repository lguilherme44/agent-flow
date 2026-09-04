import type { JSX } from 'react';
import { AlertTriangle, Clock, Timer, User } from 'lucide-react';
import type {
  ArtifactView,
  RunDetailView,
  StageViewResponse,
  TaskSummaryView,
} from '@contracts/index.js';
import type { TelemetryResponse } from '../lib/api';
import { Panel, SectionHeader, cx } from '../components/ui';
import { EscalationBanner, IsolationStrip, StagePipeline, hasIsolationToShow } from './run-overview';
import {
  ApprovalCard,
  ArtifactsCard,
  ExecutionSummaryCard,
  ModelUsageCard,
} from './bottom-cards';
import { formatDuration, formatWhen } from '../lib/format';

/**
 * The Overview surface (M8.5 §15, §17).
 *
 * **Everything the run header stopped saying, and everything the old bottom band said
 * permanently.** The pipeline with its nine durations, the isolation facts, the run's
 * escalation and degradations, the artifacts, the approval gate, the execution summary
 * and the model spend — one surface, reachable in one click, absent from the screen the
 * rest of the time.
 *
 * The ordering is §15's: summary first, details after. What happened to the run comes
 * before what it produced, because a person who opens this tab has already read the
 * header and wants the next layer down — and because an escalation is the one thing here
 * that can be urgent.
 *
 * **Nothing here is derived.** Every card was already rendering a server projection and
 * still is; this file moves where they are drawn and changes nothing about what decides
 * them. The escalation is the run's own record, the isolation facts are the read model's,
 * and the four cards each take a response object whole.
 */
export function RunSummary(props: {
  run: RunDetailView;
  stages: StageViewResponse[] | undefined;
  tasks: readonly TaskSummaryView[];
  artifacts: ArtifactView[] | undefined;
  telemetry: TelemetryResponse | undefined;
  projectId: string | undefined;
  onOpenArtifact: (name: string) => void;
}): JSX.Element {
  const { run } = props;
  const isolated = hasIsolationToShow(run.isolation, run.integrationConflicts);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
      {/* The two banners the header used to stack above the board. They are detail behind
          an attention row that already said the headline, so this is where a reader goes
          once the summary has made them want the counters, the repairs and the evidence. */}
      {run.runtime.escalation === undefined ? null : (
        <EscalationBanner escalation={run.runtime.escalation} />
      )}

      {run.degradationDetail.length === 0 ? null : (
        <ul className="flex shrink-0 flex-col gap-1 rounded-md border border-warning/25 bg-warning-soft px-2.5 py-2">
          {run.degradationDetail.map((degradation) => (
            <li key={`${degradation.kind}:${degradation.reason}`} className="flex gap-2">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
              <div className="flex min-w-0 flex-col">
                <span className="text-body-lg text-text">{degradation.reason}</span>
                <span className="text-label text-muted">{degradation.impact}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Panel
        className="shrink-0"
        divided
        header={<SectionHeader title="Pipeline" />}
      >
        <div className="px-3 pb-3 pt-2.5">
          {props.stages === undefined ? (
            <p className="text-label text-muted">The stage timeline could not be read.</p>
          ) : (
            <StagePipeline stages={props.stages} />
          )}
        </div>

        {/* The facts that used to sit between the header and the pipeline. A hairline on
            the same surface rather than a card of its own — §21.2 is facts about the run,
            not a second widget. */}
        {isolated ? (
          <IsolationStrip
            isolation={run.isolation}
            conflicts={run.integrationConflicts}
            degradations={run.degradationDetail}
          />
        ) : null}

        {/* The two the header dropped. `Started by` is a constant in local mode and
            `Today at 19:34` is the run's birthday — neither changes while a person
            watches, which is exactly what disqualified them from the always-visible layer
            and exactly what makes them fine here.

            **The task count is not among them, and that is a duplicate this composition
            found.** It came down from the old header's four-fact row, and it landed a few
            hundred pixels above `Execution summary`, which already reports
            `Tasks completed 3 / 9` with a bar — while the run header says `3/9 tasks` on
            every surface. Three statements of one number, two of them on this screen. The
            two that survive are the one that is always visible and the one that has a
            progress bar beside it. */}
        <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-2.5 text-body-lg text-muted">
          <Fact icon={<User className="h-3.5 w-3.5" />} label="Started by" value="you" />
          <Divider />
          <Fact icon={<Clock className="h-3.5 w-3.5" />} label="Started" value={formatWhen(run.startedAt)} />
          <Divider />
          <Fact
            icon={<Timer className="h-3.5 w-3.5" />}
            label="Duration"
            value={formatDuration(run.durationMs)}
          />
        </dl>
      </Panel>

      {/* **Two columns below 1280, four above** — and the reason is measured rather than
          aesthetic. At 1024 four cards leave each one 167px of content, and the DOM
          clipping instrument reports two casualties: the `Model usage` card's own `<h2>`
          ellipsised at 87px in an 85px box, and an artifact row reading
          `Architecture Impac…` at 114px in 100px. A card whose own name does not fit is
          not a narrow card, it is a broken one. */}
      <div className={cx('grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4')}>
        <ArtifactsCard artifacts={props.artifacts} onOpen={props.onOpenArtifact} />
        <ApprovalCard run={run} projectId={props.projectId} />
        <ExecutionSummaryCard run={run} tasks={[...props.tasks]} />
        <ModelUsageCard telemetry={props.telemetry} />
      </div>
    </div>
  );
}

function Fact(props: { icon: JSX.Element; label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-faint" aria-hidden>
        {props.icon}
      </span>
      <dt className="text-faint">{props.label}</dt>
      <dd className="tabular text-text">{props.value}</dd>
    </div>
  );
}

function Divider(): JSX.Element {
  return <span className="h-3 w-px bg-border-strong" aria-hidden />;
}
