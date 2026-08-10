import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import type { RunSummaryView } from '@contracts/index.js';
import { useProjectSelection } from '../app/project-context';
import { useProjects, useRuns } from '../lib/queries';
import {
  Empty,
  Panel,
  Progress,
  SearchInput,
  SectionHeader,
  Select,
  StatusDot,
  Tooltip,
  cx,
} from '../components/ui';
import { formatDuration, formatWhenCompact, humanise } from '../lib/format';
import { stagesPresent } from '../lib/stages';
import { TONE_BG, TONE_TEXT, runLabel, runTone } from '../lib/status';

/**
 * Runs (UI-21, §79) — history that can actually be navigated.
 *
 * A table, not a grid of cards. Nine runs as nine bordered rectangles is the
 * pattern the dashboard redesign removed: the point of a history is scanning it,
 * and cards make every row the same weight so there is nothing to scan.
 *
 * Three things about the state here, because the spec is specific about it (§88):
 *
 *   - **The rows come from the server.** No `RunState` lives in this component,
 *     and nothing is recomputed — progress and duration arrive already numbers,
 *     so this list and the run detail cannot round them differently.
 *   - **Status, stage and search are local.** They are questions about this
 *     screen, they belong to this screen, and none of them is worth a round trip.
 *   - **Project is not.** It is the app's scope: the sidebar sets it, the
 *     breadcrumb reads it, the dashboard resolves a run from it. A second,
 *     page-local notion of "which project" would be a second answer to a question
 *     that already has one, so the filter drives the shared selection instead.
 */

type StatusFilter = 'all' | RunSummaryView['status'];

const STATUS_OPTIONS: readonly { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'running', label: 'Running' },
  { value: 'waiting_for_approval', label: 'Waiting approval' },
  { value: 'approved', label: 'Approved' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'plan_rejected', label: 'Plan rejected' },
];

export function RunsPage(): JSX.Element {
  const { projectId, select } = useProjectSelection();
  const projects = useProjects();
  const runs = useRuns(projectId);

  const [status, setStatus] = useState<StatusFilter>('all');
  const [stage, setStage] = useState<string>('all');
  const [query, setQuery] = useState('');

  const all = runs.data ?? [];
  const visible = useMemo(() => filterRuns(all, { status, stage, query }), [
    all,
    status,
    stage,
    query,
  ]);

  const stageOptions = useMemo(
    () => [
      { value: 'all', label: 'All stages' },
      ...stagesPresent(all.map((run) => run.stage)).map((entry) => ({
        value: entry,
        label: humanise(entry),
      })),
    ],
    [all],
  );

  const projectOptions = useMemo(
    () => [
      { value: '', label: 'All projects' },
      ...(projects.data ?? []).map((project) => ({ value: project.id, label: project.name })),
    ],
    [projects.data],
  );

  return (
    <Panel
      className="h-full"
      divided
      header={
        <SectionHeader title="Runs">
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            <SearchInput
              label="Search runs"
              value={query}
              placeholder="run id or feature"
              onChange={setQuery}
              className="max-w-56 flex-1"
            />
            <Select
              label="Project"
              value={projectId ?? ''}
              options={projectOptions}
              onChange={(value) => {
                select(value === '' ? undefined : value);
              }}
            />
            <Select label="Status" value={status} options={STATUS_OPTIONS} onChange={setStatus} />
            <Select label="Stage" value={stage} options={stageOptions} onChange={setStage} />
          </div>
        </SectionHeader>
      }
    >
      <RunsBody
        runs={visible}
        total={all.length}
        showProject={projectId === undefined}
        state={
          runs.isError
            ? { kind: 'error', message: messageOf(runs.error) }
            : runs.data === undefined
              ? { kind: 'loading', pending: runs.isLoading }
              : { kind: 'ready' }
        }
      />
    </Panel>
  );
}

type LoadState =
  | { kind: 'error'; message: string | undefined }
  | { kind: 'loading'; pending: boolean }
  | { kind: 'ready' };

function RunsBody(props: {
  runs: RunSummaryView[];
  total: number;
  showProject: boolean;
  state: LoadState;
}): JSX.Element {
  if (props.state.kind === 'error') {
    return (
      <Empty
        title="Runs could not be read."
        hint={
          props.state.message ??
          'The server answered, but not with a run list. Check the terminal running agent-flow ui.'
        }
      />
    );
  }

  if (props.state.kind === 'loading') {
    return <Empty title={props.state.pending ? 'Loading runs…' : 'Nothing to show.'} />;
  }

  if (props.total === 0) {
    return (
      <Empty
        title="No runs yet."
        hint={
          <>
            Start one with <code className="font-mono">agent-flow feature &quot;…&quot;</code>
          </>
        }
      />
    );
  }

  if (props.runs.length === 0) {
    return <Empty title="Nothing matches these filters." hint="Clear one of them to see more." />;
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {/* Fixed layout, and Feature is the only column without a width — the same
          reason the task table is fixed. The auto algorithm hands the widths to
          whichever cell holds the longest unbreakable string, which here is a run
          id, and the feature title is what people are reading. */}
      <table className="w-full table-fixed border-collapse text-body">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-b border-border text-micro uppercase tracking-wide text-faint">
            {/* Fixed widths measured against the longest real value in each
                column, not guessed. Status is the widest because
                "WAITING FOR APPROVAL" is a status this tool genuinely has, and a
                status chip that reads "WAITING FOR…" is not a status.
                Stage and Duration drop below 1280, where the feature title needs
                the space more than either: the stage is on the run's own page and
                the duration is recoverable from the two timestamps. */}
            <Th className="w-[124px] pl-4">Run</Th>
            <Th>Feature</Th>
            <Th className="hidden w-[118px] xl:table-cell">Stage</Th>
            <Th className="w-[176px]">Status</Th>
            <Th className="w-[118px]">Progress</Th>
            <Th className="w-[116px]">Started</Th>
            <Th className="hidden w-[64px] pr-4 text-right xl:table-cell">Duration</Th>
          </tr>
        </thead>
        <tbody>
          {props.runs.map((run) => (
            <RunRow key={`${run.projectId}:${run.runId}`} run={run} showProject={props.showProject} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunRow(props: { run: RunSummaryView; showProject: boolean }): JSX.Element {
  const { run } = props;
  const tone = runTone(run.status);

  return (
    <tr className="border-b border-border/70 hover:bg-surface-2">
      <Td className="pl-4">
        <span className="flex items-center gap-1.5">
          {/* The whole row is a link target in spirit, but only the id is one in
              fact: a row-level anchor would swallow the text selection people use
              to copy a feature name out of a list. */}
          <Link
            to={`/runs/${run.runId}`}
            className="tabular whitespace-nowrap text-label font-medium text-text hover:text-primary-bright"
          >
            {run.runId}
          </Link>

          {/* Degradations sit beside the id rather than beside the status, and
              that is a correctness point, not a taste one: crowded into the
              status cell they pushed the longest status labels into an ellipsis,
              so a badge about a run's honesty was costing the run's state. It
              also matches the wrench the task table puts next to a corrective
              task — a mark on the identifier, saying "there is a caveat here". */}
          {run.degradations > 0 ? (
            <Tooltip
              content={
                <span>
                  {run.degradations} capabilit{run.degradations === 1 ? 'y was' : 'ies were'}{' '}
                  lost during this run. Open it to see which.
                </span>
              }
            >
              <span className="inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-warning-soft px-1 text-micro font-medium text-warning">
                <AlertTriangle className="h-3 w-3" aria-hidden />
                {run.degradations}
                <span className="sr-only"> degradations</span>
              </span>
            </Tooltip>
          ) : null}
        </span>
      </Td>

      <Td>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-label text-text" title={run.feature}>
            {run.feature}
          </span>
          <span className="truncate text-micro text-faint">
            {props.showProject ? run.projectId : `${String(run.taskCount)} tasks`}
          </span>
        </span>
      </Td>

      <Td className="hidden xl:table-cell">
        <span className="truncate text-label text-muted">{humanise(run.stage)}</span>
      </Td>

      <Td>
        {/* The same chip the task table uses, so a status means one thing in both
            places — colour plus word, never colour alone (§97). */}
        <span
          className={cx(
            'inline-flex max-w-full items-center gap-1 rounded-sm px-1.5 py-px text-micro font-medium',
            TONE_BG[tone],
            TONE_TEXT[tone],
          )}
        >
          <StatusDot
            tone={tone}
            label={runLabel(run.status)}
            decorative
            solid={run.status === 'completed'}
            spin={run.status === 'running'}
            className="h-3 w-3"
          />
          <span className="truncate">{runLabel(run.status)}</span>
        </span>
      </Td>

      <Td>
        <span className="flex items-center gap-2">
          <Progress
            value={run.progress}
            tone={
              run.status === 'failed' || run.status === 'plan_rejected' ? 'danger' : 'success'
            }
            className="flex-1"
            label={`${run.runId} progress`}
          />
          <span className="tabular w-10 shrink-0 text-right text-micro text-muted">
            {run.completedTasks}/{run.taskCount}
          </span>
        </span>
      </Td>

      <Td className="tabular truncate text-label text-muted">
        {formatWhenCompact(run.createdAt)}
      </Td>
      <Td className="tabular hidden pr-4 text-right text-label text-muted xl:table-cell">
        {formatDuration(run.durationMs)}
      </Td>
    </tr>
  );
}

function Th(props: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <th scope="col" className={cx('px-2 py-1.5 text-left font-medium', props.className)}>
      {props.children}
    </th>
  );
}

function Td(props: { children: ReactNode; className?: string }): JSX.Element {
  return <td className={cx('px-2 py-2', props.className)}>{props.children}</td>;
}

function messageOf(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

/**
 * Status, stage and free text, applied together (§79).
 *
 * Search covers the run id and the feature, which are the two things somebody
 * remembers about a run they are trying to find again. Exported so the filtering
 * can be tested without rendering a table.
 */
export function filterRuns(
  runs: readonly RunSummaryView[],
  filter: { status: StatusFilter; stage: string; query: string },
): RunSummaryView[] {
  const needle = filter.query.trim().toLowerCase();

  return runs.filter((run) => {
    if (filter.status !== 'all' && run.status !== filter.status) return false;
    if (filter.stage !== 'all' && run.stage !== filter.stage) return false;
    if (needle === '') return true;

    return (
      run.runId.toLowerCase().includes(needle) || run.feature.toLowerCase().includes(needle)
    );
  });
}
