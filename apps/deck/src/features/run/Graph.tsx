import { useMemo } from 'react';
import type { RunDagView } from '@contracts/index.js';
import { taskTone, words } from '../../lib/tone';
import { Empty } from '../../components/ui';

/**
 * The plan's dependency graph, coloured by the state at the playhead.
 *
 * Structure comes from `/dag`, which derives it from the plan through the same `core/dag`
 * the scheduler runs on. The browser lays out what it is given — columns by depth, rows by
 * plan order — and never recomputes what may run. Nothing is dropped: a filter would leave
 * a chain with a hole in it, and a hole describes a dependency that does not exist.
 */

const NODE_W = 150;
const NODE_H = 46;
const COL_GAP = 24;
const ROW_GAP = 10;
const PAD = 12;

export interface GraphProps {
  readonly dag: RunDagView | undefined;
  readonly rows: readonly { readonly id: string; readonly title: string }[];
  readonly stateOf: (id: string) => string | undefined;
  readonly selected: string | undefined;
  readonly onSelect: (id: string | undefined) => void;
  readonly error?: Error;
}

export function Graph({ dag, rows, stateOf, selected, onSelect, error }: GraphProps) {
  const layout = useMemo(() => {
    if (dag === undefined) return undefined;
    const order = new Map(rows.map((row, index) => [row.id, index]));
    const columns = new Map<number, string[]>();
    for (const node of dag.nodes) {
      const list = columns.get(node.depth) ?? [];
      list.push(node.taskId);
      columns.set(node.depth, list);
    }
    const positions = new Map<string, { x: number; y: number }>();
    let maxRows = 0;
    const depths = [...columns.keys()].sort((a, b) => a - b);
    depths.forEach((depth, columnIndex) => {
      const ids = (columns.get(depth) ?? []).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      maxRows = Math.max(maxRows, ids.length);
      ids.forEach((id, rowIndex) => {
        positions.set(id, { x: PAD + columnIndex * (NODE_W + COL_GAP), y: PAD + rowIndex * (NODE_H + ROW_GAP) });
      });
    });
    return {
      positions,
      width: PAD * 2 + depths.length * NODE_W + Math.max(0, depths.length - 1) * COL_GAP,
      height: PAD * 2 + maxRows * NODE_H + Math.max(0, maxRows - 1) * ROW_GAP,
    };
  }, [dag, rows]);

  if (error !== undefined) return <Empty error>The dependency graph could not be read.</Empty>;
  if (dag === undefined || layout === undefined) return <Empty>Reading the plan…</Empty>;
  if (dag.nodes.length === 0) return <Empty hint="A plan appears here once planning has produced one.">No tasks yet.</Empty>;

  const titles = new Map(rows.map((row) => [row.id, row.title]));
  const hot = new Set<string>();
  if (selected !== undefined) {
    for (const edge of dag.edges) {
      if (edge.from === selected || edge.to === selected) {
        hot.add(edge.from);
        hot.add(edge.to);
      }
    }
  }

  return (
    <div className="graph">
      {dag.invalid !== undefined ? (
        <div className="notice" data-tone="bad" style={{ marginBottom: 12 }}>
          <span className="notice__k">{words(dag.invalid.kind)}</span>
          <span>{dag.invalid.message}</span>
        </div>
      ) : null}
      {dag.unresolved.length > 0 ? (
        <div className="notice" data-tone="warn" style={{ marginBottom: 12 }}>
          <span className="notice__k">unresolved</span>
          <span>
            {dag.unresolved.map((entry) => `${entry.taskId} depends on ${entry.dependsOn}, which the plan does not contain`).join('; ')}
          </span>
        </div>
      ) : null}
      <div style={{ overflowX: 'auto' }}>
        <svg className="graph__svg" width={layout.width} height={layout.height} role="img" aria-label="Task dependency graph">
          {dag.edges.map((edge) => {
            const from = layout.positions.get(edge.from);
            const to = layout.positions.get(edge.to);
            if (from === undefined || to === undefined) return null;
            const x1 = from.x + NODE_W;
            const y1 = from.y + NODE_H / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_H / 2;
            const mx = (x1 + x2) / 2;
            return (
              <path
                key={`${edge.from}-${edge.to}`}
                className="svg-edge"
                data-hot={selected !== undefined && (edge.from === selected || edge.to === selected)}
                d={`M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
              />
            );
          })}
          {dag.nodes.map((node) => {
            const position = layout.positions.get(node.taskId);
            if (position === undefined) return null;
            const state = stateOf(node.taskId);
            const title = titles.get(node.taskId) ?? '';
            // Measured, not guessed: 12 characters of the title at 10.5px and 10 of the state
            // at 9px share the 150px second line with 8px to spare.
            const short = title.length > 12 ? `${title.slice(0, 11)}…` : title;
            const stateWord = state === undefined ? '' : words(state).slice(0, 10);
            const isSelected = selected === node.taskId;
            const dim = selected !== undefined && !isSelected && !hot.has(node.taskId);
            return (
              <g
                key={node.taskId}
                className="svg-node"
                data-tone={taskTone(state)}
                data-selected={isSelected}
                data-dim={dim}
                transform={`translate(${String(position.x)} ${String(position.y)})`}
                onClick={() => onSelect(isSelected ? undefined : node.taskId)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(isSelected ? undefined : node.taskId);
                  }
                }}
                aria-label={`${node.taskId} ${title} ${state ?? ''}`}
              >
                <title>{`${node.taskId} · ${title}${state === undefined ? '' : ` · ${words(state)}`}`}</title>
                <rect className="svg-node__box" width={NODE_W} height={NODE_H} />
                <circle className="svg-node__dot" cx={12} cy={15} r={3.5} />
                <text className="svg-node__id" x={22} y={19} style={node.taskId.startsWith('FIX') ? { fill: 'var(--warn)' } : undefined}>
                  {node.taskId}
                </text>
                <text className="svg-node__title" x={12} y={36}>
                  {short}
                </text>
                <text className="svg-node__state" x={NODE_W - 8} y={36} textAnchor="end">
                  {stateWord}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
