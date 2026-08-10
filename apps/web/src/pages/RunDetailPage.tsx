import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useProjectSelection } from '../app/project-context';
import {
  useArtifact,
  useArtifacts,
  useRun,
  useStages,
  useTask,
  useTasks,
  useTelemetry,
} from '../lib/queries';
import { RunPanel } from '../features/run-overview';
import { TaskTable } from '../features/task-table';
import { TaskInspector } from '../features/task-inspector';
import {
  ApprovalCard,
  ArtifactsCard,
  ExecutionSummaryCard,
  ModelUsageCard,
} from '../features/bottom-cards';
import { Empty } from '../components/ui';
import { INSPECTOR_PANE, useMediaQuery } from '../hooks/use-media-query';
import type { TaskDetailView } from '@contracts/index.js';

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

  const [selectedTask, setSelectedTask] = useState<string | undefined>(undefined);
  const [openArtifact, setOpenArtifact] = useState<string | undefined>(undefined);
  const asPane = useMediaQuery(INSPECTOR_PANE);

  const run = useRun(projectId, runId);
  const stages = useStages(projectId, runId);
  const tasks = useTasks(projectId, runId);
  const artifacts = useArtifacts(projectId, runId);
  const telemetry = useTelemetry(projectId, runId);
  const task = useTask(projectId, runId, selectedTask);

  // Selecting a task a later plan no longer contains would leave the inspector
  // showing a task the run does not have.
  useEffect(() => {
    if (selectedTask === undefined || tasks.data === undefined) return;
    if (!tasks.data.some((entry) => entry.id === selectedTask)) setSelectedTask(undefined);
  }, [selectedTask, tasks.data]);

  if (run.isError) {
    return (
      <Empty
        title="That run could not be read."
        hint={run.error instanceof Error ? run.error.message : undefined}
      />
    );
  }

  if (run.data === undefined) {
    return <Empty title={run.isLoading ? 'Loading run…' : 'No run selected.'} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <RunPanel run={run.data} stages={stages.data} />

      {/* Below 1200 the inspector leaves the grid and becomes a drawer (§66).
          Side by side it would take 400px from a table that only has ~740, and
          a task title rendered as "Criar en…" is a table nobody can scan.
          Chosen in JavaScript rather than with `hidden`, so only one inspector
          is ever in the document — see `use-media-query`. */}
      <div
        className={
          asPane
            ? 'grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_var(--af-inspector-width)] gap-3'
            : 'flex min-h-0 flex-1'
        }
      >
        <TaskTable
          tasks={tasks.data ?? []}
          selectedId={selectedTask}
          onSelect={setSelectedTask}
        />
        {asPane ? (
          <TaskInspector
            task={task.data}
            {...(selectedTask === undefined
              ? {}
              : {
                  onClose: () => {
                    setSelectedTask(undefined);
                  },
                })}
          />
        ) : null}
      </div>

      {asPane ? null : (
        <InspectorDrawer
          open={selectedTask !== undefined}
          task={task.data}
          onClose={() => {
            setSelectedTask(undefined);
          }}
        />
      )}

      {/* Token-driven, because height is the scarce axis at 1280×800 and this
          row is the part of the screen that can afford to give some back. */}
      <div className="grid h-bottom shrink-0 grid-cols-4 gap-3">
        <ArtifactsCard artifacts={artifacts.data} onOpen={setOpenArtifact} />
        <ApprovalCard run={run.data} />
        <ExecutionSummaryCard run={run.data} tasks={tasks.data ?? []} />
        <ModelUsageCard telemetry={telemetry.data} />
      </div>

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
 * Hidden above 1200 by CSS rather than by unmounting, so a viewport crossing the
 * boundary keeps its selection instead of closing the panel under the cursor.
 */
function InspectorDrawer(props: {
  open: boolean;
  task: TaskDetailView | undefined;
  onClose: () => void;
}): JSX.Element | null {
  // Escape closes it, because an overlay that traps the reader is worse than no
  // overlay. The listener is scoped to when it is actually open.
  useEffect(() => {
    if (!props.open) return undefined;

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [props]);

  if (!props.open) return null;

  return (
    <>
      <button
        type="button"
        onClick={props.onClose}
        aria-label="Close inspector"
        className="fixed inset-0 z-40 bg-black/60"
      />
      {/* The role goes on the panel, not on a wrapper around it. A wrapper whose
          children are all `fixed` has no size of its own, so the dialog was
          present in the tree and zero pixels tall — which is "hidden" to
          anything that measures, including assistive technology. */}
      <div
        role="dialog"
        aria-label="Task inspector"
        className="fixed inset-y-0 right-0 z-50 flex w-[min(440px,88vw)] flex-col border-l border-border-strong bg-bg p-3 shadow-2xl"
      >
        <TaskInspector task={props.task} onClose={props.onClose} />
      </div>
    </>
  );
}

function ArtifactDialog(props: {
  projectId: string | undefined;
  runId: string | undefined;
  name: string | undefined;
  onClose: () => void;
}): JSX.Element {
  const artifact = useArtifact(props.projectId, props.runId, props.name);

  return (
    <DialogPrimitive.Root
      open={props.name !== undefined}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 flex h-[80vh] w-[min(900px,90vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border-strong bg-surface shadow-2xl">
          <header className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
            <DialogPrimitive.Title className="text-body-lg font-semibold">
              {artifact.data?.label ?? props.name ?? 'Artifact'}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close className="rounded-sm p-1 text-faint hover:bg-surface-2 hover:text-text">
              <X className="h-4 w-4" aria-label="Close" />
            </DialogPrimitive.Close>
          </header>

          <div className="min-h-0 flex-1 overflow-auto bg-sunken p-3">
            {artifact.data === undefined ? (
              <Empty title={artifact.isLoading ? 'Loading…' : 'Not available.'} />
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-micro leading-relaxed text-muted">
                {artifact.data.content}
                {artifact.data.truncated ? '\n\n… truncated' : ''}
              </pre>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
