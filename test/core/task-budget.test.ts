import { describe, it, expect } from 'vitest';
import {
  READS_FOR_COMFORT,
  READS_FOR_IMPOSSIBLE,
  measureTaskBudget,
  weighPlan,
} from '../../src/core/task-budget.js';

/**
 * The half `measurePromptComposition` cannot see.
 *
 * Both scenarios below are one real task, measured in November 2026 against a local
 * endpoint. Same request, same weights, same harness; only the window changed. The run
 * with 49 152 never edited a file; the run with 131 072 produced 7 files and 43 passing
 * tests. The static prompt measurement cleared both — it was 18 % of the smaller window.
 */

/** The service the task had to change: 75 943 bytes on disk. */
const LARGE_SERVICE = { path: 'api/src/modules/reminders/reminders.service.ts', bytes: 75_943 };
const SMALL_COMPONENT = { path: 'app/src/components/RemindersAtRiskCard.tsx', bytes: 3_698 };

const measured = (contextWindow: number | undefined) =>
  measureTaskBudget({
    ...(contextWindow === undefined ? {} : { contextWindow }),
    preambleTokens: 8_628,
    outputReserveTokens: 8_192,
    targets: [LARGE_SERVICE, SMALL_COMPONENT],
  });

describe('deciding whether a task fits before calling a model', () => {
  it('refuses the window that produced zero edits', () => {
    const budget = measured(49_152);

    expect(budget.verdict).toBe('impossible');
    expect(budget.readsAfforded).toBeLessThan(READS_FOR_IMPOSSIBLE);
  });

  it('clears the window that finished the same task', () => {
    const budget = measured(131_072);

    expect(budget.verdict).toBe('fits');
    expect(budget.readsAfforded).toBeGreaterThanOrEqual(READS_FOR_COMFORT);
  });

  it('names the file to split around, not just that the prompt is big', () => {
    // "The task is too large" is not actionable. The path and its token count are: they
    // name what to read in a separate task, which is the only move that changes the
    // arithmetic without raising the window.
    const budget = measured(49_152);

    expect(budget.largestTarget?.path).toBe(LARGE_SERVICE.path);
    expect(budget.detail).toContain(LARGE_SERVICE.path);
  });

  it('measures the largest target, not the sum', () => {
    // A task touching ten small files is not the problem; one file that cannot stay
    // resident is. Summing would flag the first and miss the second.
    const budget = measureTaskBudget({
      contextWindow: 49_152,
      preambleTokens: 8_628,
      outputReserveTokens: 8_192,
      targets: [SMALL_COMPONENT, SMALL_COMPONENT, SMALL_COMPONENT, SMALL_COMPONENT],
    });

    expect(budget.verdict).toBe('fits');
    expect(budget.largestTarget?.path).toBe(SMALL_COMPONENT.path);
  });

  it('says unknown when the operator never declared a window', () => {
    // Nothing is inferred: assuming a frontier window is what makes the failure late, and
    // assuming a small one would refuse runs that never had trouble.
    expect(measured(undefined).verdict).toBe('unknown');
  });

  it('says unknown when no target was named, rather than guessing it fits', () => {
    const budget = measureTaskBudget({
      contextWindow: 131_072,
      preambleTokens: 8_628,
      outputReserveTokens: 8_192,
      targets: [],
    });

    expect(budget.verdict).toBe('unknown');
    expect(budget.workingTokens).toBeGreaterThan(0);
  });

  it('floors working room at zero when the preamble already exceeds the window', () => {
    // A negative budget would make the ratio negative and the verdict read as "impossible"
    // for the right reason by accident. Zero is the honest number.
    const budget = measureTaskBudget({
      contextWindow: 8_192,
      preambleTokens: 18_268,
      outputReserveTokens: 8_192,
      targets: [LARGE_SERVICE],
    });

    expect(budget.workingTokens).toBe(0);
    expect(budget.verdict).toBe('impossible');
  });
});

describe('weighing a whole plan at approval', () => {
  const sizes = new Map([
    [LARGE_SERVICE.path, LARGE_SERVICE.bytes],
    [SMALL_COMPONENT.path, SMALL_COMPONENT.bytes],
  ]);

  it('separates the task that cannot fit from the one that can', () => {
    const weighed = weighPlan({
      tasks: [
        { id: 'TASK-001', files: [LARGE_SERVICE.path] },
        { id: 'TASK-002', files: [SMALL_COMPONENT.path] },
      ],
      sizes,
      contextWindow: 49_152,
      preambleTokens: 8_628,
    });

    expect(weighed.map((fit) => [fit.task, fit.budget.verdict])).toEqual([
      ['TASK-001', 'impossible'],
      ['TASK-002', 'fits'],
    ]);
  });

  it('omits a path with no measured size rather than counting it as zero', () => {
    // Same rule as the stage: a task that *creates* a file has nothing to read there, and
    // a zero would make a tight task look comfortable.
    const weighed = weighPlan({
      tasks: [{ id: 'TASK-001', files: ['src/does-not-exist.ts'] }],
      sizes,
      contextWindow: 49_152,
      preambleTokens: 8_628,
    });

    expect(weighed[0]?.budget.verdict).toBe('unknown');
  });

  it('reports unknown for every task when no window was declared', () => {
    const weighed = weighPlan({
      tasks: [{ id: 'TASK-001', files: [LARGE_SERVICE.path] }],
      sizes,
      preambleTokens: 8_628,
    });

    expect(weighed[0]?.budget.verdict).toBe('unknown');
  });

  it('keeps the plan order, so the warning names tasks in the order they will run', () => {
    const weighed = weighPlan({
      tasks: [
        { id: 'TASK-003', files: [] },
        { id: 'TASK-001', files: [LARGE_SERVICE.path] },
      ],
      sizes,
      contextWindow: 131_072,
      preambleTokens: 8_628,
    });

    expect(weighed.map((fit) => fit.task)).toEqual(['TASK-003', 'TASK-001']);
  });
});
