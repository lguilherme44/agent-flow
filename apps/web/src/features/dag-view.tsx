import { memo, useCallback, useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertTriangle, Wrench } from 'lucide-react';
import type { RunDagView, TaskSummaryView } from '@contracts/index.js';
import { Empty, StatusDot, cx } from '../components/ui';
import { formatDuration } from '../lib/format';
import { taskLabel, taskTone, TONE_BG, TONE_BORDER, TONE_TEXT } from '../lib/status';
import { NODE_HEIGHT, NODE_WIDTH, layoutGraph, selectedPath } from '../lib/dag-layout';

/**
 * The dependency graph (§92, UI-28).
 *
 * Two inputs, and keeping them apart is the whole design. `dag` is structure —
 * ids, edges, a column rank — and changes only when the plan does. `tasks` is the
 * same list the table renders and changes every few seconds. The layout is
 * memoised on the structure alone, so a task finishing repaints a node and does
 * not move a single one of the other four hundred and ninety-nine (§96).
 *
 * Nothing here works out what depends on what. The edges come from the server,
 * which derives them from the plan through the same `core/dag` the scheduler runs
 * on. A component that inferred an edge — or decided a task was ready — would be
 * a second scheduler, and it would be the one nobody notices going wrong.
 */

export interface DagViewProps {
  readonly dag: RunDagView | undefined;
  readonly tasks: readonly TaskSummaryView[];
  /** Tasks the panel's filter admits. Everything else is dimmed, never removed. */
  readonly visible: ReadonlySet<string>;
  readonly selectedId: string | undefined;
  readonly onSelect: (taskId: string | undefined) => void;
  readonly isLoading?: boolean;
}

interface TaskNodeData extends Record<string, unknown> {
  readonly task: TaskSummaryView | undefined;
  readonly taskId: string;
  readonly selected: boolean;
  /** How this node relates to the selected one. Drives emphasis, not colour. */
  readonly relation: 'selected' | 'ancestor' | 'descendant' | 'unrelated' | 'none';
  readonly filteredOut: boolean;
}

type TaskNode = Node<TaskNodeData, 'task'>;

export function DagView(props: DagViewProps): JSX.Element {
  const { dag, tasks, selectedId, onSelect } = props;

  // Structure only. `dag` keeps its identity across refetches that return the
  // same JSON — TanStack's structural sharing — so this genuinely does not run
  // when a status changes.
  const layout = useMemo(() => (dag === undefined ? undefined : layoutGraph(dag)), [dag]);
  const path = useMemo(() => selectedPath(dag, selectedId), [dag, selectedId]);

  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  const nodes = useMemo<TaskNode[]>(() => {
    if (dag === undefined || layout === undefined) return [];

    return dag.nodes.map((node) => {
      const position = layout.positions.get(node.taskId) ?? { x: 0, y: 0 };
      const task = byId.get(node.taskId);

      const relation: TaskNodeData['relation'] =
        selectedId === undefined
          ? 'none'
          : node.taskId === selectedId
            ? 'selected'
            : path.ancestors.has(node.taskId)
              ? 'ancestor'
              : path.descendants.has(node.taskId)
                ? 'descendant'
                : 'unrelated';

      return {
        id: node.taskId,
        type: 'task',
        position,
        // Declared, not measured. Every node is the same fixed box, so telling
        // the library up front skips a resize-observer round trip per node —
        // five hundred of them on open — and the flash of unpositioned nodes
        // that goes with it.
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        draggable: false,
        // React Flow puts this on the focusable wrapper, which is what a screen
        // reader lands on when tabbing through the graph. Status is in the words,
        // not only in the colour (§97).
        ariaLabel: describeNode(node.taskId, task, relation),
        ariaRole: 'button',
        data: {
          task,
          taskId: node.taskId,
          selected: node.taskId === selectedId,
          relation,
          filteredOut: !props.visible.has(node.taskId),
        },
      };
    });
  }, [dag, layout, byId, selectedId, path, props.visible]);

  const edges = useMemo<Edge[]>(() => {
    if (dag === undefined) return [];

    return dag.edges.map((edge) => {
      const onPath =
        selectedId !== undefined && path.onPath.has(edge.from) && path.onPath.has(edge.to);

      return {
        id: `${edge.from}->${edge.to}`,
        source: edge.from,
        target: edge.to,
        type: 'smoothstep',
        focusable: false,
        style: {
          stroke: onPath ? 'var(--af-primary-bright)' : 'var(--af-border-strong)',
          strokeWidth: onPath ? 1.6 : 1,
          opacity: selectedId === undefined || onPath ? 1 : 0.28,
        },
      };
    });
  }, [dag, selectedId, path]);

  const select = useCallback(
    (_event: unknown, node: { id: string }) => {
      onSelect(node.id);
    },
    [onSelect],
  );

  // Keyboard selection goes through React Flow's own store: Enter on a focused
  // node selects it there and never reaches `onNodeClick`. Only additions are
  // forwarded — an empty set arrives on mount too, and treating that as a
  // deselect would drop a task chosen in the table before the view was opened.
  const syncSelection = useCallback(
    ({ nodes: selected }: { nodes: { id: string }[] }) => {
      const first = selected[0];
      if (first !== undefined && first.id !== selectedId) onSelect(first.id);
    },
    [onSelect, selectedId],
  );

  if (dag === undefined) {
    return (
      <Empty
        title={props.isLoading === true ? 'Reading the plan…' : 'No dependency graph.'}
        hint={
          props.isLoading === true
            ? undefined
            : 'The graph comes from the plan. This run does not have one yet.'
        }
      />
    );
  }

  if (dag.nodes.length === 0) {
    return (
      <Empty
        title="No tasks to draw."
        hint="Planning produces the tasks and the dependencies between them."
      />
    );
  }

  const large = dag.nodes.length > SPRAWLING;

  /**
   * The opening view, fitted once.
   *
   * Done here rather than through the `fitView` prop for two reasons. The prop
   * re-fits whenever the node array changes, which is every time a task ticks
   * over — the view would jump under the reader's hands while they were looking
   * at it. And the prop's fit is clamped by the component's `minZoom` rather than
   * by the fit options, so a floor set for the opening view would also be a floor
   * on what the reader is allowed to do afterwards.
   */
  const fitOnce = (instance: {
    fitView: (options: Record<string, unknown>) => unknown;
  }): void => {
    void instance.fitView({
      ...FIT_VIEW,
      minZoom: large ? SPRAWLING_ZOOM_FLOOR : LEGIBLE_ZOOM_FLOOR,
    });
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <GraphProblems dag={dag} />

      <div className="min-h-0 flex-1">
        <ReactFlow<TaskNode>
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodeClick={select}
          onSelectionChange={syncSelection}
          onPaneClick={() => {
            onSelect(undefined);
          }}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesFocusable={false}
          onInit={fitOnce}
          // Free, once the reader is driving. The floor above applies to the
          // opening view only — refusing to zoom out at all would take away the
          // one thing zooming out is for.
          minZoom={SPRAWLING_ZOOM_FLOOR}
          maxZoom={1.6}
          // At five hundred nodes the ones off screen are the majority. Rendering
          // them costs a DOM node each and buys nothing (§96).
          onlyRenderVisibleElements={large}
          proOptions={{ hideAttribution: false }}
          // The library ships both palettes and picks by class. Left alone it
          // renders its chrome for a light page, on a page that is not one.
          colorMode="dark"
          className="af-dag"
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--af-border)" />
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>
      </div>
    </div>
  );
}

const FIT_VIEW = { padding: 0.12, maxZoom: 1 };

/**
 * How far the view is allowed to zoom out, and why there are two answers.
 *
 * The opening view is a fit, and a fit is clamped by these. That makes the floor
 * a decision about what "opening the graph" should mean.
 *
 * For a plan of ordinary size it should mean *readable*: nine tasks seven columns
 * deep fit at about a third scale, where a task id is four pixels tall and the
 * whole view answers only "what shape is it". Panning is the right interface for
 * a graph wider than the screen, so the floor keeps the text legible and leaves
 * the rest to panning — with the zoom controls there for anyone who does want the
 * shape.
 *
 * For a five-hundred-task plan there is no legible view of the whole thing, and
 * pretending otherwise would open it clipped with the zoom-out button already
 * disabled. Then seeing the shape is the only thing zooming out is for.
 */
const LEGIBLE_ZOOM_FLOOR = 0.55;
const SPRAWLING_ZOOM_FLOOR = 0.04;
/** Where a plan stops being something you read and starts being something you scan. */
const SPRAWLING = 80;

/**
 * What the plan says that cannot be drawn.
 *
 * Above the graph rather than inside it, because both cases mean the picture is
 * incomplete and a reader has to know that before they trust it. §95: what
 * happened, where, and what it means for the run.
 */
function GraphProblems(props: { dag: RunDagView }): JSX.Element | null {
  const { dag } = props;
  if (dag.invalid === undefined && dag.unresolved.length === 0) return null;

  return (
    <div
      role="status"
      className="mx-3 mt-3 flex shrink-0 flex-col gap-1 rounded-md border border-warning/25 bg-warning-soft px-3 py-2"
    >
      {dag.invalid === undefined ? null : (
        <span className="flex items-start gap-2 text-body-lg text-text">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            This plan’s dependencies form a cycle, so there is no order to draw them in.
            {dag.invalid.cycle === undefined ? null : (
              <span className="font-mono text-micro text-muted"> {dag.invalid.cycle.join(' → ')}</span>
            )}
          </span>
        </span>
      )}
      {dag.unresolved.length === 0 ? null : (
        <span className="flex items-start gap-2 text-body-lg text-text">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            {dag.unresolved.length === 1
              ? '1 dependency names a task this plan does not contain, and is not drawn: '
              : `${String(dag.unresolved.length)} dependencies name tasks this plan does not contain, and are not drawn: `}
            <span className="font-mono text-micro text-muted">
              {dag.unresolved
                .slice(0, 4)
                .map((entry) => `${entry.taskId} → ${entry.dependsOn}`)
                .join(', ')}
              {dag.unresolved.length > 4 ? ' …' : ''}
            </span>
          </span>
        </span>
      )}
    </div>
  );
}

/**
 * One task, compact (§92).
 *
 * Id, title, status, complexity, model and duration — and nothing invented. A
 * task the plan describes but nothing has executed has no model and no duration,
 * and says so rather than showing a zero.
 */
const TaskNodeBody = memo(function TaskNodeBody(props: NodeProps<TaskNode>): JSX.Element {
  const { task, taskId, selected, relation, filteredOut } = props.data;
  const state = task?.state ?? 'queued';
  const tone = taskTone(state);

  const muted = filteredOut || relation === 'unrelated';

  return (
    <div
      className={cx(
        'flex h-full w-full cursor-pointer flex-col justify-center gap-1 rounded-md border bg-surface px-2 py-1.5',
        'transition-opacity',
        selected
          ? 'border-primary-bright ring-1 ring-primary-bright'
          : relation === 'ancestor' || relation === 'descendant'
            ? 'border-primary-border'
            : TONE_BORDER[tone],
        muted && 'opacity-30',
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className="af-dag-port" />

      <div className="flex min-w-0 items-center gap-1.5">
        <StatusDot
          tone={tone}
          label={taskLabel(state)}
          decorative
          solid={state === 'completed'}
          spin={state === 'running'}
        />
        <span className="tabular shrink-0 text-micro font-medium text-text">{taskId}</span>
        {task?.correctiveFor === undefined ? null : (
          <Wrench className="h-3 w-3 shrink-0 text-warning" aria-label="corrective task" />
        )}
        <span
          className={cx(
            'ml-auto shrink-0 rounded-sm px-1 py-px text-[10px] font-medium leading-tight',
            TONE_BG[tone],
            TONE_TEXT[tone],
          )}
        >
          {taskLabel(state)}
        </span>
      </div>

      <span className="truncate text-label leading-tight text-text" title={task?.title ?? taskId}>
        {task?.title ?? taskId}
      </span>

      <span className="flex items-center gap-1.5 truncate text-[10px] leading-tight text-faint">
        <span className="capitalize">{task?.complexity ?? 'unknown'}</span>
        <span aria-hidden>·</span>
        <span className="truncate">{task?.model ?? task?.runner ?? 'no model yet'}</span>
        {task?.durationMs === undefined ? null : (
          <>
            <span aria-hidden>·</span>
            <span className="tabular shrink-0">{formatDuration(task.durationMs)}</span>
          </>
        )}
      </span>

      <Handle type="source" position={Position.Right} isConnectable={false} className="af-dag-port" />
    </div>
  );
});

const NODE_TYPES = { task: TaskNodeBody };

/** The accessible name of a node: everything the box says, in words. */
function describeNode(
  taskId: string,
  task: TaskSummaryView | undefined,
  relation: TaskNodeData['relation'],
): string {
  const parts = [
    taskId,
    task?.title ?? 'unknown task',
    taskLabel(task?.state ?? 'queued').toLowerCase(),
  ];

  if (task?.complexity !== undefined) parts.push(task.complexity);
  if (task?.model !== undefined) parts.push(task.model);
  if (task?.durationMs !== undefined) parts.push(formatDuration(task.durationMs));

  if (relation === 'ancestor') parts.push('the selected task depends on this');
  if (relation === 'descendant') parts.push('depends on the selected task');

  return parts.join(', ');
}
