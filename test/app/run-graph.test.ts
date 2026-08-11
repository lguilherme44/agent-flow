import { describe, it, expect } from 'vitest';
import { describeRunGraph, effectiveTaskStates } from '../../src/app/run-graph.js';
import type { TaskState } from '../../src/contracts/index.js';

/**
 * The read model behind the DAG view (UI-28).
 *
 * Every case here is a shape the browser must not have to reason about: a plan
 * with several roots, one that fans out and back in, one that names a dependency
 * it does not contain, and one that is not a graph at all.
 */

const task = (id: string, ...dependencies: string[]) => ({ id, dependencies });

describe('describeRunGraph', () => {
  it('has nothing to say about an empty plan', () => {
    const graph = describeRunGraph([]);

    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.invalid).toBeUndefined();
  });

  it('puts a single task at depth zero', () => {
    expect(describeRunGraph([task('TASK-001')]).nodes).toEqual([{ taskId: 'TASK-001', depth: 0 }]);
  });

  it('ranks a chain one column per link', () => {
    const graph = describeRunGraph([
      task('TASK-001'),
      task('TASK-002', 'TASK-001'),
      task('TASK-003', 'TASK-002'),
    ]);

    expect(graph.nodes).toEqual([
      { taskId: 'TASK-001', depth: 0 },
      { taskId: 'TASK-002', depth: 1 },
      { taskId: 'TASK-003', depth: 2 },
    ]);
    expect(graph.edges).toEqual([
      { from: 'TASK-001', to: 'TASK-002' },
      { from: 'TASK-002', to: 'TASK-003' },
    ]);
  });

  it('puts a fan-out in one column', () => {
    const graph = describeRunGraph([
      task('TASK-001'),
      task('TASK-002', 'TASK-001'),
      task('TASK-003', 'TASK-001'),
    ]);

    expect(depthOf(graph, 'TASK-002')).toBe(1);
    expect(depthOf(graph, 'TASK-003')).toBe(1);
  });

  it('places a fan-in behind its slowest branch, not its first', () => {
    // The property that makes the drawing readable: TASK-004 depends on a task at
    // depth 1 and on one at depth 2, and drawing it at 2 would put it level with
    // something it waits for — an edge pointing backwards.
    const graph = describeRunGraph([
      task('TASK-001'),
      task('TASK-002', 'TASK-001'),
      task('TASK-003', 'TASK-002'),
      task('TASK-004', 'TASK-001', 'TASK-003'),
    ]);

    expect(depthOf(graph, 'TASK-004')).toBe(3);
  });

  it('keeps several roots at depth zero', () => {
    const graph = describeRunGraph([task('TASK-001'), task('TASK-002'), task('TASK-003')]);

    expect(graph.nodes.every((node) => node.depth === 0)).toBe(true);
    expect(graph.edges).toEqual([]);
  });

  it('reports a dependency the plan does not contain instead of drawing it', () => {
    // The browser must never invent a node. A plan naming TASK-000 is a plan worth
    // looking at, and a phantom root would hide exactly that.
    const graph = describeRunGraph([task('TASK-002', 'TASK-000')]);

    expect(graph.nodes.map((node) => node.taskId)).toEqual(['TASK-002']);
    expect(graph.edges).toEqual([]);
    expect(graph.unresolved).toEqual([{ taskId: 'TASK-002', dependsOn: 'TASK-000' }]);
    expect(graph.invalid).toBeUndefined();
  });

  it('names a cycle rather than pretending to rank it', () => {
    const graph = describeRunGraph([
      task('TASK-001', 'TASK-002'),
      task('TASK-002', 'TASK-001'),
    ]);

    expect(graph.invalid?.kind).toBe('cycle');
    expect(graph.invalid?.cycle).toContain('TASK-001');
    // Still every node and every edge: the point of the view is to show what the
    // plan says, and a blank screen explains nothing.
    expect(graph.nodes.map((node) => node.taskId)).toEqual(['TASK-001', 'TASK-002']);
    expect(graph.edges).toHaveLength(2);
  });

  it('ranks five hundred tasks without walking the graph twice', () => {
    // §96's target. A quadratic depth walk on a chain this long is seconds, not
    // milliseconds, and it would run again on every re-plan.
    const tasks = Array.from({ length: 500 }, (_, index) =>
      index === 0
        ? task(id(index))
        : task(id(index), id(index - 1)),
    );

    const started = performance.now();
    const graph = describeRunGraph(tasks);
    const elapsed = performance.now() - started;

    expect(graph.nodes).toHaveLength(500);
    expect(depthOf(graph, id(499))).toBe(499);
    expect(elapsed).toBeLessThan(500);
  });
});

describe('effectiveTaskStates', () => {
  it('calls a queued task with completed dependencies ready (§22)', () => {
    const states = effectiveTaskStates([task('TASK-001'), task('TASK-002', 'TASK-001')], {
      'TASK-001': 'completed',
      'TASK-002': 'queued',
    });

    expect(states['TASK-002']).toBe('ready');
  });

  it('leaves a task waiting on something unfinished as queued', () => {
    const states = effectiveTaskStates([task('TASK-001'), task('TASK-002', 'TASK-001')], {
      'TASK-001': 'running',
      'TASK-002': 'queued',
    });

    expect(states['TASK-002']).toBe('queued');
  });

  it('marks everything downstream of a failure blocked, not queued', () => {
    // "Queued" reads as not started yet. These will never start, and the
    // difference is the whole reason somebody is looking at the graph.
    const states = effectiveTaskStates(
      [task('TASK-001'), task('TASK-002', 'TASK-001'), task('TASK-003', 'TASK-002')],
      { 'TASK-001': 'failed', 'TASK-002': 'queued', 'TASK-003': 'queued' },
    );

    expect(states['TASK-002']).toBe('blocked');
    expect(states['TASK-003']).toBe('blocked');
  });

  it('leaves an independent branch ready when another one failed', () => {
    const states = effectiveTaskStates(
      [task('TASK-001'), task('TASK-002', 'TASK-001'), task('TASK-003')],
      { 'TASK-001': 'failed', 'TASK-002': 'queued', 'TASK-003': 'queued' },
    );

    expect(states['TASK-002']).toBe('blocked');
    expect(states['TASK-003']).toBe('ready');
  });

  it('never overwrites what actually happened', () => {
    const stored: Record<string, TaskState> = {
      'TASK-001': 'completed',
      'TASK-002': 'running',
      'TASK-003': 'review_required',
      'TASK-004': 'interrupted',
    };

    const states = effectiveTaskStates(
      [task('TASK-001'), task('TASK-002'), task('TASK-003'), task('TASK-004')],
      stored,
    );

    expect(states).toEqual(stored);
  });

  it('falls back to the stored states when the graph will not build', () => {
    const states = effectiveTaskStates(
      [task('TASK-001', 'TASK-002'), task('TASK-002', 'TASK-001')],
      { 'TASK-001': 'queued', 'TASK-002': 'running' },
    );

    expect(states).toEqual({ 'TASK-001': 'queued', 'TASK-002': 'running' });
  });

  it('treats a task nothing has recorded as queued', () => {
    expect(effectiveTaskStates([task('TASK-009')], {})).toEqual({ 'TASK-009': 'ready' });
  });
});

function depthOf(graph: { nodes: readonly { taskId: string; depth: number }[] }, id: string): number {
  return graph.nodes.find((node) => node.taskId === id)?.depth ?? -1;
}

function id(index: number): string {
  return `TASK-${String(index).padStart(3, '0')}`;
}
