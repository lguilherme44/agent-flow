import { useMemo } from 'react';
import type { RunDagView } from '@contracts/index.js';
import { taskTone } from '../../lib/tone';
import { useT, word } from '../../lib/i18n';
import { Empty } from '../../components/ui';

/**
 * The plan's dependency graph, coloured by the state at the playhead.
 *
 * Structure comes from `/dag`, which derives it from the plan through the same `core/dag`
 * the scheduler runs on. The browser lays out what it is given — columns by depth, rows by
 * plan order — and never recomputes what may run. Nothing is dropped: a filter would leave
 * a chain with a hole in it, and a hole describes a dependency that does not exist.
 */

const NODE_W = 240;
const NODE_H = 52;
const COL_GAP = 44;
const ROW_GAP = 14;
const PAD = 12;

/**
 * How much title fits, derived from the box rather than guessed at.
 *
 * The node used to be 150px wide and the title cut at 12 characters, which turned
 * "Promote webview_flutter_android to a direct dependency" into "Promote web…" — a label
 * that distinguishes nothing from its neighbours, in a view whose whole job is telling
 * nodes apart. Widening the box without widening the cut would have kept the ellipsis and
 * added whitespace, so the cut is computed from the width: change `NODE_W` and the title
 * follows.
 *
 * The per-character widths are the measured ones from the original note — the title is
 * 10.5px monospace and the state 9px — kept as constants so the arithmetic is visible
 * instead of folded into a magic number.
 */
const TITLE_CHAR_PX = 6.3;
const STATE_CHAR_PX = 5.4;
const STATE_CHARS = 10;
const LEFT_PAD = 12;
const RIGHT_PAD = 8;
const TITLE_CHARS = Math.floor(
  (NODE_W - LEFT_PAD - RIGHT_PAD - STATE_CHARS * STATE_CHAR_PX) / TITLE_CHAR_PX,
);

export interface GraphProps {
  readonly dag: RunDagView | undefined;
  readonly rows: readonly { readonly id: string; readonly title: string }[];
  readonly stateOf: (id: string) => string | undefined;
  readonly selected: string | undefined;
  readonly onSelect: (id: string | undefined) => void;
  readonly error?: Error;
}

export function Graph({ dag, rows, stateOf, selected, onSelect, error }: GraphProps) {
  const t = useT();
  const layout = useMemo(() => {
    if (dag === undefined) return undefined;
    const order = new Map(rows.map((row, index) => [row.id, index]));
    const columns = new Map<number, string[]>();
    for (const node of dag.nodes) {
      const list = columns.get(node.depth) ?? [];
      list.push(node.taskId);
      columns.set(node.depth, list);
    }
    // Where each node's dependencies sit, so a column can be ordered against the one
    // before it rather than against the plan alone.
    const parentsOf = new Map<string, string[]>();
    for (const edge of dag.edges) {
      parentsOf.set(edge.to, [...(parentsOf.get(edge.to) ?? []), edge.from]);
    }

    const positions = new Map<string, { x: number; y: number }>();
    const rowOf = new Map<string, number>();
    let maxRows = 0;
    const depths = [...columns.keys()].sort((a, b) => a - b);

    depths.forEach((depth, columnIndex) => {
      const ids = columns.get(depth) ?? [];

      /**
       * Rows ordered by where a node's dependencies already sit — the barycentre
       * heuristic, and the reason this is not plain plan order.
       *
       * Plan order put TASK-004 in row 1 of its column while both of its dependencies sat
       * in row 0 of theirs, so its edges crossed every edge above them. The reader then
       * has to trace a line to answer "what does this wait on", which is the one question
       * the view exists to answer at a glance.
       *
       * The mean row of a node's parents is where its edges would like it to be. Sorting
       * by that puts each node opposite what feeds it; plan order breaks ties and carries
       * any node whose parents are not placed yet, so the result is still deterministic.
       * One pass, left to right: a column is ordered against columns already positioned,
       * never against one that is not.
       */
      const barycentre = (id: string): number => {
        const rows = (parentsOf.get(id) ?? [])
          .map((parent) => rowOf.get(parent))
          .filter((row): row is number => row !== undefined);
        if (rows.length === 0) return Number.POSITIVE_INFINITY;
        return rows.reduce((sum, row) => sum + row, 0) / rows.length;
      };

      const ordered = [...ids].sort((a, b) => {
        const difference = barycentre(a) - barycentre(b);
        if (difference !== 0 && Number.isFinite(difference)) return difference;
        return (order.get(a) ?? 0) - (order.get(b) ?? 0);
      });

      maxRows = Math.max(maxRows, ordered.length);
      ordered.forEach((id, rowIndex) => {
        rowOf.set(id, rowIndex);
        positions.set(id, {
          x: PAD + columnIndex * (NODE_W + COL_GAP),
          y: PAD + rowIndex * (NODE_H + ROW_GAP),
        });
      });
    });
    return {
      positions,
      width: PAD * 2 + depths.length * NODE_W + Math.max(0, depths.length - 1) * COL_GAP,
      height: PAD * 2 + maxRows * NODE_H + Math.max(0, maxRows - 1) * ROW_GAP,
    };
  }, [dag, rows]);

  if (error !== undefined) return <Empty error>{t.graph.couldNotRead}</Empty>;
  if (dag === undefined || layout === undefined) return <Empty>{t.graph.reading}</Empty>;
  if (dag.nodes.length === 0) return <Empty hint={t.graph.appearsAfterPlanning}>{t.graph.noTasks}</Empty>;

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
          <span className="notice__k">{word(t, dag.invalid.kind)}</span>
          <span>{dag.invalid.message}</span>
        </div>
      ) : null}
      {dag.unresolved.length > 0 ? (
        <div className="notice" data-tone="warn" style={{ marginBottom: 12 }}>
          <span className="notice__k">{t.graph.unresolved}</span>
          <span>
            {dag.unresolved.map((entry) => t.graph.dependsOnMissing(entry.taskId, entry.dependsOn)).join('; ')}
          </span>
        </div>
      ) : null}
      <div style={{ overflowX: 'auto' }}>
        <svg className="graph__svg" width={layout.width} height={layout.height} role="img" aria-label={t.graph.aria}>
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
            const short =
              title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS - 1)}…` : title;
            const stateWord = state === undefined ? '' : word(t, state).slice(0, STATE_CHARS);
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
                <title>{`${node.taskId} · ${title}${state === undefined ? '' : ` · ${word(t, state)}`}`}</title>
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
