import { describe, it, expect } from 'vitest';
import {
  buildDag,
  topologicalOrder,
  readyTasks,
  blockedByFailure,
  DagError,
} from '../../src/core/dag.js';

type Node = { id: string; dependencies: string[] };

const node = (id: string, dependencies: string[] = []): Node => ({ id, dependencies });

describe('buildDag', () => {
  it('accepts a well formed graph', () => {
    const dag = buildDag([node('TASK-001'), node('TASK-002', ['TASK-001'])]);
    expect(dag.ids).toEqual(['TASK-001', 'TASK-002']);
    expect(dag.dependenciesOf('TASK-002')).toEqual(['TASK-001']);
    expect(dag.dependenciesOf('TASK-UNKNOWN')).toEqual([]);
    expect(dag.dependentsOf('TASK-002')).toEqual([]);
    expect(dag.dependentsOf('TASK-UNKNOWN')).toEqual([]);
  });

  it('reports a dependency on a task that does not exist', () => {
    // A planner hallucinating a task id must fail loudly at plan time, not
    // strand the scheduler at run time.
    expect(() => buildDag([node('TASK-001', ['TASK-999'])])).toThrowError(DagError);
    try {
      buildDag([node('TASK-001', ['TASK-999'])]);
    } catch (error) {
      expect((error as DagError).kind).toBe('unknown_dependency');
      expect((error as DagError).message).toContain('TASK-999');
      expect((error as DagError).message).toContain('TASK-001');
    }
  });

  it('rejects duplicate ids', () => {
    expect(() => buildDag([node('TASK-001'), node('TASK-001')])).toThrowError(DagError);
  });

  it('rejects a self-dependency', () => {
    try {
      buildDag([node('TASK-001', ['TASK-001'])]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as DagError).kind).toBe('cycle');
    }
  });
});

describe('cycle detection', () => {
  it('reports the full path of a cycle, not just its existence', () => {
    // "There is a cycle" is not actionable. The path is.
    try {
      buildDag([
        node('TASK-001', ['TASK-003']),
        node('TASK-002', ['TASK-001']),
        node('TASK-003', ['TASK-002']),
      ]);
      expect.unreachable('should have thrown');
    } catch (error) {
      const dagError = error as DagError;
      expect(dagError.kind).toBe('cycle');
      expect(dagError.cycle).toBeDefined();
      // A cycle path is closed: first and last element are the same node.
      expect(dagError.cycle?.at(0)).toBe(dagError.cycle?.at(-1));
      expect(new Set(dagError.cycle)).toEqual(new Set(['TASK-001', 'TASK-002', 'TASK-003']));
    }
  });

  it('finds a two-node cycle', () => {
    try {
      buildDag([node('TASK-001', ['TASK-002']), node('TASK-002', ['TASK-001'])]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as DagError).kind).toBe('cycle');
    }
  });

  it('accepts a diamond, which is not a cycle', () => {
    expect(() =>
      buildDag([
        node('TASK-001'),
        node('TASK-002', ['TASK-001']),
        node('TASK-003', ['TASK-001']),
        node('TASK-004', ['TASK-002', 'TASK-003']),
      ]),
    ).not.toThrow();
  });
});

describe('topologicalOrder', () => {
  it('places every dependency before its dependents', () => {
    const dag = buildDag([
      node('TASK-003', ['TASK-001', 'TASK-002']),
      node('TASK-001'),
      node('TASK-005', ['TASK-003']),
      node('TASK-002'),
    ]);

    const order = topologicalOrder(dag);
    const at = (id: string): number => order.indexOf(id);

    expect(at('TASK-001')).toBeLessThan(at('TASK-003'));
    expect(at('TASK-002')).toBeLessThan(at('TASK-003'));
    expect(at('TASK-003')).toBeLessThan(at('TASK-005'));
    expect(order).toHaveLength(4);
  });

  it('is deterministic — the same plan always yields the same order', () => {
    // Reruns and resumes must not reshuffle work; auditability depends on it.
    const nodes = [
      node('TASK-004', ['TASK-002']),
      node('TASK-003', ['TASK-001']),
      node('TASK-002', ['TASK-001']),
      node('TASK-001'),
    ];
    const first = topologicalOrder(buildDag(nodes));
    const second = topologicalOrder(buildDag([...nodes].reverse()));
    expect(first).toEqual(second);
  });

  it('handles a graph with no edges at all', () => {
    const order = topologicalOrder(buildDag([node('TASK-002'), node('TASK-001')]));
    expect(order).toEqual(['TASK-001', 'TASK-002']);
  });
});

describe('readyTasks (§22)', () => {
  const dag = buildDag([
    node('TASK-001'),
    node('TASK-002'),
    node('TASK-003', ['TASK-001', 'TASK-002']),
    node('TASK-004', ['TASK-003']),
  ]);

  it('returns only tasks whose dependencies are all completed', () => {
    expect(readyTasks(dag, { 'TASK-001': 'queued', 'TASK-002': 'queued' })).toEqual([
      'TASK-001',
      'TASK-002',
    ]);
  });

  it('holds a task back while any dependency is incomplete', () => {
    // The single rule the spec states and the scheduler must never bend.
    const ready = readyTasks(dag, {
      'TASK-001': 'completed',
      'TASK-002': 'running',
    });
    expect(ready).not.toContain('TASK-003');
  });

  it('releases a task once every dependency completes', () => {
    const ready = readyTasks(dag, {
      'TASK-001': 'completed',
      'TASK-002': 'completed',
    });
    expect(ready).toEqual(['TASK-003']);
  });

  it('never returns a task that is already running or finished', () => {
    const ready = readyTasks(dag, {
      'TASK-001': 'running',
      'TASK-002': 'completed',
      'TASK-003': 'completed',
      'TASK-004': 'queued',
    });
    expect(ready).toEqual(['TASK-004']);
  });

  it('treats an unlisted task as queued', () => {
    expect(readyTasks(dag, {})).toEqual(['TASK-001', 'TASK-002']);
  });
});

describe('blockedByFailure', () => {
  const dag = buildDag([
    node('TASK-001'),
    node('TASK-002', ['TASK-001']),
    node('TASK-003', ['TASK-002']),
    node('TASK-004'),
  ]);

  it('marks the whole downstream chain of a failed task as blocked', () => {
    // A dependent of a failed task is blocked, never ready — otherwise the
    // scheduler would run work on top of a foundation that was never built.
    expect(blockedByFailure(dag, { 'TASK-001': 'failed' })).toEqual(['TASK-002', 'TASK-003']);
  });

  it('leaves independent branches alone', () => {
    expect(blockedByFailure(dag, { 'TASK-001': 'failed' })).not.toContain('TASK-004');
  });

  it('treats a blocked task as poisoning its dependents too', () => {
    expect(blockedByFailure(dag, { 'TASK-002': 'blocked' })).toEqual(['TASK-003']);
  });

  it('returns nothing when everything is healthy', () => {
    expect(blockedByFailure(dag, { 'TASK-001': 'completed' })).toEqual([]);
  });
});

describe('readyTasks and blockedByFailure agree', () => {
  it('never reports a task as both ready and blocked', () => {
    const dag = buildDag([
      node('TASK-001'),
      node('TASK-002', ['TASK-001']),
      node('TASK-003', ['TASK-001']),
    ]);
    const states = { 'TASK-001': 'failed' } as const;

    const ready = new Set(readyTasks(dag, states));
    for (const blocked of blockedByFailure(dag, states)) {
      expect(ready.has(blocked)).toBe(false);
    }
  });
});
