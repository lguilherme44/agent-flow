import { describe, it, expect } from 'vitest';
import { checkPlan } from '../../src/app/stages/planning-checks.js';
import { PlanSchema, ProjectConfigSchema, type Plan } from '../../src/contracts/index.js';
import { buildValidationRegistry } from '../../src/core/validation-registry.js';
import type { ExecutorCommands } from '../../src/core/command-grants.js';

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

    it('says how to declare the id, in the form the config takes (FR-023)', () => {
      const problems = checkPlan(
        plan([{ ...task('TASK-001', ['FR-001', 'FR-002']), validation: ['bench'] }]),
        SDD,
        registry,
      );
      const message = problems.join(' ');
      expect(message).toContain('validationCommands');
      expect(message).toContain('.agent-flow/config.yaml');
      expect(message).toContain('"<id>: <command>"');
      expect(message).toContain('"bench: <command>"');
      expect(message).toContain('available: lint, test');
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

  describe('a planner task citing a command nobody can run (FR-009, SEC-003)', () => {
    const project = ProjectConfigSchema.parse({
      project: { name: 'x', type: 'node' },
      commands: { test: 'npm run test' },
    });
    const registry = buildValidationRegistry(project);
    const declared = registry.ids.map((id) => registry.resolve(id) ?? '');
    const bounded: ExecutorCommands = { known: true, any: false, prefixes: ['npm run test'] };
    const citations = (executor: ExecutorCommands = bounded) => ({ declared, executor });

    const android = {
      ...task('TASK-001', ['FR-001', 'FR-002']),
      description: 'Confirm the screen on a device with `npm run e2e:android` before merging.',
      validation: ['test'],
    };

    it('refuses it, naming the task, the field, the citation and the way out', () => {
      const problems = checkPlan(plan([android]), SDD, registry, citations());

      expect(problems).toHaveLength(1);
      const [message] = problems;
      expect(message).toContain('task TASK-001');
      expect(message).toContain('in its description');
      expect(message).toContain('`npm run e2e:android`');
      expect(message).toContain('the executor may run: npm run test');
      expect(message).toContain('available: test');
      expect(message).toContain('operatorVerifications');
    });

    it('passes once the measurement moves to operatorVerifications', () => {
      const moved = PlanSchema.parse({
        feature: 'recurring-bookings',
        tasks: [{ ...android, description: 'Implements the screen.' }],
        operatorVerifications: [
          { check: 'Run `npm run e2e:android` on a device.', reason: 'The executor has no device.' },
        ],
      });
      expect(checkPlan(moved, SDD, registry, citations())).toEqual([]);
    });

    it('reads the title and the acceptance criteria too, and names which', () => {
      const problems = checkPlan(
        plan([
          {
            ...task('TASK-001', ['FR-001', 'FR-002']),
            title: 'Wire `npm run e2e:ios` into the screen',
            acceptanceCriteria: ['Works.', 'Passes:\n```\nnpm run e2e:android\n```'],
          },
        ]),
        SDD,
        registry,
        citations(),
      );
      expect(problems.join('\n')).toContain('`npm run e2e:ios` in its title');
      expect(problems.join('\n')).toContain('`npm run e2e:android` in its acceptanceCriteria');
    });

    it('does not refuse a command an operator grant covers', () => {
      const granted: ExecutorCommands = { known: true, any: false, prefixes: ['npm run test', 'npx vitest'] };
      const vitest = {
        ...task('TASK-001', ['FR-001', 'FR-002']),
        description: 'Check it with `npx vitest run test/core/x.test.ts`.',
      };
      expect(checkPlan(plan([vitest]), SDD, registry, citations(granted))).toEqual([]);
      // Positive control: with an `npx` grant that does not cover it, the same span is refused.
      const other: ExecutorCommands = { known: true, any: false, prefixes: ['npm run test', 'npx tsc'] };
      expect(checkPlan(plan([vitest]), SDD, registry, citations(other))).toHaveLength(1);
    });

    it('does not refuse a declared line, nor a single-word span', () => {
      const prose = {
        ...task('TASK-001', ['FR-001', 'FR-002']),
        description: 'Run `npm run test -- --run` after `npm` is upgraded.',
      };
      expect(checkPlan(plan([prose]), SDD, registry, citations())).toEqual([]);
    });

    it('refuses nothing when the executor is unknown or may run anything', () => {
      expect(checkPlan(plan([android]), SDD, registry, citations({ known: false, any: false, prefixes: [] }))).toEqual([]);
      expect(checkPlan(plan([android]), SDD, registry, citations({ known: true, any: true, prefixes: [] }))).toEqual([]);
    });

    it('does not run for a caller that passes no citations — the corrective round', () => {
      expect(checkPlan(plan([android]), SDD, registry)).toEqual([]);
    });
  });

  describe('requiredEvidence must be validated by the same task (FR-024)', () => {
    const registry = buildValidationRegistry(
      ProjectConfigSchema.parse({
        project: { name: 'x', type: 'node' },
        commands: { test: 'npm run test' },
        validationCommands: { 'test-deck': 'npm run test:deck' },
      }),
    );
    const citations = { declared: ['npm run test', 'npm run test:deck'], executor: { known: false, any: false, prefixes: [] } };
    const evidenced = (validation: string[]) =>
      plan([{ ...task('TASK-001', ['FR-001', 'FR-002']), validation, requiredEvidence: ['test-deck'] }]);

    it('refuses an evidence id nothing would run, with the remedy', () => {
      const problems = checkPlan(evidenced(['test']), SDD, registry, citations);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('task TASK-001');
      expect(problems[0]).toContain('"test-deck"');
      expect(problems[0]).toContain('nothing would run it');
      expect(problems[0]).toContain("add \"test-deck\" to the task's validation or drop it from requiredEvidence");
    });

    it('accepts it once the task validates with it', () => {
      expect(checkPlan(evidenced(['test', 'test-deck']), SDD, registry, citations)).toEqual([]);
    });

    it('is planner-only: a plan checked without citations is not refused', () => {
      expect(checkPlan(evidenced(['test']), SDD, registry)).toEqual([]);
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
