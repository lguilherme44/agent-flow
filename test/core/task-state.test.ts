import { describe, it, expect } from 'vitest';
import {
  canTransition,
  transition,
  isTerminal,
  allowedTransitions,
  TaskStateError,
} from '../../src/core/task-state.js';
import { TASK_STATES, type TaskState } from '../../src/contracts/index.js';

describe('task state machine (§22)', () => {
  it('covers exactly the seven states the spec defines', () => {
    expect([...TASK_STATES].sort()).toEqual(
      ['queued', 'ready', 'running', 'completed', 'failed', 'blocked', 'review_required'].sort(),
    );
  });

  it('allows the normal path', () => {
    expect(canTransition('queued', 'ready')).toBe(true);
    expect(canTransition('ready', 'running')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(true);
  });

  it('refuses to skip execution', () => {
    // Marking a task done without running it is exactly the "agent said
    // completed" failure the spec calls out in §42.
    expect(canTransition('queued', 'completed')).toBe(false);
    expect(canTransition('ready', 'completed')).toBe(false);
  });

  it('treats completed as terminal', () => {
    expect(isTerminal('completed')).toBe(true);
    for (const target of TASK_STATES) {
      expect(canTransition('completed', target as TaskState)).toBe(false);
    }
  });

  it('allows a failed task to be retried', () => {
    expect(canTransition('failed', 'ready')).toBe(true);
    expect(canTransition('failed', 'running')).toBe(false);
  });

  it('allows a blocked task to be unblocked only deliberately', () => {
    // BLOCKED means an architectural question the SDD did not answer (§20).
    // It must not be retried automatically (§23) — a human has to look.
    expect(canTransition('blocked', 'ready')).toBe(true);
    expect(canTransition('blocked', 'running')).toBe(false);
    expect(isTerminal('blocked')).toBe(false);
  });

  it('routes a validation failure to review, never to another model', () => {
    // §55: a bad result stays visible. Escalating models here would bury it.
    expect(canTransition('running', 'review_required')).toBe(true);
    expect(canTransition('review_required', 'ready')).toBe(true);
    expect(canTransition('review_required', 'completed')).toBe(true);
  });

  it('lets a running task fail or block', () => {
    expect(canTransition('running', 'failed')).toBe(true);
    expect(canTransition('running', 'blocked')).toBe(true);
  });

  it('rejects going backwards from running to queued', () => {
    expect(canTransition('running', 'queued')).toBe(false);
  });
});

describe('transition', () => {
  it('returns the next state on a legal move', () => {
    expect(transition('ready', 'running')).toBe('running');
  });

  it('throws with both states named on an illegal move', () => {
    try {
      transition('queued', 'completed');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TaskStateError);
      expect((error as Error).message).toContain('queued');
      expect((error as Error).message).toContain('completed');
    }
  });

  it('rejects a no-op transition', () => {
    expect(() => transition('running', 'running')).toThrowError(TaskStateError);
  });
});

describe('allowedTransitions', () => {
  it('agrees with canTransition for every pair', () => {
    // Two views of one table; if they ever disagree, one of them is a lie.
    for (const from of TASK_STATES) {
      for (const to of TASK_STATES) {
        expect(allowedTransitions(from as TaskState).includes(to as TaskState)).toBe(
          canTransition(from as TaskState, to as TaskState),
        );
      }
    }
  });

  it('returns nothing for a terminal state', () => {
    expect(allowedTransitions('completed')).toEqual([]);
  });
});
