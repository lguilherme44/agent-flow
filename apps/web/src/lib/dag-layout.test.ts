import { describe, it, expect } from 'vitest';
import type { RunDagView } from '@contracts/index.js';
import { COLUMN_PITCH, layoutGraph, selectedPath } from './dag-layout';

/**
 * Where the graph puts things, and what a selection lights up (UI-28).
 *
 * These are the parts of the view that a screenshot cannot argue with and a DOM
 * assertion cannot see: a column index, an edge pointing the wrong way, a highlight
 * that stops one hop short.
 */

const graph = (
  nodes: [string, number][],
  edges: [string, string][] = [],
): Pick<RunDagView, 'nodes' | 'edges'> => ({
  nodes: nodes.map(([taskId, depth]) => ({ taskId, depth })),
  edges: edges.map(([from, to]) => ({ from, to })),
});

describe('layoutGraph', () => {
  it('has nothing to place for an empty plan', () => {
    const layout = layoutGraph(graph([]));

    expect(layout.positions.size).toBe(0);
    expect(layout.columns).toBe(0);
  });

  it('keeps a chain straight even when another root shares its first column', () => {
    // The staircase this replaced: TASK-001 sat above centre because FIX-001
    // shared its column, and every task after it drifted back toward the middle
    // one row at a time. A chain has to read as a line.
    const layout = layoutGraph(
      graph(
        [
          ['TASK-001', 0],
          ['FIX-001', 0],
          ['TASK-002', 1],
          ['TASK-003', 2],
        ],
        [
          ['TASK-001', 'TASK-002'],
          ['TASK-002', 'TASK-003'],
        ],
      ),
    );

    const chain = ['TASK-001', 'TASK-002', 'TASK-003'].map(
      (id) => layout.positions.get(id)?.y ?? 0,
    );

    expect(new Set(chain).size).toBe(1);
    expect(layout.positions.get('FIX-001')?.y).not.toBe(chain[0]);
  });

  it('splits a fan-out evenly around what it hangs from', () => {
    const layout = layoutGraph(
      graph(
        [
          ['TASK-001', 0],
          ['TASK-002', 1],
          ['TASK-003', 1],
        ],
        [
          ['TASK-001', 'TASK-002'],
          ['TASK-001', 'TASK-003'],
        ],
      ),
    );

    const parent = layout.positions.get('TASK-001')?.y ?? 0;
    const above = layout.positions.get('TASK-002')?.y ?? 0;
    const below = layout.positions.get('TASK-003')?.y ?? 0;

    // Hanging both below the parent would leave the top half of the canvas empty
    // and make the parent look like the first of three siblings.
    expect(parent - above).toBeCloseTo(below - parent, 5);
  });

  it('puts a chain on one horizontal line', () => {
    // A chain that staircased downward would waste the whole canvas height and
    // make five tasks look like a tree.
    const layout = layoutGraph(
      graph(
        [
          ['TASK-001', 0],
          ['TASK-002', 1],
          ['TASK-003', 2],
        ],
        [
          ['TASK-001', 'TASK-002'],
          ['TASK-002', 'TASK-003'],
        ],
      ),
    );

    const heights = [...layout.positions.values()].map((position) => position.y);
    expect(new Set(heights).size).toBe(1);
    expect(layout.positions.get('TASK-002')?.x).toBe(COLUMN_PITCH);
    expect(layout.positions.get('TASK-003')?.x).toBe(COLUMN_PITCH * 2);
  });

  it('centres a column on the same axis as the rest', () => {
    const layout = layoutGraph(
      graph(
        [
          ['TASK-001', 0],
          ['TASK-002', 1],
          ['TASK-003', 1],
        ],
        [
          ['TASK-001', 'TASK-002'],
          ['TASK-001', 'TASK-003'],
        ],
      ),
    );

    const root = layout.positions.get('TASK-001')?.y ?? 0;
    const branches = [
      layout.positions.get('TASK-002')?.y ?? 0,
      layout.positions.get('TASK-003')?.y ?? 0,
    ];

    expect(root).toBe(0);
    // Split evenly above and below the root, not stacked below it.
    expect(branches[0]).toBeLessThan(root);
    expect(branches[1]).toBeGreaterThan(root);
  });

  it('never places a task left of something it waits for', () => {
    // The property that makes every edge point one way. A fan-in drawn level with
    // one of its dependencies produces a line going backwards, which reads as a
    // dependency that does not exist.
    const dag = graph(
      [
        ['TASK-001', 0],
        ['TASK-002', 1],
        ['TASK-003', 2],
        ['TASK-004', 3],
      ],
      [
        ['TASK-001', 'TASK-002'],
        ['TASK-002', 'TASK-003'],
        ['TASK-001', 'TASK-004'],
        ['TASK-003', 'TASK-004'],
      ],
    );

    const layout = layoutGraph(dag);

    for (const edge of dag.edges) {
      const from = layout.positions.get(edge.from)?.x ?? 0;
      const to = layout.positions.get(edge.to)?.x ?? 0;
      expect(to, `${edge.from} → ${edge.to} points backwards`).toBeGreaterThan(from);
    }
  });

  it('guarantees strict left-to-right progression for complex multi-level DAG with fan-outs and fan-ins', () => {
    // Ancestor X MUST strictly be less than descendant X
    const dag = graph(
      [
        ['TASK-001', 0],
        ['TASK-002', 1],
        ['TASK-003', 1],
        ['TASK-004', 2],
        ['TASK-005', 2],
        ['TASK-006', 3],
        ['TASK-007', 4],
      ],
      [
        ['TASK-001', 'TASK-002'],
        ['TASK-001', 'TASK-003'],
        ['TASK-002', 'TASK-004'],
        ['TASK-003', 'TASK-005'],
        ['TASK-004', 'TASK-006'],
        ['TASK-005', 'TASK-006'],
        ['TASK-006', 'TASK-007'],
      ],
    );

    const layout = layoutGraph(dag);
    const x001 = layout.positions.get('TASK-001')!.x;
    const x002 = layout.positions.get('TASK-002')!.x;
    const x003 = layout.positions.get('TASK-003')!.x;
    const x004 = layout.positions.get('TASK-004')!.x;
    const x005 = layout.positions.get('TASK-005')!.x;
    const x006 = layout.positions.get('TASK-006')!.x;
    const x007 = layout.positions.get('TASK-007')!.x;

    expect(x001).toBeLessThan(x002);
    expect(x001).toBeLessThan(x003);
    expect(x002).toBeLessThan(x004);
    expect(x003).toBeLessThan(x005);
    expect(x004).toBeLessThan(x006);
    expect(x005).toBeLessThan(x006);
    expect(x006).toBeLessThan(x007);
  });

  it('orders a column by what it hangs from', () => {
    // The barycentre pass. Without it the second column keeps the server's order
    // and the two branches cross for no reason.
    const layout = layoutGraph(
      graph(
        [
          ['ROOT-A', 0],
          ['ROOT-B', 0],
          ['LEAF-B', 1],
          ['LEAF-A', 1],
        ],
        [
          ['ROOT-A', 'LEAF-A'],
          ['ROOT-B', 'LEAF-B'],
        ],
      ),
    );

    const above = (a: string, b: string): boolean =>
      (layout.positions.get(a)?.y ?? 0) < (layout.positions.get(b)?.y ?? 0);

    expect(above('ROOT-A', 'ROOT-B')).toBe(true);
    expect(above('LEAF-A', 'LEAF-B')).toBe(true);
  });

  it('places five hundred nodes quickly enough to be re-run on a re-plan', () => {
    const nodes: [string, number][] = [];
    const edges: [string, string][] = [];
    for (let index = 0; index < 500; index += 1) {
      const id = `TASK-${String(index).padStart(3, '0')}`;
      nodes.push([id, Math.floor(index / 10)]);
      if (index >= 10) edges.push([`TASK-${String(index - 10).padStart(3, '0')}`, id]);
    }

    const started = performance.now();
    const layout = layoutGraph(graph(nodes, edges));
    const elapsed = performance.now() - started;

    expect(layout.positions.size).toBe(500);
    expect(layout.widestColumn).toBe(10);
    expect(elapsed).toBeLessThan(500);
  });
});

describe('selectedPath', () => {
  const DIAMOND = graph(
    [
      ['TASK-001', 0],
      ['TASK-002', 1],
      ['TASK-003', 1],
      ['TASK-004', 2],
      ['TASK-005', 0],
    ],
    [
      ['TASK-001', 'TASK-002'],
      ['TASK-001', 'TASK-003'],
      ['TASK-002', 'TASK-004'],
      ['TASK-003', 'TASK-004'],
    ],
  );

  it('is empty with nothing selected', () => {
    expect(selectedPath(DIAMOND, undefined).onPath.size).toBe(0);
  });

  it('reaches every ancestor and every descendant, not just the neighbours', () => {
    const path = selectedPath(DIAMOND, 'TASK-002');

    expect([...path.ancestors]).toEqual(['TASK-001']);
    expect([...path.descendants]).toEqual(['TASK-004']);
    expect(path.onPath.has('TASK-002')).toBe(true);
  });

  it('leaves an unrelated branch out', () => {
    // The point of the highlight: what is *not* connected has to fall away, or
    // it says nothing.
    const path = selectedPath(DIAMOND, 'TASK-002');

    expect(path.onPath.has('TASK-003')).toBe(false);
    expect(path.onPath.has('TASK-005')).toBe(false);
  });

  it('walks transitively through a chain', () => {
    const chain = graph(
      [
        ['TASK-001', 0],
        ['TASK-002', 1],
        ['TASK-003', 2],
        ['TASK-004', 3],
      ],
      [
        ['TASK-001', 'TASK-002'],
        ['TASK-002', 'TASK-003'],
        ['TASK-003', 'TASK-004'],
      ],
    );

    const path = selectedPath(chain, 'TASK-003');

    expect([...path.ancestors].sort()).toEqual(['TASK-001', 'TASK-002']);
    expect([...path.descendants]).toEqual(['TASK-004']);
  });

  it('terminates on a graph that has a cycle in it', () => {
    // The server says when a plan is cyclic, and this view is exactly where
    // somebody goes to look at the plan that is.
    const cyclic = graph(
      [
        ['TASK-001', 0],
        ['TASK-002', 0],
      ],
      [
        ['TASK-001', 'TASK-002'],
        ['TASK-002', 'TASK-001'],
      ],
    );

    const path = selectedPath(cyclic, 'TASK-001');

    expect(path.onPath.has('TASK-002')).toBe(true);
  });
});
