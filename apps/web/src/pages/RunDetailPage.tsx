import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
      <RunPanel run={run.data} stages={stages.data} projectId={projectId} />

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
        ) : null}
      </div>

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
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <DialogPrimitive.Content
          // A label rather than the task's own title. The panel already states
          // the id and the title as its heading, and a hidden copy of them here
          // would make a screen reader read the task twice before reaching it.
          aria-label="Task inspector"
          // Radix does not set this: it hides everything else with `aria-hidden`
          // instead, which is the more widely supported of the two techniques.
          // Both are stated here — the hiding is what actually contains a screen
          // reader, and this is what §97 and every ARIA dialog example expect to
          // find on the panel itself.
          aria-modal="true"
          // Radix's modal Dialog overrides its own focus restore to focus a
          // `Dialog.Trigger`, and this drawer has none — it opens because a task
          // got selected, not because a button was pressed. Left alone, closing
          // drops focus on the document body, and a keyboard user loses their
          // place half way down a table they will have to find again.
          onCloseAutoFocus={(event) => {
            const target = opener.current;
            if (target === null || !document.contains(target)) return;
            event.preventDefault();
            target.focus({ preventScroll: true });
          }}
          className="fixed inset-y-0 right-0 z-50 flex w-[min(440px,88vw)] flex-col border-l border-border-strong bg-bg p-3 shadow-2xl"
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
