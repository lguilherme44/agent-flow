import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  judgeRequiredGates,
  type GateEvidence,
  type GateTask,
} from '../../src/core/required-gates.js';
import { buildValidationRegistry } from '../../src/core/validation-registry.js';
import { PlanSchema, ProjectConfigSchema, TaskResultSchema } from '../../src/contracts/index.js';

/**
 * FR-025 to FR-029 — a gate the plan requires is PASS only when every completed task listing
 * it ran it and was satisfied.
 *
 * The defect: a gate listed only by a `validationExpectation: 'none'` task was never
 * executed, the task was recorded `{ passed: true, commands: [] }`, and the run still said
 * FEATURE COMPLETE.
 */

const registry = buildValidationRegistry(
  ProjectConfigSchema.parse({
    project: { name: 'demo', type: 'node' },
    commands: { lint: 'npm run lint', typecheck: 'npm run typecheck', test: 'npm run test' },
    validationCommands: { 'test-deck': 'npm run test:deck' },
  }),
);
const has = (id: string): boolean => registry.has(id);

function task(
  id: string,
  validation: readonly string[],
  overrides: Partial<GateTask> = {},
): GateTask {
  return { id, state: 'completed', validation, validationExpectation: 'pass', ...overrides };
}

/** What the executor records: one command result per id, in order. */
function ran(
  count: number,
  passed: boolean,
  expectation: GateEvidence['expectation'] = 'pass',
): GateEvidence {
  return {
    passed,
    expectation,
    commands: Array.from({ length: count }, (_, i) => ({ command: `cmd-${String(i)}`, exitCode: 0 })),
  };
}

describe('judgeRequiredGates (FR-029)', () => {
  it('is NOT_RUN with expectation_none when one listing task has expectation none', () => {
    const gates = judgeRequiredGates(
      [
        task('TASK-001', ['test-deck']),
        task('TASK-002', ['test-deck'], { validationExpectation: 'none' }),
      ],
      new Map([
        ['TASK-001', ran(1, true)],
        // What the executor writes for a `none` task: nothing ran.
        ['TASK-002', { passed: true, expectation: 'none', commands: [] }],
      ]),
      has,
    );

    expect(gates).toEqual([
      { id: 'test-deck', verdict: 'NOT_RUN', tasks: ['TASK-002'], reason: 'expectation_none' },
    ]);
  });

  it('is PASS when every listing task ran it and was satisfied', () => {
    const gates = judgeRequiredGates(
      [task('TASK-001', ['test-deck']), task('TASK-002', ['lint', 'test-deck'])],
      new Map([
        ['TASK-001', ran(1, true)],
        ['TASK-002', ran(2, true)],
      ]),
      has,
    );

    expect(gates.find((gate) => gate.id === 'test-deck')).toEqual({
      id: 'test-deck',
      verdict: 'PASS',
      tasks: ['TASK-001', 'TASK-002'],
    });
  });

  it('is FAIL, naming the task, when one ran it unsatisfied', () => {
    const gates = judgeRequiredGates(
      [task('TASK-001', ['test-deck']), task('TASK-002', ['test-deck'])],
      new Map([
        ['TASK-001', ran(1, true)],
        // Completed by operator acceptance, with the recorded judgement not satisfied.
        ['TASK-002', ran(1, false)],
      ]),
      has,
    );

    expect(gates).toEqual([
      { id: 'test-deck', verdict: 'FAIL', tasks: ['TASK-002'], reason: 'failed' },
    ]);
  });

  it('is NOT_RUN with no_result when result.json is shorter than validation', () => {
    const gates = judgeRequiredGates(
      [task('TASK-001', ['lint', 'test'])],
      new Map([['TASK-001', ran(1, true)]]),
      has,
    );

    // Position 0 has an entry, position 1 does not: ids map to results by position.
    expect(gates).toEqual([
      { id: 'lint', verdict: 'PASS', tasks: ['TASK-001'] },
      { id: 'test', verdict: 'NOT_RUN', tasks: ['TASK-001'], reason: 'no_result' },
    ]);
  });

  it('is NOT_RUN with no_result when a completed task has no result.json at all', () => {
    const gates = judgeRequiredGates([task('TASK-001', ['test'])], new Map(), has);

    expect(gates).toEqual([
      { id: 'test', verdict: 'NOT_RUN', tasks: ['TASK-001'], reason: 'no_result' },
    ]);
  });

  it('is NOT_RUN with not_declared when the registry no longer has the id', () => {
    const gates = judgeRequiredGates(
      [task('TASK-001', ['typecheck-deck'])],
      // A result recorded under the old configuration does not rescue it.
      new Map([['TASK-001', ran(1, true)]]),
      has,
    );

    expect(gates).toEqual([
      { id: 'typecheck-deck', verdict: 'NOT_RUN', tasks: ['TASK-001'], reason: 'not_declared' },
    ]);
  });

  it('is NOT_RUN with no_completed_task when no listing task has completed', () => {
    const gates = judgeRequiredGates(
      [task('TASK-001', ['test'], { state: 'review_required' })],
      new Map(),
      has,
    );

    expect(gates).toEqual([
      { id: 'test', verdict: 'NOT_RUN', tasks: ['TASK-001'], reason: 'no_completed_task' },
    ]);
  });

  it('judges a gate by its completed tasks, leaving unfinished ones to "all tasks completed"', () => {
    const gates = judgeRequiredGates(
      [task('TASK-001', ['test']), task('TASK-002', ['test'], { state: 'queued' })],
      new Map([['TASK-001', ran(1, true)]]),
      has,
    );

    expect(gates).toEqual([{ id: 'test', verdict: 'PASS', tasks: ['TASK-001'] }]);
  });

  it('passes all three gates of a RED task whose only failure was the test, then a GREEN task', () => {
    // FR-029: `fail` is judged over the whole list, so the RED task's one failing command
    // satisfies every gate it lists — a per-exit-code verdict would call `test` FAIL here.
    const gates = judgeRequiredGates(
      [
        task('TASK-001', ['lint', 'typecheck', 'test'], { validationExpectation: 'fail' }),
        task('TASK-002', ['test']),
      ],
      new Map([
        ['TASK-001', ran(3, false, 'fail')],
        ['TASK-002', ran(1, true)],
      ]),
      has,
    );

    expect(gates.map((gate) => [gate.id, gate.verdict])).toEqual([
      ['lint', 'PASS'],
      ['test', 'PASS'],
      ['typecheck', 'PASS'],
    ]);
  });

  it('fails the RED task\'s gates when its validation passed after all', () => {
    // Positive control for the case above: the same task with every command green is the
    // "test asserts nothing" outcome, and its gates must not read as satisfied.
    const gates = judgeRequiredGates(
      [task('TASK-001', ['lint', 'test'], { validationExpectation: 'fail' })],
      new Map([['TASK-001', ran(2, true, 'fail')]]),
      has,
    );

    expect(gates.map((gate) => gate.verdict)).toEqual(['FAIL', 'FAIL']);
  });

  it('takes the union of validation over every task, corrective tasks included', () => {
    const gates = judgeRequiredGates(
      [task('TASK-001', ['test']), task('FIX-001', ['lint'])],
      new Map([
        ['TASK-001', ran(1, true)],
        ['FIX-001', ran(1, true)],
      ]),
      has,
    );

    expect(gates.map((gate) => gate.id)).toEqual(['lint', 'test']);
  });

  it('returns no gate when no task lists one', () => {
    expect(judgeRequiredGates([task('TASK-001', [])], new Map(), has)).toEqual([]);
  });
});

describe('legacy result.json files are evidence as they stand (NFR-001)', () => {
  const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'legacy-artifacts');
  const legacy = (id: string): GateEvidence =>
    TaskResultSchema.parse(
      JSON.parse(readFileSync(join(FIXTURES, 'tasks', id, 'result.json'), 'utf8')),
    ).validation;

  it('parses and judges the two RED tasks of a real run', () => {
    // AF-2026-002's TASK-001 and TASK-002: `test` expected to fail, and it did.
    const plan = PlanSchema.parse(JSON.parse(readFileSync(join(FIXTURES, 'plan.json'), 'utf8')));
    const red = plan.tasks
      .filter((entry) => entry.id === 'TASK-001' || entry.id === 'TASK-002')
      .map((entry) => task(entry.id, entry.validation, { validationExpectation: entry.validationExpectation }));

    const gates = judgeRequiredGates(
      red,
      new Map([
        ['TASK-001', legacy('TASK-001')],
        ['TASK-002', legacy('TASK-002')],
      ]),
      has,
    );

    expect(gates).toEqual([{ id: 'test', verdict: 'PASS', tasks: ['TASK-001', 'TASK-002'] }]);
  });

  it('reads a result written before expectation and commands were recorded as no_result', () => {
    // The schema defaults a missing list to empty, so the gate has no entry at its position.
    const evidence = TaskResultSchema.parse({
      task: 'TASK-001',
      status: 'completed',
      runner: 'claude',
      reasoning: 'medium',
      startedAt: '2026-08-01T10:00:00.000Z',
      finishedAt: '2026-08-01T10:05:00.000Z',
      validation: { passed: true },
    }).validation;

    expect(judgeRequiredGates([task('TASK-001', ['test'])], new Map([['TASK-001', evidence]]), has))
      .toEqual([{ id: 'test', verdict: 'NOT_RUN', tasks: ['TASK-001'], reason: 'no_result' }]);
  });
});
