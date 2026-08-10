import { describe, it, expect } from 'vitest';
import { checkPlan } from '../../src/app/stages/planning-checks.js';
import { PlanSchema, ProjectConfigSchema, type Plan } from '../../src/contracts/index.js';
import { buildValidationRegistry } from '../../src/core/validation-registry.js';

const SDD = `
## Functional Requirements

- FR-001: Generate recurring bookings.
- FR-002: Cancel a single occurrence.
`;

const plan = (tasks: unknown[]): Plan =>
  PlanSchema.parse({ feature: 'recurring-bookings', tasks });

const task = (
  id: string,
  requirements: string[],
  dependencies: string[] = [],
): Record<string, unknown> => ({
  id,
  title: `Task ${id}`,
  description: 'Does something.',
  complexity: 'normal',
  risk: 'low',
  dependencies,
  requirements,
  acceptanceCriteria: ['It works as specified.'],
  validation: [],
});

describe('checkPlan', () => {
  it('accepts a plan that covers every requirement', () => {
    const problems = checkPlan(
      plan([task('TASK-001', ['FR-001']), task('TASK-002', ['FR-002'], ['TASK-001'])]),
      SDD,
    );
    expect(problems).toEqual([]);
  });

  it('rejects a plan that leaves a requirement unimplemented', () => {
    // Caught here rather than by a reviewer: it is arithmetic, and a model
    // asked to do it exhaustively will eventually miss one.
    const problems = checkPlan(plan([task('TASK-001', ['FR-001'])]), SDD);
    expect(problems.join(' ')).toContain('FR-002');
  });

  it('rejects a task citing a requirement the SDD never defines', () => {
    const problems = checkPlan(
      plan([task('TASK-001', ['FR-001']), task('TASK-002', ['FR-999'])]),
      SDD,
    );
    expect(problems.join(' ')).toContain('FR-999');
  });

  it('rejects a dependency on a task that does not exist', () => {
    const problems = checkPlan(
      plan([task('TASK-001', ['FR-001', 'FR-002'], ['TASK-404'])]),
      SDD,
    );
    expect(problems.join(' ')).toContain('TASK-404');
  });

  it('rejects a dependency cycle and shows the path', () => {
    const problems = checkPlan(
      plan([
        task('TASK-001', ['FR-001'], ['TASK-002']),
        task('TASK-002', ['FR-002'], ['TASK-001']),
      ]),
      SDD,
    );

    expect(problems.join(' ')).toMatch(/cycle/i);
    expect(problems.join(' ')).toContain('TASK-001');
  });

  it('reports coverage and graph problems together', () => {
    // One round trip should tell the planner everything that is wrong.
    const problems = checkPlan(plan([task('TASK-001', ['FR-001'], ['TASK-404'])]), SDD);
    expect(problems.join(' ')).toContain('FR-002');
    expect(problems.join(' ')).toContain('TASK-404');
  });

  it('does not require a dedicated task per non-functional requirement', () => {
    // NFR and SEC are cross-cutting; demanding one task each invites filler.
    const problems = checkPlan(plan([task('TASK-001', ['FR-001', 'FR-002'])]), `${SDD}
- NFR-001: Fast.
- SEC-001: Safe.
`);
    expect(problems).toEqual([]);
  });

  describe('validation ids must exist in the project config (V-01 regression)', () => {
    // Was a defect: checkPlan had no opinion on validation at all, so a plan
    // could name a step nobody configured — validating nothing while appearing
    // to, or worse, inviting someone to later add a command matching the
    // invented name.
    const registry = buildValidationRegistry(
      ProjectConfigSchema.parse({
        project: { name: 'x', type: 'node' },
        commands: { test: 'npm test', lint: 'npm run lint' },
      }),
    );

    it('accepts ids the project declares', () => {
      const problems = checkPlan(
        plan([{ ...task('TASK-001', ['FR-001', 'FR-002']), validation: ['test', 'lint'] }]),
        SDD,
        registry,
      );
      expect(problems).toEqual([]);
    });

    it('rejects an id the project never declared, naming the task', () => {
      const problems = checkPlan(
        plan([{ ...task('TASK-001', ['FR-001', 'FR-002']), validation: ['e2e'] }]),
        SDD,
        registry,
      );

      expect(problems.join(' ')).toContain('TASK-001');
      expect(problems.join(' ')).toContain('e2e');
    });

    it('lists what was available, so the planner can correct itself', () => {
      const problems = checkPlan(
        plan([{ ...task('TASK-001', ['FR-001', 'FR-002']), validation: ['bench'] }]),
        SDD,
        registry,
      );
      expect(problems.join(' ')).toContain('lint, test');
    });

    it('says so plainly when the project configured nothing', () => {
      const empty = buildValidationRegistry(undefined);
      const problems = checkPlan(
        plan([{ ...task('TASK-001', ['FR-001', 'FR-002']), validation: ['test'] }]),
        SDD,
        empty,
      );
      expect(problems.join(' ')).toContain('none configured');
    });

    it('accepts an empty validation list', () => {
      const problems = checkPlan(
        plan([{ ...task('TASK-001', ['FR-001', 'FR-002']), validation: [] }]),
        SDD,
        registry,
      );
      expect(problems).toEqual([]);
    });
  });

  it('accepts a task citing an NFR or SEC the SDD defines', () => {
    // The regression that only a real SDD exposed: a plan legitimately citing
    // NFR-001 was rejected as referencing an undefined requirement, because
    // coverage and existence were being judged against the same filtered set.
    const problems = checkPlan(
      plan([
        task('TASK-001', ['FR-001', 'NFR-001']),
        task('TASK-002', ['FR-002', 'SEC-001'], ['TASK-001']),
      ]),
      `${SDD}
- NFR-001: Generation completes within 200ms.
- SEC-001: Only the owner may cancel.
`,
    );

    expect(problems).toEqual([]);
  });
});
