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
import { RunHeader, StagePipeline, TaskMetrics } from '../features/run-overview';
import { TaskTable } from '../features/task-table';
import { TaskInspector } from '../features/task-inspector';
import {
  ApprovalCard,
  ArtifactsCard,
  ExecutionSummaryCard,
  ModelUsageCard,
} from '../features/bottom-cards';
import { Empty } from '../components/ui';

/**
 * Run Detail (UI-20) — the composition of the reference.
 *
 *   Run Header
 *   Stage Pipeline
 *   Task Metrics
 *   Task Table  |  Task Inspector (480px)
 *   Artifacts | Approval | Execution Summary | Model Usage
 *
 * The grid is fixed-width for the inspector and fluid for the table, so at
 * 1440×900 the table keeps its columns and nothing overflows. Everything below
 * the header scrolls inside its own region rather than the page — a dashboard
 * whose header scrolls away is one where you lose track of which run you are
 * looking at.
 */
export function RunDetailPage(): JSX.Element {
  const { runId } = useParams<{ runId: string }>();
  const { projectId } = useProjectSelection();

  const [selectedTask, setSelectedTask] = useState<string | undefined>(undefined);
  const [openArtifact, setOpenArtifact] = useState<string | undefined>(undefined);

  const run = useRun(projectId, runId);
  const stages = useStages(projectId, runId);
  const tasks = useTasks(projectId, runId);
  const artifacts = useArtifacts(projectId, runId);
  const telemetry = useTelemetry(projectId, runId);
  const task = useTask(projectId, runId, selectedTask);

  // Selecting a task that a later plan no longer contains would leave the
  // inspector showing a task the run does not have.
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
      <RunHeader run={run.data} />

      {stages.data === undefined ? null : <StagePipeline stages={stages.data} />}

      <TaskMetrics tasks={tasks.data ?? []} />

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_var(--af-inspector-width)] gap-3">
        <TaskTable
          tasks={tasks.data ?? []}
          selectedId={selectedTask}
          onSelect={setSelectedTask}
        />
        <TaskInspector task={task.data} />
      </div>

      {/* Fixed height, equal across the four — the reference composition has a
          flat bottom edge, and letting cards size to content makes it ragged.
          Each card scrolls its own overflow rather than clipping it. */}
      <div className="grid h-[196px] shrink-0 grid-cols-4 gap-3">
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
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 flex h-[80vh] w-[min(900px,90vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-surface">
          <header className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
            <DialogPrimitive.Title className="text-body font-medium">
              {artifact.data?.label ?? props.name ?? 'Artifact'}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close className="rounded-sm p-1 text-muted hover:bg-surface-2 hover:text-text">
              <X className="h-4 w-4" aria-label="Close" />
            </DialogPrimitive.Close>
          </header>

          <div className="min-h-0 flex-1 overflow-auto p-3">
            {artifact.data === undefined ? (
              <Empty title={artifact.isLoading ? 'Loading…' : 'Not available.'} />
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-label text-muted">
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
