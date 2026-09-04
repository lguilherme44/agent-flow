import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useProjectSelection } from '../app/project-context';
import { useGlobalTaskSelection } from '../app/task-selection-context';
import {
  useArtifact,
  useArtifacts,
  useCollaboration,
  useControl,
  useDelivery,
  useTeam,
  useReview,
  useRun,
  useRunDag,
  useStages,
  useTask,
  useTasks,
  useTelemetry,
} from '../lib/queries';
import { RunHeader } from '../features/run-overview';
import { RunSummary } from '../features/run-summary';
import { Board } from '../features/board';
import { AttentionStrip } from '../features/attention';
import {
  NO_FILTER,
  TaskTable,
  TaskToolbar,
  filterTasks,
  type TaskFilter,
} from '../features/task-table';
import { TaskInspector } from '../features/task-inspector';
import { CollaborationPanel } from '../features/collaboration';
import { TeamPanel } from '../features/team';
import { ReviewPanel } from '../features/review';
import { DeliveryPanel } from '../features/delivery';
import {
  RunTabs,
  availableSurfaces,
  defaultSurface,
  isTaskSurface,
  paramsForSurface,
  surfaceFromParams,
  type RunSurface,
} from '../features/run-tabs';
import { Empty, Notice, cx } from '../components/ui';
import { StructuredPlanView } from '../components/StructuredPlanView';
import { ArtifactReader } from '../components/ArtifactReader';
import { ApiError } from '../lib/api';
import { INSPECTOR_PANE, useMediaQuery } from '../hooks/use-media-query';
import type { TaskDetailView, TeamView } from '@contracts/index.js';

/**
 * The graph arrives when somebody asks for it.
 *
 * It brings a rendering library with it — a third of the bundle — and the board is what
 * opens by default. §96 asks for a first paint under a second and a half, and the
 * cheapest way to keep that is not to ship the part nobody has opened.
 */
const DagView = lazy(async () => ({ default: (await import('../features/dag-view')).DagView }));

/**
 * One run (UI-20, M8 §28; M8.5 §4, §10, §17).
 *
 * ```text
 * ┌─────────────────────────────────────────────────────────┐
 * │ run id · status · feature      3/9 · 41m · 50% ▓▓▓  [⏵] │  header, one row
 * ├─────────────────────────────────────────────────────────┤
 * │ P1  The plan is waiting for approval      Review it →   │  only when it exists
 * ├─────────────────────────────────────────────────────────┤
 * │ Board  Graph  Tasks  Overview  Review  Team    [filter] │  tabs
 * ├──────────────────────────────────────┬──────────────────┤
 * │                                      │                  │
 * │   the surface, filling the viewport  │    inspector     │
 * │                                      │   on selection   │
 * └──────────────────────────────────────┴──────────────────┘
 * ```
 *
 * **What this replaced, measured rather than described.** The page was a two-column grid
 * with four regions stacked down it: a run panel carrying a hero header, an isolation
 * strip and a nine-step pipeline; the task panel; the inspector; and a band holding four
 * summary cards, the review panel, the delivery panel, the team panel and the
 * collaboration panel. At 1440×900 the document ran to 1753px — the board got 555 of
 * them, with 450px of header above it and 850px below the fold. A third of the page for
 * the thing the page is for, and eight panels permanently open for a person who came to
 * look at one.
 *
 * Nothing left the product. Every panel is a tab, every tab is one click, and a tab whose
 * projection has nothing in it is not rendered at all — the same "absent rather than
 * empty" the panels already applied to themselves, moved up one level so it costs a door
 * rather than a room.
 *
 * **`?panel=` works now, and it never has.** `routeFor` has emitted `?panel=review`,
 * `?panel=delivery`, `?panel=team`, `?panel=quality` and `?panel=approval` since M8, and
 * this page read only `?view=`. Six of the queue's seven destinations arrived at a page
 * that ignored what they asked for. `&task=` was the same: the selection was a `useState`
 * that started `undefined` whatever the URL said, so a deep link to a card opened the run
 * with nothing selected. Both are read below, and the visual suite photographs both.
 *
 * **Focus mode is gone, and it was a workaround for the band that is gone.** It existed to
 * collapse the summary cards and the secondary panels so the tasks could have the screen.
 * The tasks have the screen.
 */
export function RunDetailPage(props: { runId?: string } = {}): JSX.Element {
  const params = useParams<{ runId: string }>();
  const runId = props.runId ?? params.runId;
  const { projectId } = useProjectSelection();
  const { setSelectedTaskId } = useGlobalTaskSelection();

  const [search, setSearch] = useSearchParams();

  // One filter, three surfaces. Lifted here rather than owned by any of them, because
  // narrowing the board and leaving the graph showing everything would be two answers to
  // the question the filter asks.
  const [filter, setFilter] = useState<TaskFilter>(NO_FILTER);
  const [openArtifact, setOpenArtifact] = useState<string | undefined>(undefined);
  const asPane = useMediaQuery(INSPECTOR_PANE);

  /**
   * The selected task, seeded from the URL.
   *
   * `?task=` has been in every task-scoped attention link since M8 and was read by
   * nothing: the queue promised "one place to go" and delivered the run with nothing
   * open. The seed runs once, as the initialiser, so a later click does not fight the
   * address bar — and the URL is not rewritten on selection, because a selection is not
   * a destination and a back button that walked back through eight cards would be worse
   * than one that leaves the run.
   */
  const [selectedTask, setSelectedTask] = useState<string | undefined>(
    () => search.get('task') ?? undefined,
  );

  // Sync selected task to the breadcrumb, which is the only other place it appears.
  useEffect(() => {
    setSelectedTaskId(selectedTask);
    return () => {
      setSelectedTaskId(undefined);
    };
  }, [selectedTask, setSelectedTaskId]);

  const run = useRun(projectId, runId);
  const stages = useStages(projectId, runId);
  const tasks = useTasks(projectId, runId);
  const artifacts = useArtifacts(projectId, runId);
  const telemetry = useTelemetry(projectId, runId);
  const task = useTask(projectId, runId, selectedTask);
  // M8-07. One read for the board, its reasons and the attention strip — and one instant,
  // so the two halves of the screen cannot describe two moments.
  const control = useControl(projectId, runId);
  // M4-07. One query for all four parts, matching the one endpoint: a thread's status and
  // an entry's status are folds over logs that have to be read at one instant.
  const collaboration = useCollaboration(projectId, runId);
  // M5-08. Same shape and same reason: one query for the whole view, because a member's
  // derived status and the assignment that produced it are folds over one log at one
  // instant.
  const team = useTeam(projectId, runId);
  // M6-09. `reviewed` is the server's answer to "did anything review this run", not a
  // count folded here.
  const review = useReview(projectId, runId);
  // M7. Read here as well as inside the panel, because the *tab* has to know whether
  // there is a room behind the door. One query key, so this is the same cached read the
  // panel makes rather than a second request.
  const delivery = useDelivery(projectId, runId);

  const hasCollaboration =
    (collaboration.data?.threads.length ?? 0) > 0 || (collaboration.data?.entries.length ?? 0) > 0;
  const hasTeam = team.data?.configured === true;

  const surfaces = availableSurfaces({
    tasks: (run.data?.taskCount ?? 0) > 0,
    review: review.data?.reviewed === true,
    // The panel's own guard, asked one level up. `disabled` means no forge is configured,
    // which is most runs.
    delivery: delivery.data !== undefined && delivery.data.state !== 'disabled',
    team: hasTeam || hasCollaboration,
  });

  const asked = surfaceFromParams(search);
  // A URL asking for a surface this run does not have — a bookmarked `?view=review` on a
  // run nobody reviewed — falls back rather than rendering a blank region. The address is
  // left alone: rewriting it would turn a stale bookmark into a silently different one.
  const surface: RunSurface =
    asked !== undefined && surfaces.includes(asked) ? asked : defaultSurface(surfaces);

  const selectSurface = (next: RunSurface): void => {
    setSearch(paramsForSurface(search, next), { replace: true });
  };

  // Fetched only when the graph is open. Structure is cheap to serve and free to skip,
  // and a board nobody has switched away from should not pay for it.
  const dag = useRunDag(projectId, runId, { enabled: surface === 'graph' });

  // Built here rather than in the graph, because the graph is lazy-loaded and this is a
  // three-line fold: the last assignment per task wins, since a reassignment appends to
  // the log rather than rewriting it.
  const assignedTo = useMemo(() => {
    const byTask = new Map<string, string>();
    for (const assignment of team.data?.assignments ?? []) {
      byTask.set(assignment.taskId, assignment.agentName);
    }
    return byTask;
  }, [team.data]);

  // Selecting a task a later plan no longer contains would leave the inspector showing a
  // task the run does not have.
  useEffect(() => {
    if (selectedTask === undefined || tasks.data === undefined) return;
    if (!tasks.data.some((entry) => entry.id === selectedTask)) {
      setSelectedTask(undefined);
    }
  }, [selectedTask, tasks.data]);

  const visible = useMemo(() => filterTasks(tasks.data ?? [], filter), [tasks.data, filter]);

  if (run.isError) {
    const missing = run.error instanceof ApiError && run.error.status === 404;
    return (
      <div className="p-4">
        <Notice
          tone="danger"
          title={
            missing
              ? `${runId ?? 'That run'} is not in this project.`
              : `${runId ?? 'That run'} could not be read.`
          }
          detail={run.error instanceof Error ? run.error.message : undefined}
          consequence={
            missing
              ? 'Nothing has stopped: run ids are unique inside a project, and a workspace can hold the same id in more than one.'
              : 'The run itself is unaffected — this is the dashboard failing to read it, not the workflow failing.'
          }
          action={
            missing
              ? 'Pick the project it belongs to in the sidebar, or open it from Runs.'
              : 'Check that the server is still running, then reload.'
          }
        />
      </div>
    );
  }

  if (run.data === undefined) {
    return <Empty title={run.isLoading ? 'Loading run…' : 'No run selected.'} />;
  }

  /**
   * Whether the inspector shares the row, or covers it.
   *
   * **A surface built from fixed-width columns does not share.** The board's lanes are
   * 244px each and there are six of them; giving 400 to a pane leaves 560, which is two
   * lanes and a sliver — photographed at 1200 with `IN PROGRESS` sliced down its middle.
   * The table and the graph are the opposite case: a table reflows its own columns, a
   * canvas refits its own viewport, and both are genuinely better beside the detail than
   * under it, because comparing a row to its log is the reason to open one.
   *
   * So the board gets a drawer at every width and the other two get a pane above 1200.
   * Exactly one inspector is ever in the document either way — chosen here rather than
   * hidden in CSS, because a CSS-hidden second copy is invisible to the eye and entirely
   * present to a screen reader.
   */
  const inspectorInRow =
    asPane && selectedTask !== undefined && (surface === 'tasks' || surface === 'graph');

  const attention = control.data?.attention ?? [];

  return (
    <div className="run-workspace">
      <RunHeader run={run.data} stages={stages.data} projectId={projectId} />

      {/* M8.5 §9. Between the run's identity and its work, because that is the order the
          questions arrive in: what is this, what needs me, what is happening. It renders
          nothing at all on a healthy run — a permanently present empty band would be a box
          teaching people to ignore the place urgent things appear. */}
      {attention.length === 0 ? null : (
        <div className="shrink-0 px-page pt-2.5">
          <AttentionStrip
            items={attention}
            {...(projectId === undefined ? {} : { projectId })}
          />
        </div>
      )}

      <div className="pt-2.5">
        <RunTabs surfaces={surfaces} active={surface} onSelect={selectSurface}>
          {isTaskSurface(surface) ? (
            <TaskToolbar filter={filter} onFilterChange={setFilter} />
          ) : null}
        </RunTabs>
      </div>

      <div className="run-surface-row">
        <div className="run-surface">
          {surface === 'board' ? (
            <Board
              cards={control.data?.cards ?? []}
              lanes={control.data?.lanes ?? []}
              {...(selectedTask === undefined ? {} : { selectedTaskId: selectedTask })}
              onSelect={setSelectedTask}
              filter={filter}
            />
          ) : null}

          {surface === 'graph' ? (
            <Suspense fallback={<Empty title="Loading the graph…" />}>
              <DagView
                dag={dag.data}
                tasks={tasks.data ?? []}
                visible={new Set(visible.map((entry) => entry.id))}
                selectedId={selectedTask}
                onSelect={setSelectedTask}
                assignedTo={assignedTo}
                isLoading={dag.isLoading}
              />
            </Suspense>
          ) : null}

          {surface === 'tasks' ? (
            <TaskTable
              tasks={tasks.data ?? []}
              selectedId={selectedTask}
              onSelect={setSelectedTask}
              filter={filter}
            />
          ) : null}

          {surface === 'overview' ? (
            <RunSummary
              run={run.data}
              stages={stages.data}
              tasks={tasks.data ?? []}
              artifacts={artifacts.data}
              telemetry={telemetry.data}
              projectId={projectId}
              onOpenArtifact={setOpenArtifact}
            />
          ) : null}

          {surface === 'review' ? <ReviewPanel review={review.data} className="min-h-0 flex-1" /> : null}

          {surface === 'delivery' ? <DeliveryPanel projectId={projectId} runId={runId} /> : null}

          {surface === 'team' ? (
            // Team first. It answers "who is doing this", which is the context that makes
            // an open thread legible — "executor.normal is blocked" reads differently once
            // the screen has said which member that is.
            <div
              className={cx(
                'grid min-h-0 flex-1 gap-3 overflow-auto',
                hasTeam && hasCollaboration ? 'xl:grid-cols-2' : 'grid-cols-1',
              )}
            >
              {hasTeam ? <TeamPanel team={team.data} /> : null}
              {hasCollaboration ? (
                <CollaborationPanel collaboration={collaboration.data} />
              ) : null}
            </div>
          ) : null}
        </div>

        {inspectorInRow ? (
          <div className="run-inspector">
            <TaskInspector
              team={team.data}
              task={task.data}
              projectId={projectId}
              runId={runId}
              onClose={() => {
                setSelectedTask(undefined);
              }}
            />
          </div>
        ) : null}
      </div>

      {inspectorInRow ? null : (
        <InspectorDrawer
          open={selectedTask !== undefined}
          task={task.data}
          projectId={projectId}
          runId={runId}
          team={team.data}
          onClose={() => {
            setSelectedTask(undefined);
          }}
        />
      )}

      <ArtifactDialog
        projectId={projectId}
        runId={runId}
        name={openArtifact}
        onClose={() => {
          setOpenArtifact(undefined);
        }}
      />
    </div>
  );
}

/**
 * The inspector as a drawer, below 1200 and on every non-task surface (§66).
 *
 * A real overlay rather than a narrower column: at these widths there is no width to
 * share, and shrinking the panel would only move the damage into the board. Rendered by
 * the same `TaskInspector` the wide layout uses, so the two cannot drift — the drawer
 * supplies a surface, not a second inspector.
 *
 * Exactly one inspector is ever in the document, and that is chosen in JavaScript rather
 * than by hiding one in CSS. A CSS-hidden second copy is invisible to the eye and
 * entirely present to a screen reader, which would then find two panels describing the
 * same task.
 *
 * The modal behaviour is Radix's rather than hand-rolled (UI-P01). The previous version
 * had an overlay, an Escape listener and one inspector — everything except the parts that
 * are genuinely hard: `aria-modal`, a focus trap, and returning focus to the row that
 * opened it. Tab used to walk straight out of the drawer into the table underneath, which
 * is still visible and, to a keyboard, still there. Radix also marks everything outside
 * the panel `aria-hidden`, which is what makes "one dialog" true for assistive technology
 * and not just for the DOM.
 */
function InspectorDrawer(props: {
  open: boolean;
  task: TaskDetailView | undefined;
  projectId: string | undefined;
  runId: string | undefined;
  onClose: () => void;
  /** Threaded through rather than fetched again: one query per run, not per layout. */
  team: TeamView | undefined;
}): JSX.Element {
  const opener = useRef<HTMLElement | null>(null);

  // Captured in a layout effect, which runs during the commit — before the passive effect
  // inside Radix that moves focus into the panel. In a plain `useEffect` this reads the
  // close button, because child effects run first.
  useLayoutEffect(() => {
    if (props.open) opener.current = document.activeElement as HTMLElement | null;
  }, [props.open]);

  return (
    <DialogPrimitive.Root
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" />
        <DialogPrimitive.Content
          aria-label="Task inspector"
          aria-modal="true"
          onCloseAutoFocus={(event) => {
            const target = opener.current;
            if (target === null || !document.contains(target)) return;
            event.preventDefault();
            target.focus({ preventScroll: true });
          }}
          className="fixed inset-y-0 right-0 z-50 flex w-[min(440px,88vw)] flex-col border-l border-border bg-surface p-3 shadow-lg"
        >
          {/* Radix derives the accessible name from a `Title` when one exists, and from
              `aria-label` otherwise. Both are given the same words, so the name is stable
              whichever path a reader takes. */}
          <DialogPrimitive.Title className="sr-only">Task inspector</DialogPrimitive.Title>
          <TaskInspector
            task={props.task}
            projectId={props.projectId}
            runId={props.runId}
            team={props.team}
            onClose={props.onClose}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ArtifactDialog(props: {
  projectId: string | undefined;
  runId: string | undefined;
  name: string | undefined;
  onClose: () => void;
}): JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const artifact = useArtifact(props.projectId, props.runId, props.name);

  return (
    <DialogPrimitive.Root
      open={props.name !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          setIsExpanded(false);
          props.onClose();
        }
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <DialogPrimitive.Content
          className={cx(
            'fixed left-1/2 top-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-surface shadow-lg transition-all duration-150',
            isExpanded ? 'h-[94vh] w-[95vw]' : 'h-[80vh] w-[min(920px,90vw)]',
          )}
        >
          <header className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
            <DialogPrimitive.Title className="text-body-lg font-semibold">
              {artifact.data?.label ?? props.name ?? 'Artifact'}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close className="rounded-sm p-1 text-faint hover:bg-surface-2 hover:text-text">
              <X className="h-4 w-4" aria-label="Close" />
            </DialogPrimitive.Close>
          </header>

          <div className="min-h-0 flex-1 overflow-hidden">
            {artifact.isError ? (
              <div className="p-4">
                <Notice
                  tone={
                    artifact.error instanceof ApiError && artifact.error.status === 404
                      ? 'info'
                      : 'danger'
                  }
                  title={
                    artifact.error instanceof ApiError && artifact.error.status === 404
                      ? 'This run has not produced that artifact.'
                      : 'That artifact could not be read.'
                  }
                  detail={artifact.error instanceof Error ? artifact.error.message : undefined}
                  consequence="The run is unaffected either way — artifacts are written as stages finish."
                />
              </div>
            ) : artifact.data === undefined ? (
              <div className="p-4">
                <Empty title={artifact.isLoading ? 'Loading…' : 'Not available.'} />
              </div>
            ) : props.name === 'plan' && artifact.data.content.trim().startsWith('{') ? (
              <div className="min-h-0 h-full overflow-auto bg-sunken p-3">
                <StructuredPlanView rawContent={artifact.data.content} />
              </div>
            ) : (
              <ArtifactReader
                content={artifact.data.content}
                name={props.name}
                label={artifact.data.label}
                isExpanded={isExpanded}
                onToggleExpand={() => {
                  setIsExpanded((prev) => !prev);
                }}
                truncated={artifact.data.truncated}
              />
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
