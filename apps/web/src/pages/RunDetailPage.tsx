import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Minimize2, X } from 'lucide-react';
import { useProjectSelection } from '../app/project-context';
import { useGlobalTaskSelection } from '../app/task-selection-context';
import {
  useArtifact,
  useArtifacts,
  useCollaboration,
  useRun,
  useRunDag,
  useStages,
  useTask,
  useTasks,
  useTelemetry,
} from '../lib/queries';
import { RunPanel } from '../features/run-overview';
import { NO_FILTER, TaskTable, filterTasks, type TaskFilter } from '../features/task-table';
import { TaskInspector } from '../features/task-inspector';
import {
  ApprovalCard,
  ArtifactsCard,
  ExecutionSummaryCard,
  ModelUsageCard,
} from '../features/bottom-cards';
import { CollaborationPanel } from '../features/collaboration';
import { Empty, Notice, cx } from '../components/ui';
import { StructuredPlanView } from '../components/StructuredPlanView';
import { ArtifactReader } from '../components/ArtifactReader';
import { ApiError } from '../lib/api';
import { INSPECTOR_PANE, useMediaQuery } from '../hooks/use-media-query';
import type { TaskDetailView } from '@contracts/index.js';

/**
 * The graph arrives when somebody asks for it.
 *
 * It brings a rendering library with it — a third of the bundle — and the table
 * is what opens by default. §96 asks for a first paint under a second and a half,
 * and the cheapest way to keep that is not to ship the part nobody has opened.
 */
const DagView = lazy(async () => ({ default: (await import('../features/dag-view')).DagView }));

/**
 * Run detail (UI-20) — the composition of the reference.
 *
 *   Run panel: hero + connected pipeline, one surface
 *   Tasks panel (with its metric strip in the header)  |  Inspector
 *   Artifacts | Approval | Execution summary | Model usage
 *
 * Three bands, not six. The first pass had the run, the pipeline and five metric
 * cards as separate rows of boxes above the table, which pushed the table — the
 * thing people actually read — into the bottom third of the screen.
 *
 * Everything below the run panel scrolls inside its own region rather than the
 * page: a dashboard whose header scrolls away is one where you lose track of
 * which run you are looking at.
 */
export function RunDetailPage(props: { runId?: string } = {}): JSX.Element {
  const params = useParams<{ runId: string }>();
  const runId = props.runId ?? params.runId;
  const { projectId } = useProjectSelection();
  const { setSelectedTaskId } = useGlobalTaskSelection();

  const [selectedTask, setSelectedTask] = useState<string | undefined>(undefined);
  const [openArtifact, setOpenArtifact] = useState<string | undefined>(undefined);
  // One filter, both views. Lifted here rather than owned by the table, because
  // narrowing the table and leaving the graph showing everything would be two
  // answers to the question the filter asks.
  const [filter, setFilter] = useState<TaskFilter>(NO_FILTER);
  const asPane = useMediaQuery(INSPECTOR_PANE);

  // Sync selected task to global breadcrumb
  useEffect(() => {
    setSelectedTaskId(selectedTask);
    return () => {
      setSelectedTaskId(undefined);
    };
  }, [selectedTask, setSelectedTaskId]);

  // Which rendering is open lives in the URL, so it survives a reload and can be
  // linked to. It is a *view* of one page rather than a route of its own: the
  // graph and the table share the run, the filter and the selection, and moving
  // between them must not feel like navigating away (§88 — local UI state).
  const [search, setSearch] = useSearchParams();
  const asGraph = search.get('view') === 'dag';

  // Focus Mode (Phase C): in-place expanded workspace mode that collapses secondary cards
  const [isFocusMode, setIsFocusMode] = useState(false);
  // DAG Fullscreen (Phase D): true fullscreen overlay for graph navigation
  const [isDagFullscreen, setIsDagFullscreen] = useState(false);

  // Esc key exits Focus Mode or Fullscreen DAG
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isDagFullscreen) {
          setIsDagFullscreen(false);
        } else if (isFocusMode) {
          setIsFocusMode(false);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isFocusMode, isDagFullscreen]);

  const run = useRun(projectId, runId);
  const stages = useStages(projectId, runId);
  const tasks = useTasks(projectId, runId);
  const artifacts = useArtifacts(projectId, runId);
  const telemetry = useTelemetry(projectId, runId);
  const task = useTask(projectId, runId, selectedTask);
  // Fetched only when the graph is open. Structure is cheap to serve and free to
  // skip, and a table nobody has switched away from should not pay for it.
  const dag = useRunDag(projectId, runId, { enabled: asGraph });
  // M4-07. One query for all four parts, matching the one endpoint: a thread's status and
  // an entry's status are folds over logs that have to be read at one instant.
  const collaboration = useCollaboration(projectId, runId);
  const hasCollaboration =
    (collaboration.data?.threads.length ?? 0) > 0 || (collaboration.data?.entries.length ?? 0) > 0;

  // Selecting a task a later plan no longer contains would leave the inspector
  // showing a task the run does not have.
  useEffect(() => {
    if (selectedTask === undefined || tasks.data === undefined) return;
    if (!tasks.data.some((entry) => entry.id === selectedTask)) {
      setSelectedTask(undefined);
    }
  }, [selectedTask, tasks.data]);

  const visible = useMemo(
    () => filterTasks(tasks.data ?? [], filter),
    [tasks.data, filter],
  );

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

  return (
    <div className="dashboard-grid h-full min-h-0">
      <div className="section-overview surface-1 p-0 flex flex-col">
        <RunPanel
          run={run.data}
          stages={stages.data}
          projectId={projectId}
          asGraph={asGraph}
          onToggleGraph={() => {
            const next = new URLSearchParams(search);
            if (asGraph) next.delete('view');
            else next.set('view', 'dag');
            setSearch(next, { replace: true });
          }}
          isFocusMode={isFocusMode}
          onToggleFocusMode={() => setIsFocusMode((prev) => !prev)}
        />
      </div>

      <div className={cx("section-dag surface-1 overflow-hidden flex flex-col", isDagFullscreen && asGraph ? 'fixed inset-0 z-50 p-4 gap-3' : '')}>
        {isDagFullscreen && asGraph ? (
          <div className="glass flex h-12 shrink-0 items-center justify-between border-b border-glass-border px-4 rounded-lg shadow-md">
            <div className="flex items-center gap-3 min-w-0">
              <span className="font-bold text-title tabular text-text">{run.data.runId}</span>
              <span className="text-body-lg text-muted truncate max-w-lg">{run.data.feature}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-micro text-faint">Press Esc to exit</span>
              <button
                type="button"
                onClick={() => setIsDagFullscreen(false)}
                aria-label="Exit fullscreen DAG"
                className="flex h-7 items-center gap-1.5 rounded-md border border-glass-border bg-surface-2/60 px-2.5 text-label text-muted transition-colors hover:border-border hover:text-text"
              >
                <Minimize2 className="h-3.5 w-3.5" aria-hidden />
                <span>Exit Fullscreen</span>
              </button>
            </div>
          </div>
        ) : null}
        
        <TaskTable
          tasks={tasks.data ?? []}
          selectedId={selectedTask}
          onSelect={setSelectedTask}
          filter={filter}
          onFilterChange={setFilter}
          isFocusMode={isFocusMode}
          onToggleFocusMode={() => {
            setIsFocusMode((prev) => !prev);
          }}
          {...(asGraph
            ? {
                graph: (
                  <Suspense fallback={<Empty title="Loading the graph…" />}>
                    <DagView
                      dag={dag.data}
                      tasks={tasks.data ?? []}
                      visible={new Set(visible.map((t) => t.id))}
                      selectedId={selectedTask}
                      onSelect={setSelectedTask}
                      isLoading={dag.isLoading}
                      isDagFullscreen={isDagFullscreen}
                      onToggleFullscreen={() => {
                        setIsDagFullscreen((prev) => !prev);
                      }}
                    />
                  </Suspense>
                ),
              }
            : {})}
        />
      </div>

      {asPane && (!asGraph || selectedTask !== undefined) ? (
        <div className="section-agents surface-1 overflow-hidden flex flex-col">
          <TaskInspector
            task={task.data}
            projectId={projectId}
            runId={runId}
            {...(selectedTask === undefined
              ? {}
              : {
                  onClose: () => {
                    setSelectedTask(undefined);
                  },
                })}
          />
        </div>
      ) : null}

      {asPane ? null : (
        <InspectorDrawer
          open={selectedTask !== undefined}
          task={task.data}
          projectId={projectId}
          runId={runId}
          onClose={() => {
            setSelectedTask(undefined);
          }}
        />
      )}

      {asGraph || isFocusMode ? null : (
        <div className="section-logs surface-1 p-0 overflow-hidden">
          <div className="flex h-full min-h-0 flex-col gap-3 p-3">
            {/* **Two columns below 1280, four above** — and the reason is measured
                rather than aesthetic. At 1024 four cards leave each one 167px of
                content, and the DOM clipping instrument reports two casualties: the
                `Model usage` card's own `<h2>` ellipsised at 87px in an 85px box, and
                an artifact row reading `Architecture Impac…` at 114px in 100px. A card
                whose own name does not fit is not a narrow card, it is a broken one.
                A 2px nudge to the gap would have silenced the heading and left the
                artifact label clipped; the row was designed at 1440 and simply has too
                many columns for the widths below it. */}
            <div className="grid shrink-0 grid-cols-2 gap-3 xl:grid-cols-4">
              <ArtifactsCard artifacts={artifacts.data} onOpen={setOpenArtifact} />
              <ApprovalCard run={run.data} projectId={projectId} />
              <ExecutionSummaryCard run={run.data} tasks={tasks.data ?? []} />
              <ModelUsageCard telemetry={telemetry.data} />
            </div>
            {/* A second row rather than a fifth column, and only when there is something
                in it. Five cards at this width would leave each 240px, which is not
                enough for a message; and a permanently empty fifth card on every
                dashboard would be a box for a feature that ships off. So a project that
                has not opted in sees exactly the row it saw before M4. */}
            {hasCollaboration ? (
              <CollaborationPanel collaboration={collaboration.data}  />
            ) : null}
          </div>
        </div>
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
 * The inspector as a drawer, for 1024–1199 (§66).
 *
 * A real overlay rather than a narrower column: at these widths there is no
 * width to share, and shrinking the panel would only move the damage into the
 * table. Rendered by the same `TaskInspector` the wide layout uses, so the two
 * cannot drift — the drawer supplies a surface, not a second inspector.
 *
 * Above 1200 it is not rendered at all: `RunDetailPage` chooses pane or drawer in
 * JavaScript, so exactly one inspector is ever in the document. A CSS-hidden
 * second copy is invisible to the eye and entirely present to a screen reader,
 * which would then find two panels describing the same task.
 *
 * The modal behaviour is Radix's rather than hand-rolled (UI-P01). The previous
 * version had an overlay, an Escape listener and one inspector — everything
 * except the parts that are genuinely hard: `aria-modal`, a focus trap, and
 * returning focus to the row that opened it. Tab used to walk straight out of the
 * drawer into the table underneath, which is still visible and, to a keyboard,
 * still there. Radix also marks everything outside the panel `aria-hidden`, which
 * is what makes "one dialog" true for assistive technology and not just for the
 * DOM.
 */
function InspectorDrawer(props: {
  open: boolean;
  task: TaskDetailView | undefined;
  projectId: string | undefined;
  runId: string | undefined;
  onClose: () => void;
}): JSX.Element {
  const opener = useRef<HTMLElement | null>(null);

  // Captured in a layout effect, which runs during the commit — before the
  // passive effect inside Radix that moves focus into the panel. In a plain
  // `useEffect` this reads the close button, because child effects run first.
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
          className="glass fixed inset-y-0 right-0 z-50 flex w-[min(440px,88vw)] flex-col border-l border-glass-border p-3 shadow-lg"
        >
          {/* Radix derives the accessible name from a `Title` when one exists,
              and from `aria-label` otherwise. Both are given the same words, so
              the name is stable whichever path a reader takes. */}
          <DialogPrimitive.Title className="sr-only">Task inspector</DialogPrimitive.Title>
          <TaskInspector
            task={props.task}
            projectId={props.projectId}
            runId={props.runId}
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
            'fixed left-1/2 top-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-glass-border bg-surface shadow-lg transition-all duration-150',
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
              <div className="min-h-0 h-full overflow-auto p-3 bg-sunken">
                <StructuredPlanView rawContent={artifact.data.content} />
              </div>
            ) : (
              <ArtifactReader
                content={artifact.data.content}
                name={props.name}
                label={artifact.data.label}
                isExpanded={isExpanded}
                onToggleExpand={() => setIsExpanded((prev) => !prev)}
                truncated={artifact.data.truncated}
              />
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
