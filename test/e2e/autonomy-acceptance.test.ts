import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { StateStore } from '../../src/app/state-store.js';
import { Scheduler } from '../../src/app/scheduler.js';
import { checkPlanningPreflight } from '../../src/app/run-git-identity.js';
import { evaluateRound } from '../../src/core/corrective-envelope.js';
import { assertObservableChange } from '../../src/core/acceptance.js';
import { checkDefinitionOfDone } from '../../src/core/definition-of-done.js';
import { classifyRunnerFailure, consumesAttempt } from '../../src/core/failure-classification.js';
import { resolveRole } from '../../src/core/role.js';
import { runPaths } from '../../src/app/paths.js';
import { DEFAULT_GLOBAL_CONFIG_YAML } from '../../src/config/defaults.js';
import { parse as parseYaml } from 'yaml';
import {
  GlobalConfigSchema,
  PlanSchema,
  TaskResultSchema,
} from '../../src/contracts/index.js';
import { makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { FakeHost } from '../fakes/fake-host.js';
import type { EffectiveConfig } from '../../src/contracts/index.js';

/**
 * AR-10 — the milestone, held to §10's own pass criteria.
 *
 * §10.1 asks for the AF-2026-002 request re-run **with deliberately seeded recoverable
 * failures, so the recovery paths are exercised rather than merely available**. This is
 * that scenario list, executed against scripted runners: every seeded failure is one the
 * evidence run actually hit, and every assertion is a row of §10.2.
 *
 * **What this is not.** A dogfood against live runners is an exercise with a cost — the
 * original took 244 minutes and 21 model calls — and it is the owner's to spend. What can
 * be proved without spending it is that each recovery path *fires*, mechanically, on the
 * input that produced the original defect. That is what a regression suite is for; the
 * live run is what a benchmark is for, and §10.3's wall-clock numbers can only come from
 * there.
 *
 * Every scenario below names the intervention it removes from the evidence run's sixteen.
 */

const PROJECT = '/repo';

let repo: TempRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

const CAPS = {
  supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
  supportsReadOnly: true,
  supportsNonInteractive: true,
  supportsWorkingDirectory: true,
  structuredOutputStrategy: 'native',
  nonInteractiveToolGrants: { fileEdit: true, commandExecution: true },
} as const;

/** The shipped defaults, so the suite measures the product rather than a literal. */
const SHIPPED = GlobalConfigSchema.parse(parseYaml(DEFAULT_GLOBAL_CONFIG_YAML));

function configWith(overrides: Record<string, unknown> = {}) {
  return GlobalConfigSchema.parse({
    ...parseYaml(DEFAULT_GLOBAL_CONFIG_YAML),
    runners: { claude: { type: 'claude-code-cli' } },
    roles: {
      architect: { runner: 'claude', effort: 'high' },
      sdd: { runner: 'claude', effort: 'high' },
      planner: { runner: 'claude', effort: 'high' },
      planReviewer: { runner: 'claude', effort: 'high' },
      executors: {
        trivial: { runner: 'claude', effort: 'low' },
        normal: { runner: 'claude', effort: 'medium' },
        complex: { runner: 'claude', effort: 'high' },
      },
      verification: { runner: 'claude', effort: 'medium' },
      finalReviewer: { runner: 'claude', effort: 'high' },
    },
    ...overrides,
  });
}

/**
 * §10.1 scenario 1 — the evidence run's intervention #0.
 *
 * `agent-flow feature` reached Discovery in a repository that had never been initialised,
 * and the `init` that followed moved HEAD and invalidated a planningBase the run had
 * already frozen.
 */
describe('scenario 1: an uninitialised project costs nothing', () => {
  it('refuses before a run exists, in either isolation mode', async () => {
    repo = await makeTempRepoWithCommit();

    for (const useWorktrees of [true, false]) {
      const outcome = await checkPlanningPreflight({
        workspaces: repo.workspaces,
        fs: new NodeFileSystem(),
        host: new FakeHost(1000, 'test', [1000], repo.home),
        config: { global: { git: { useWorktrees } } } as unknown as EffectiveConfig,
        projectDir: repo.dir,
      });

      expect(outcome.satisfied, `useWorktrees=${String(useWorktrees)}`).toBe(false);
      if (outcome.satisfied) continue;
      expect(outcome.code).toBe('project_not_initialized');
    }

    // 0 runs created, HEAD unchanged — the two facts C-01 makes checkable.
    expect(existsSync(join(repo.dir, '.agent-flow', 'runs'))).toBe(false);
  });
});

/**
 * §10.1 scenario 3 — the evidence run's intervention #4.
 *
 * `executor.normal` at an effort the selected model does not support. The invocation was
 * accepted at the wrong effort, failed, and cost a task attempt — which then forced
 * `retry --force`, a mechanism for deliberately overruling a gate, spent on miscounting.
 */
describe('scenario 3: a model/effort mismatch clamps and costs no attempt', () => {
  it('resolves to the nearest supported level below, and never invokes the unsupported one', () => {
    const narrow = {
      claude: (model?: string) =>
        model === 'narrow-model'
          ? { ...CAPS, supportedReasoningLevels: ['low', 'high'] as const }
          : CAPS,
    };

    const resolved = resolveRole(
      'executor.normal',
      configWith({
        roles: {
          ...configWith().roles,
          executors: {
            ...configWith().roles.executors,
            normal: { runner: 'claude', model: 'narrow-model', effort: 'medium' },
          },
        },
      }),
      narrow,
    );

    expect(resolved.reasoning).toBe('low');
    expect(resolved.reasoningClamped).toBe(true);
    // The evidence C-03 requires, carried rather than recomputed.
    expect(resolved.requestedReasoning).toBe('medium');
    expect(resolved.supportedReasoningLevels).toEqual(['low', 'high']);
  });

  it('is a PRE_EXECUTION class, so it can never touch the attempt budget (I-22)', () => {
    expect(consumesAttempt('model_capability_mismatch')).toBe(false);
  });
});

/**
 * §10.1 scenario 5 — eleven of the evidence run's sixteen manual operations came after
 * approval, and none of them was a decision.
 */
describe('scenario 5: a seeded validation failure recovers itself', () => {
  async function seeded() {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock();
    const store = new StateStore({ fs, clock, projectDir: PROJECT });
    const run = await store.createRun('recover me');

    let calls = 0;
    const executor = {
      execute: async (task: { id: string }) => {
        calls += 1;
        const first = calls === 1;
        return TaskResultSchema.parse({
          task: task.id,
          status: first ? 'review_required' : 'completed',
          runner: 'claude',
          reasoning: 'medium',
          startedAt: '2026-08-17T10:00:00.000Z',
          finishedAt: '2026-08-17T10:00:01.000Z',
          ...(first ? { failureClass: 'validation_unsatisfied' } : {}),
          validation: {
            passed: !first,
            commands: first
              ? [
                  {
                    id: 'test',
                    command: 'npm test',
                    exitCode: 1,
                    durationMs: 10,
                    stdout: '',
                    stderr: 'AssertionError: expected 2, got 3',
                  },
                ]
              : [],
          },
        });
      },
    } as never;

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [
        {
          id: 'TASK-001',
          title: 'T',
          description: 'D',
          complexity: 'normal',
          risk: 'low',
          dependencies: [],
          requirements: ['FR-001'],
          acceptanceCriteria: ['The suite passes.'],
          validation: ['test'],
        },
      ],
    });

    const outcome = await new Scheduler({
      store,
      executor,
      recoveryConfig: SHIPPED.recovery,
      maxAttempts: 3,
      fs,
      projectDir: PROJECT,
    }).run(plan, run.runId, 'SDD');

    return { fs, store, run, outcome, calls: () => calls };
  }

  it('finishes with no human action', async () => {
    const world = await seeded();

    expect(world.outcome.complete).toBe(true);
    expect(world.outcome.haltedBy).toBeUndefined();
    expect(world.calls()).toBe(2);
  });

  it('tells the retry what failed, mechanically', async () => {
    // §10.2: manual log inspection 0. The packet carries what a person used to have to
    // read out of a log and re-explain by hand.
    const world = await seeded();
    const packet = JSON.parse(
      await world.fs.readFile(runPaths(PROJECT, world.run.runId).attemptContext('TASK-001', 2)),
    ) as Record<string, unknown>;

    expect(packet['failureClass']).toBe('validation_unsatisfied');
    expect(JSON.stringify(packet['failedChecks'])).toContain('npm test');
    expect(JSON.stringify(packet['failedChecks'])).toContain('expected 2, got 3');
  });

  it('carries no patch, so a rejected attempt never becomes a starting point', async () => {
    const world = await seeded();
    const raw = await world.fs.readFile(
      runPaths(PROJECT, world.run.runId).attemptContext('TASK-001', 2),
    );

    expect(raw).not.toMatch(/^\+\+\+|^---|@@/m);
  });

  it('records the recovery rather than performing it silently', async () => {
    const world = await seeded();
    const types = (await world.store.readEvents(world.run.runId)).map((event) => event.type);

    expect(types).toContain('recovery_started');
    expect(types).toContain('failure_context_built');
    expect(types).toContain('recovery_step_completed');
  });
});

/**
 * §10.1 scenario 6 — the finding that ordered the whole milestone.
 *
 * Three of six tasks produced a Git tree identical to their base, were recorded
 * `completed`, and were integrated. The run's final FAIL was caused by that rather than by
 * anything the corrective path could have fixed.
 */
describe('scenario 6: a task that changed nothing does not complete', () => {
  const tree = 'a'.repeat(40);

  it('refuses an empty diff, and says so with both hashes', () => {
    const verdict = assertObservableChange({ baseTree: tree, validatedTree: tree });

    expect(verdict.satisfied).toBe(false);
    if (verdict.satisfied) return;
    expect(verdict.failureClass).toBe('acceptance_evidence_missing');
    expect(verdict.detail).toContain(tree.slice(0, 12));
  });

  it('admits the verification task that legitimately changed nothing', () => {
    // TASK-006 was real work with an empty diff. Intent belongs in the plan, declared
    // before the fact — inferring it from an empty `files.likely` would have been exactly
    // backwards, because that task declared three files it was meant to leave alone.
    expect(
      assertObservableChange({ baseTree: tree, validatedTree: tree, expectsNoChange: true }),
    ).toEqual({ satisfied: true });
  });
});

/**
 * §10.1 scenario 7 — the corrective round that needed a human and should not have.
 */
describe('scenario 7: a corrective round inside the envelope needs no approval', () => {
  const context = {
    touchedFiles: ['test/cli/cli.test.ts', 'scripts/packaging-smoke.mjs'],
    declaredRequirements: ['FR-005', 'FR-006', 'NFR-004'],
    declaredValidationIds: ['test', 'lint'],
    contractPaths: ['src/contracts/'],
  };
  const budget = { correctiveRoundsUsed: 0, maxCorrectiveRounds: 2 };

  it('admits the evidence run’s own three findings', () => {
    // §10 names this outcome: all three touched files the run had already changed and
    // cited requirements the SDD already declared.
    const round = evaluateRound(
      [
        { id: 'FIX-001', files: ['test/cli/cli.test.ts'], requirements: ['FR-005'], validation: ['test'] },
        { id: 'FIX-002', files: ['test/cli/cli.test.ts'], requirements: ['FR-006'], validation: ['test'] },
        { id: 'FIX-003', files: ['scripts/packaging-smoke.mjs'], requirements: ['NFR-004'], validation: ['test'] },
      ],
      context,
      budget,
    );

    expect(round.mayProceed).toBe(true);
    expect(round.clearsApproval).toBe(false);
  });

  it('reopens approval for a finding that would add a contract', () => {
    // §10's synthetic case, and the one that proves the envelope is a gate rather than a
    // rubber stamp.
    const round = evaluateRound(
      [{ id: 'FIX-001', files: ['src/contracts/new.schema.ts'], requirements: ['FR-005'], validation: ['test'] }],
      context,
      budget,
    );

    expect(round.mayProceed).toBe(false);
    expect(round.outside?.failed).toBe('contract');
  });
});

/**
 * §10.2's last row — "contradictory verdicts rendered: 0".
 *
 * The evidence run printed `Verification: PASS` directly beneath four mechanical `✗`
 * marks, and the operator reasonably concluded the tool was lying.
 */
describe('the four verdicts never collapse into one', () => {
  const base = { approved: true, taskStates: ['completed'] as const, finalReviewVerdict: 'PASS' as const };

  it('is not done when the commands could not run, and says it is the environment', () => {
    const check = checkDefinitionOfDone({ ...base, mechanicalVerification: 'NOT_RUN' });

    expect(check.done).toBe(false);
    expect(check.conditions.find((c) => c.name.includes('lint'))?.detail).toMatch(/environment/i);
  });

  it('does not let a model verdict stand in for a build nobody ran', () => {
    const check = checkDefinitionOfDone({ ...base, mechanicalVerification: 'NOT_RUN' });
    expect(check.conditions.find((c) => c.name.includes('final review'))?.met).toBe(false);
  });
});

/**
 * §10.2 — "mechanical failures reported only as `execution_failed`: 0 where a class is
 * known", and "hidden runner failures: 0".
 */
describe('no failure is reported only as a transport code', () => {
  it('names the denial that cost the evidence run an attempt', () => {
    const result = classifyRunnerFailure({
      errorCode: 'execution_failed',
      redactedRaw: 'soft-denying tool confirmation "Bash"\npermission check failed',
    });

    expect(result.failureClass).toBe('runner_permission_required');
    expect(result.deniedCommand).toBe('Bash');
    // And it spends no attempt, which is what made `retry --force` unnecessary.
    expect(consumesAttempt(result.failureClass)).toBe(false);
  });

  it('does not invent a class where the evidence is silent', () => {
    // The discipline that makes the line above trustworthy. Falling back is always a
    // correct answer; a guess is not.
    expect(
      classifyRunnerFailure({ errorCode: 'execution_failed', redactedRaw: 'segmentation fault' })
        .failureClass,
    ).toBe('runner_execution_failed');
  });
});

/**
 * §10.2 — "recovery loops without bounded termination: 0".
 *
 * Every budget in §6 has a test of its own; this asserts the property they exist for, at
 * the level a person cares about: the loop stops.
 */
describe('every automatic loop terminates', () => {
  it('stops a task that keeps producing the same failure', async () => {
    const fs = new InMemoryFileSystem();
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: PROJECT });
    const run = await store.createRun('never converges');

    let calls = 0;
    const executor = {
      execute: async (task: { id: string }) => {
        calls += 1;
        if (calls > 25) throw new Error('the recovery loop did not terminate');
        return TaskResultSchema.parse({
          task: task.id,
          status: 'review_required',
          runner: 'claude',
          reasoning: 'medium',
          startedAt: '2026-08-17T10:00:00.000Z',
          finishedAt: '2026-08-17T10:00:01.000Z',
          failureClass: 'validation_unsatisfied',
          validation: { passed: false, commands: [] },
        });
      },
    } as never;

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [
        {
          id: 'TASK-001',
          title: 'T',
          description: 'D',
          complexity: 'normal',
          risk: 'low',
          dependencies: [],
          requirements: ['FR-001'],
          acceptanceCriteria: ['done'],
          validation: [],
        },
      ],
    });

    const outcome = await new Scheduler({
      store,
      executor,
      recoveryConfig: SHIPPED.recovery,
      maxAttempts: 10,
      fs,
      projectDir: PROJECT,
    }).run(plan, run.runId, 'SDD');

    expect(calls).toBeLessThan(25);
    expect(outcome.haltedBy).toBeDefined();

    // And the escalation names one action, which is what §3.6 requires of every one.
    const exhausted = (await store.readEvents(run.runId)).find(
      (event) => event.type === 'recovery_exhausted',
    );
    expect(String(exhausted?.detail?.['humanAction'] ?? '')).not.toHaveLength(0);
  });
});
