import {
  AlertTriangle,
  Clock,
  GitBranch,
  GitMerge,
  ListTree,
  Split,
  Timer,
  User,
} from 'lucide-react';
import type {
  IsolationDetailView,
  IntegrationConflictView,
  RunDetailView,
  StageViewResponse,
  TaskSummaryView,
} from '@contracts/index.js';
import { Badge, Button, Progress, StatusDot, Tooltip, cx } from '../components/ui';
import { useHorizontalOverflow } from '../hooks/use-horizontal-overflow';
import { RunActions } from './run-actions';
import { formatDuration, formatPercent, formatWhen, humanise } from '../lib/format';
import { TONE_BG, TONE_TEXT, runLabel, runTone, stageTone } from '../lib/status';

/**
 * The run, as one surface (§70, §71).
 *
 * Header and pipeline live in the same panel with a hairline between them,
 * because they answer one question together: what is this run and how far has it
 * got. The first pass made them two bordered cards, which read as two unrelated
 * widgets that happened to be stacked.
 *
 * This is the hero of the screen. The run id is the largest type on the page at
 * 24px, the feature title sits beside it rather than under it, and the metadata
 * is a single row of icon-and-value pairs — the composition the reference uses,
 * and the reason it reads as a tool rather than as a report.
 */
export function RunPanel(props: {
  run: RunDetailView;
  stages: StageViewResponse[] | undefined;
  projectId: string | undefined;
  asGraph: boolean;
  onToggleGraph: () => void;
}): JSX.Element {
  return (
    <section className="relative shrink-0 overflow-visible rounded-lg border border-border bg-surface">
      <RunHeader
        run={props.run}
        projectId={props.projectId}
        asGraph={props.asGraph}
        onToggleGraph={props.onToggleGraph}
      />
      {/* Between the header and the pipeline, because it belongs to neither: the
          header says what this run is, the pipeline says how far it got, and this
          says *how* it is being executed. Hairline-separated on the same surface
          rather than a card of its own — §21.2 is facts about the run, not a
          second widget. */}
      <IsolationStrip isolation={props.run.isolation} conflicts={props.run.integrationConflicts} />
      {props.stages === undefined ? null : (
        <div className="border-t border-border px-4 py-3">
          <StagePipeline stages={props.stages} />
        </div>
      )}
    </section>
  );
}

/**
 * Whether this run has anything to say about how it isolates its tasks.
 *
 * A sequential run whose configuration agrees with it, asking for one task at a
 * time, is the default and says nothing — printing `isolation: none` on every run
 * would be the tool describing machinery its user never turned on, and §21.2's
 * failure semantics ask for omission over invention in the same spirit.
 *
 * Three things break that silence, and each is a question a person actually asks:
 * an isolated run has a branch and a merge count nothing else reports; a clamp is
 * the answer to "why is this still running one task at a time"; and a `note` is
 * §21.4's case — the run's mode and the current configuration disagree, and
 * without the sentence the tool looks broken to the one user who did exactly what
 * the documentation said.
 */
export function hasIsolationToShow(
  isolation: IsolationDetailView | undefined,
  conflicts: readonly IntegrationConflictView[] = [],
): boolean {
  if (isolation === undefined) return false;

  return (
    isolation.mode === 'worktree' ||
    isolation.parallelism.clamped ||
    isolation.note !== undefined ||
    conflicts.length > 0
  );
}

/**
 * §21.2 as one row: mode, parallelism, integration branch, tasks integrated.
 *
 * **Ref names and object ids only.** A worktree path is a machine fact the
 * attempt artifact deliberately does not store (§7.2) and the read model
 * deliberately does not resolve (§21.3), so there is nothing here to leak — and
 * this component takes ids and strings from the server rather than composing any
 * of them, because merge logic and Git live on the server (I-8).
 *
 * `tasksIntegrated` is shown for an isolated run and only there. In worktree mode
 * `completed` means integrated (I-3), so this is how many tasks have their work
 * *on the branch* rather than how many agents finished — a distinction the
 * header's own task count cannot make.
 */
function IsolationStrip(props: {
  isolation: IsolationDetailView | undefined;
  conflicts: readonly IntegrationConflictView[];
}): JSX.Element | null {
  const { isolation } = props;
  if (isolation === undefined || !hasIsolationToShow(isolation, props.conflicts)) return null;

  const { parallelism } = isolation;
  const isolated = isolation.mode === 'worktree';

  return (
    <div className="flex flex-col gap-2 border-t border-border px-4 py-2.5">
      <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body-lg text-muted">
        <Fact
          icon={<Split className="h-3.5 w-3.5" />}
          label="Isolation"
          value={isolation.mode}
        />
        <Divider />
        {/* Both numbers when they differ, one when they do not. "4" and "1" are
            different facts, and a reader who saw only the configured one would
            plan around it. */}
        <Fact
          icon={<ListTree className="h-3.5 w-3.5" />}
          label="Tasks at once"
          value={
            parallelism.clamped
              ? `${String(parallelism.effective)} of ${String(parallelism.requested)}`
              : String(parallelism.effective)
          }
        />

        {isolated ? (
          <>
            <Divider />
            <Fact
              icon={<GitMerge className="h-3.5 w-3.5" />}
              label="Integrated"
              value={String(isolation.tasksIntegrated)}
            />
          </>
        ) : null}

        {isolation.integrationBranch === undefined ? null : (
          <>
            <Divider />
            {/* A ref name, which §26.1 rule 4 permits in a response and §19.3
                prints for the person who has to merge it. Monospace because it is
                something to copy, truncated because it can be 60 characters. */}
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="text-faint" aria-hidden>
                <GitBranch className="h-3.5 w-3.5" />
              </span>
              <dt className="text-faint">Branch</dt>
              <dd
                className="min-w-0 truncate font-mono text-label text-text"
                title={isolation.integrationBranch}
              >
                {isolation.integrationBranch}
              </dd>
            </div>
          </>
        )}

        {isolation.integrationHead === undefined ? null : (
          <>
            <Divider />
            <div className="flex items-center gap-1.5">
              <dt className="text-faint">Head</dt>
              <dd
                className="tabular font-mono text-label text-text"
                title={isolation.integrationHead}
              >
                {isolation.integrationHead.slice(0, 8)}
              </dd>
            </div>
          </>
        )}
      </dl>

      {/* §21.4. The reduction and the disagreement are two different sentences
          and both are on the record: one says the number could not be honoured,
          the other says which of two settings applies to this run. */}
      {parallelism.reason === undefined ? null : (
        <p className="text-label text-muted">{parallelism.reason}</p>
      )}
      {isolation.note === undefined ? null : (
        <p className="flex items-start gap-2 text-label text-warning">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{isolation.note}</span>
        </p>
      )}

      {/* §15, from the event the integrator wrote. The paths are
          repository-relative, which is exactly why they may be shown (§21.3). */}
      {props.conflicts.length === 0 ? null : (
        <ul className="flex flex-col gap-1 rounded-md border border-danger/25 bg-danger-soft px-2.5 py-2">
          {props.conflicts.map((conflict) => (
            <li key={`${conflict.task}:${String(conflict.attempt)}`} className="flex gap-2">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-danger" aria-hidden />
              <div className="flex min-w-0 flex-col">
                <span className="text-body-lg text-text">
                  {conflict.task} attempt {conflict.attempt} conflicted with the integration branch
                </span>
                <span className="truncate font-mono text-micro text-muted" title={conflict.paths.join(', ')}>
                  {conflict.paths.join(', ')}
                </span>
                {conflict.previouslyIntegrated === undefined ? null : (
                  <span className="text-label text-muted">
                    {conflict.previouslyIntegrated} integrated first and moved the head — usually the
                    answer to why.
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RunHeader(props: {
  run: RunDetailView;
  projectId: string | undefined;
  asGraph: boolean;
  onToggleGraph: () => void;
}): JSX.Element {
  const { run } = props;

  return (
    <header className="flex flex-col gap-2.5 px-4 pb-3 pt-3.5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          {/* One line, always. Wrapping pushed the feature under the run id and
              cost the header a row of height for no information. */}
          <div className="flex min-w-0 items-center gap-2.5">
            <h1 className="tabular shrink-0 text-hero font-bold tracking-tight">{run.runId}</h1>
            <Badge tone={runTone(run.status)} caps className="shrink-0 px-2 py-0.5 text-label">
              {runLabel(run.status)}
            </Badge>
            {/* Regular weight, not medium. The run id carries the hierarchy by
                size *and* weight, as the reference does; matching the title's
                weight to it made two competing headlines on one line. Full text
                colour, though — secondary is not the same as dim, and this is
                the only place the feature is named. */}
            <span className="min-w-0 truncate text-title font-normal text-text" title={run.feature}>
              {run.feature}
            </span>
          </div>

          {/* One row, hairline-separated. Six stacked label/value pairs was the
              same information at four times the height. */}
          <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body-lg text-muted">
            {/* Dropped below 1440, where the row would otherwise wrap and cost
                the table 20px. It is also the least informative of the four:
                in local mode it always says "you". */}
            <span className="hidden items-center gap-4 wide:flex">
              <Fact icon={<User className="h-3.5 w-3.5" />} label="Started by" value="you" />
              <Divider />
            </span>
            <Fact icon={<Clock className="h-3.5 w-3.5" />} value={formatWhen(run.startedAt)} />
            <Divider />
            <Fact
              icon={<Timer className="h-3.5 w-3.5" />}
              label="Duration"
              value={formatDuration(run.durationMs)}
            />
            <Divider />
            <Fact
              icon={<ListTree className="h-3.5 w-3.5" />}
              label="Tasks"
              value={`${String(run.completedTasks)} / ${String(run.taskCount)}`}
            />
          </dl>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {/* Narrower below 1440. Every pixel this cluster gives up goes to the
              feature title, which is the one thing here that cannot be
              recovered from anywhere else on the screen. */}
          <div className="flex w-40 flex-col gap-1 wide:w-52">
            <div className="flex items-baseline justify-between">
              <span className="text-micro uppercase tracking-caps text-faint">
                Overall progress
              </span>
              <span className="tabular text-body-lg font-medium text-text">
                {formatPercent(run.progress)}
              </span>
            </div>
            {/* Green, as the reference has it. Progress is a quantity, not a
                status — and purple is spoken for: it marks the running step of
                the pipeline, which only reads as special while nothing else
                shares it. */}
            <Progress
              value={run.progress}
              tone={
                run.status === 'failed' || run.status === 'plan_rejected'
                  ? 'danger'
                  : 'success'
              }
              label="Overall progress"
            />
          </div>

          <div className="flex items-center gap-1.5">
            {/* Labels collapse to icons below 1440, where the title needs the
                width more than these need their words. The word stays in the
                tooltip and in the accessible name.

                A toggle, not a destination: the graph and the table are two
                renderings of the same task list, with the same filter and the
                same selection, so leaving the page to see one of them would be
                the thing that loses the reader's place. */}
            <Button
              variant={props.asGraph ? 'primary' : 'surface'}
              onClick={props.onToggleGraph}
              title={props.asGraph ? 'Back to the task table' : 'Show the tasks as a graph'}
              pressed={props.asGraph}
            >
              <GitBranch className="h-3.5 w-3.5" aria-hidden />
              <span className="sr-only wide:not-sr-only">View as DAG</span>
            </Button>

            {/* Real now, and driven by where the run is: a Start button on an
                unapproved plan is a button whose only outcome is a refusal, and
                offering it teaches people to ignore the gate. */}
            <RunActions projectId={props.projectId} run={run} />
          </div>
        </div>
      </div>

      {/* Degradations are not a footnote. A run that reviewed itself, ran below
          its configured effort, or had its gate forced reached its verdict on
          weaker terms, and this is where somebody reads the verdict. */}
      {run.degradationDetail.length === 0 ? null : (
        <ul className="flex flex-col gap-1 rounded-md border border-warning/25 bg-warning-soft px-2.5 py-2">
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
    </header>
  );
}

function Fact(props: { icon: JSX.Element; label?: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-faint" aria-hidden>
        {props.icon}
      </span>
      {props.label === undefined ? null : (
        <dt className="text-faint">{props.label}</dt>
      )}
      <dd className="tabular text-text">{props.value}</dd>
    </div>
  );
}

function Divider(): JSX.Element {
  return <span className="h-3 w-px bg-border-strong" aria-hidden />;
}

/**
 * A connected stepper, not nine cards (§71).
 *
 * The change that matters most on this screen. Nine equal filled rectangles read
 * as a collection of widgets; the eye has to be told this is a *sequence*, and a
 * connector between nodes is what does that in one glance.
 *
 * Each step is an outlined chip on the page ground rather than a lifted surface,
 * so colour marks status without painting a block. The running step is the one
 * exception: it gets a purple border and a soft fill, because "where is this run
 * right now" is the single most-asked question on the page.
 *
 * Nothing here decides a status. The server derives the timeline from the run's
 * own record; a display that computed it would be a second state machine, and it
 * would be the wrong one.
 */
export function StagePipeline(props: { stages: StageViewResponse[] }): JSX.Element {
  const { ref, overflow } = useHorizontalOverflow();

  return (
    // The fades are the affordance (UI-P02). Scrolling sideways is right at
    // these widths, but a row whose last chip ends flush at the edge reads as
    // finished, and then nobody looks for the four stages behind it. Driven by
    // measurement, so a short pipeline that fits gets no fade at all.
    <div className="relative">
      {/* Scrolls sideways below 1440 rather than compressing. Nine steps across
          780px give each chip 53px of text, and "Architecture" needs 62 — so the
          labels clipped at every narrow width. A stepper you can push is still a
          stepper; a stepper whose labels are shaved is not readable at all. */}
      <ol
        ref={ref}
        className="flex items-stretch overflow-x-auto pb-0.5 wide:overflow-visible"
        aria-label="Pipeline"
      >
        {props.stages.map((stage, index) => (
          <StageStep
            key={stage.stage}
            stage={stage}
            last={index === props.stages.length - 1}
          />
        ))}
      </ol>

      {/* Page-ground gradients, not scrollbars. A custom scrollbar is furniture
          at every width; this appears only where content is genuinely hidden and
          costs nothing when it is not. */}
      {overflow.left ? <Fade side="left" /> : null}
      {overflow.right ? <Fade side="right" /> : null}
    </div>
  );
}

/** One step of the pipeline: chip, status, duration, and the connector after it. */
function StageStep(props: { stage: StageViewResponse; last: boolean }): JSX.Element {
  const { stage } = props;
  const tone = stageTone(stage.status);
  const running = stage.status === 'running';
  const pending = stage.status === 'pending';

  const detail = [
    stage.runner === undefined ? undefined : `runner ${stage.runner}`,
    stage.model === undefined ? undefined : `model ${stage.model}`,
    stage.reasoning === undefined ? undefined : `effort ${stage.reasoning}`,
    stage.attempts === undefined || stage.attempts <= 1
      ? undefined
      : `${String(stage.attempts)} attempts`,
    stage.errorCode === undefined ? undefined : `error ${stage.errorCode}`,
  ].filter((value): value is string => value !== undefined);

  return (
    <li
      // The running step is wider. Partly because it is the answer to
      // "where is this run right now" and deserves the emphasis, and
      // partly because "Implementation" is the longest single unbreakable
      // word in the pipeline and an equal share clips it.
      className={cx(
        'flex items-stretch',
        // A floor wide enough for the longest label, then flexible above
        // it. Without the floor `min-w-0` lets the chips shrink to
        // nothing and the labels clip instead of the row scrolling.
        // 132px is what "Implementation" needs beside its marker at 12px.
        // Measured, not guessed: at 116 the running step — the one the
        // eye goes to first — read "Implementati".
        'min-w-[132px] wide:min-w-0',
        running ? 'flex-[1.4]' : 'flex-1',
      )}
    >
      <Tooltip
        content={
          <span>
            {humanise(stage.stage)} — {stage.status.replace(/_/g, ' ')}
            {detail.length === 0 ? '' : ` · ${detail.join(' · ')}`}
          </span>
        }
      >
        <div
          className={cx(
            // Tight padding and a small gap, because nine steps across
            // ~1180px leave each chip about 130px and "Implementation" is
            // a single unbreakable word that needs nearly all of it.
            'flex min-w-0 flex-1 cursor-default items-center gap-1.5 rounded-md border px-1.5 py-1.5',
            running
              ? 'border-primary-border bg-primary-soft'
              : pending
                ? 'border-border bg-transparent'
                : cx('border-border', TONE_BG[tone]),
          )}
        >
          <StatusDot
            tone={tone}
            label={stage.status.replace(/_/g, ' ')}
            // A step with no duration prints its status underneath, and
            // then this marker is decoration; a step with a duration
            // prints that instead, so the marker carries the status.
            {...(stage.durationMs === undefined
              ? { decorative: true }
              : { showLabel: false })}
            // Solid when running, too — and this is the whole accent fix. The
            // running step is what the One Violet Rule exists to mark, and it
            // was getting a 16% wash while full-strength violet sat on the
            // wordmark and the active nav item. `solid` with the `primary` tone
            // resolves to `bg-primary`: the only full-strength violet on the
            // page besides the wordmark, and the only one that means "right now".
            solid={stage.status === 'completed' || running}
            spin={running}
          />
          <span className="flex min-w-0 flex-col">
            {/* Wraps to a second line rather than truncating. Nine steps
                across 1200px cannot all fit on one line, and
                "Architectu…" beside "Implemen…" is a pipeline nobody can
                read — the reference wraps for exactly this reason. */}
            <span
              className={cx(
                'line-clamp-2 text-label leading-tight',
                running ? 'font-medium text-text' : pending ? 'text-muted' : 'text-text',
              )}
              title={humanise(stage.stage)}
            >
              {humanise(stage.stage)}
            </span>
            <span className={cx('tabular text-micro', running ? TONE_TEXT[tone] : 'text-faint')}>
              {stage.durationMs === undefined
                ? stage.status === 'pending'
                  ? 'pending'
                  : stage.status.replace(/_/g, ' ')
                : formatDuration(stage.durationMs)}
            </span>
          </span>
        </div>
      </Tooltip>

      {/* The connector. Everything else here could be a widget; this is
          what makes the row a flow. */}
      {props.last ? null : (
        <span className="flex w-2 shrink-0 items-center" aria-hidden>
          <span className="h-px w-full bg-border-strong" />
        </span>
      )}
    </li>
  );
}

/**
 * The edge gradient that says "there is more this way".
 *
 * `from-surface` because the pipeline sits inside the run panel, not on the page
 * ground — a fade to the wrong colour is a grey smear rather than an edge.
 */
function Fade(props: { side: 'left' | 'right' }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cx(
        'pointer-events-none absolute inset-y-0 w-10',
        props.side === 'left'
          ? 'left-0 bg-gradient-to-r from-surface to-transparent'
          : 'right-0 bg-gradient-to-l from-surface to-transparent',
      )}
    />
  );
}

/**
 * The five counts of §72, as a strip rather than a row of boxes.
 *
 * `waiting` deliberately gathers everything that is neither done, moving, nor
 * broken — queued, ready, blocked, needing review. A run stalled on a blocked
 * task is waiting for a person, and giving that its own column would leave the
 * strip summing to less than the total.
 */
export interface TaskCounts {
  total: number;
  completed: number;
  running: number;
  waiting: number;
  failed: number;
}

export function countTasks(tasks: readonly TaskSummaryView[]): TaskCounts {
  const counts: TaskCounts = {
    total: tasks.length,
    completed: 0,
    running: 0,
    waiting: 0,
    failed: 0,
  };

  for (const task of tasks) {
    switch (task.state) {
      case 'completed':
        counts.completed += 1;
        break;
      case 'running':
        counts.running += 1;
        break;
      case 'failed':
        counts.failed += 1;
        break;
      default:
        counts.waiting += 1;
    }
  }

  return counts;
}
