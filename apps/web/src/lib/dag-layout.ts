import type { RunDagView } from '@contracts/index.js';

/**
 * Where each task is drawn, and what a selection lights up (UI-28).
 *
 * Kept out of the component for two reasons. It is the part most likely to be
 * quietly wrong — a fan-in placed one column too early puts an edge in reverse,
 * which a screenshot shows and an assertion does not — and it is the part that
 * has to survive five hundred nodes without being re-run on every log line.
 *
 * Nothing here decides a dependency. The edges arrive from the server, derived
 * from the plan through `core/dag`; this reads them and works out coordinates.
 * A browser that inferred an edge would be inventing a fact about the run.
 */

/**
 * Node box, and the pitch between columns and rows.
 *
 * The gap between columns is the tunable one, and it is smaller than it looks
 * like it should be. Every pixel of it multiplies by the depth of the plan, and
 * depth is what decides whether the opening view fits: at a 72px gap a seven-deep
 * chain is wider than a 1440 content area and opens clipped at both ends.
 */
export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 64;
export const COLUMN_PITCH = NODE_WIDTH + 60;
export const ROW_PITCH = NODE_HEIGHT + 20;

export interface NodePosition {
  readonly x: number;
  readonly y: number;
}

export interface GraphLayout {
  readonly positions: ReadonlyMap<string, NodePosition>;
  /** Widest column count, so a caller can tell a chain from a fan. */
  readonly widestColumn: number;
  readonly columns: number;
}

/**
 * Columns by depth, rows by barycentre.
 *
 * The columns come from the server's `depth`, which is the longest dependency
 * chain reaching a task — so an edge always points rightwards and never back.
 *
 * Row order is the one heuristic here: within a column, tasks are sorted by the
 * average height of what they depend on. It is a single left-to-right pass, it
 * costs O(V + E), and it is the difference between a fan-in that reads as a
 * funnel and one that reads as a knot. It is not an optimal crossing
 * minimisation and does not need to be — nobody is measuring this graph, they
 * are following a line with their eye.
 */
export function layoutGraph(dag: Pick<RunDagView, 'nodes' | 'edges'>): GraphLayout {
  const positions = new Map<string, NodePosition>();
  if (dag.nodes.length === 0) return { positions, widestColumn: 0, columns: 0 };

  const dependenciesOf = new Map<string, string[]>();
  for (const node of dag.nodes) dependenciesOf.set(node.taskId, []);
  for (const edge of dag.edges) dependenciesOf.get(edge.to)?.push(edge.from);

  const byDepth = new Map<number, string[]>();
  for (const node of dag.nodes) {
    const column = byDepth.get(node.depth);
    if (column === undefined) byDepth.set(node.depth, [node.taskId]);
    else column.push(node.taskId);
  }

  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  let widestColumn = 0;

  for (const depth of depths) {
    const column = byDepth.get(depth) ?? [];
    widestColumn = Math.max(widestColumn, column.length);

    // Every dependency of a task sits in a strictly lower column — that is what
    // `depth` being a longest path guarantees — so their heights are already
    // final by the time this reads them.
    const ordered = column
      .map((taskId, index) => {
        const heights = (dependenciesOf.get(taskId) ?? [])
          .map((dependency) => positions.get(dependency)?.y)
          .filter((y): y is number => y !== undefined);

        return {
          taskId,
          index,
          // A root, or a task whose dependencies were dropped as unresolved,
          // keeps the order the server sent — which is topological, and stable.
          barycentre:
            heights.length === 0
              ? Number.NaN
              : heights.reduce((total, y) => total + y, 0) / heights.length,
        };
      })
      .sort((a, b) => {
        if (Number.isNaN(a.barycentre) && Number.isNaN(b.barycentre)) return a.index - b.index;
        if (Number.isNaN(a.barycentre)) return -1;
        if (Number.isNaN(b.barycentre)) return 1;
        return a.barycentre - b.barycentre || a.index - b.index;
      });

    // Each task wants to sit level with what it depends on, which is what makes
    // a chain draw as a straight line instead of a staircase. Wants are granted
    // top to bottom and pushed apart only where two of them collide, then the
    // whole column is shifted back so a fan-out splits evenly around its parent
    // rather than hanging below it.
    //
    // A column of roots has nothing to be level with, and falls back to centring.
    const wants = ordered.map((entry) =>
      Number.isNaN(entry.barycentre) ? undefined : entry.barycentre,
    );

    let heights: number[];
    if (wants.every((want) => want === undefined)) {
      const offset = (ordered.length - 1) / 2;
      heights = ordered.map((_, row) => (row - offset) * ROW_PITCH);
    } else {
      heights = [];
      for (const [row, want] of wants.entries()) {
        const previous = heights[row - 1];
        const target = want ?? (previous === undefined ? 0 : previous + ROW_PITCH);
        heights.push(previous === undefined ? target : Math.max(target, previous + ROW_PITCH));
      }

      const granted = wants
        .map((want, row) => (want === undefined ? undefined : heights[row]))
        .filter((height): height is number => height !== undefined);
      const asked = wants.filter((want): want is number => want !== undefined);
      const shift = mean(asked) - mean(granted);
      heights = heights.map((height) => height + shift);
    }

    ordered.forEach((entry, row) => {
      positions.set(entry.taskId, {
        x: depth * COLUMN_PITCH,
        y: heights[row] ?? 0,
      });
    });
  }

  return { positions, widestColumn, columns: depths.length };
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

export interface SelectedPath {
  /** Everything the selected task waits for, transitively. */
  readonly ancestors: ReadonlySet<string>;
  /** Everything waiting on it, transitively. */
  readonly descendants: ReadonlySet<string>;
  /** Ancestors ∪ selected ∪ descendants — what stays lit. */
  readonly onPath: ReadonlySet<string>;
}

const EMPTY_PATH: SelectedPath = {
  ancestors: new Set(),
  descendants: new Set(),
  onPath: new Set(),
};

/**
 * What a selected task is connected to.
 *
 * Deliberately *not* a critical path. A critical path is the longest chain
 * through the graph weighted by duration, it answers "what is making this run
 * slow", and it is out of scope for this version (§92). This answers a different
 * and much cheaper question — "what does this task wait for, and what waits on
 * it" — and calling it the other thing would be a claim the view does not
 * support.
 */
export function selectedPath(
  dag: Pick<RunDagView, 'edges'> | undefined,
  taskId: string | undefined,
): SelectedPath {
  if (dag === undefined || taskId === undefined) return EMPTY_PATH;

  const upstream = new Map<string, string[]>();
  const downstream = new Map<string, string[]>();

  const link = (index: Map<string, string[]>, key: string, value: string): void => {
    const existing = index.get(key);
    if (existing === undefined) index.set(key, [value]);
    else existing.push(value);
  };

  for (const edge of dag.edges) {
    link(upstream, edge.to, edge.from);
    link(downstream, edge.from, edge.to);
  }

  const walk = (from: Map<string, string[]>): Set<string> => {
    const seen = new Set<string>();
    const queue = [taskId];

    while (queue.length > 0) {
      const current = queue.pop() as string;
      for (const next of from.get(current) ?? []) {
        // The seen check is what makes a cycle terminate. A plan should never
        // contain one — the server says so when it does — but this view is
        // exactly where somebody looks at the plan that did.
        if (seen.has(next) || next === taskId) continue;
        seen.add(next);
        queue.push(next);
      }
    }

    return seen;
  };

  const ancestors = walk(upstream);
  const descendants = walk(downstream);

  return {
    ancestors,
    descendants,
    onPath: new Set([taskId, ...ancestors, ...descendants]),
  };
}
