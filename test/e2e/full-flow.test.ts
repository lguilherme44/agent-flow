import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { StageRunner } from '../../src/app/stage-runner.js';
import { PromptLoader } from '../../src/app/prompt-loader.js';
import { PlanningPipeline } from '../../src/app/planning-pipeline.js';
import { TaskExecutor } from '../../src/app/task-executor.js';
import { Scheduler } from '../../src/app/scheduler.js';
import { initProject } from '../../src/app/init-project.js';
import { approveRun, checkApproval, approvalCoversPlan } from '../../src/app/approval.js';
import { runVerification } from '../../src/app/verification-commands.js';
import { checkDefinitionOfDone } from '../../src/core/definition-of-done.js';
import { assessHealth } from '../../src/core/health.js';
import { FallbackRunner } from '../../src/adapters/runners/fallback-runner.js';
import { GlobalConfigSchema, ProjectConfigSchema, ReviewResultSchema } from '../../src/contracts/index.js';

/**
 * The whole workflow, end to end, against scripted agents.
 *
 * No CLI is invoked and no quota is spent — that is the entire point of putting
 * `AgentRunner` behind a port. Without this the only way to know the pipeline
 * still works would be to run it for real, which costs money and minutes and
 * cannot go in CI.
 */

const PROJECT = '/repo';
const PROMPTS = '/pkg/prompts';
const REAL_PROMPTS = join(import.meta.dirname, '../../prompts');

const CAPS = {
  supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
  supportsReadOnly: true,
  supportsNonInteractive: true,
  supportsWorkingDirectory: true,
  structuredOutputStrategy: 'native',
} as const;

function config(overrides: Record<string, unknown> = {}) {
  return GlobalConfigSchema.parse({
    runners: { claude: { type: 'claude-code-cli' }, codex: { type: 'codex-cli' } },
    roles: {
      architect: { runner: 'claude', effort: 'high' },
      sdd: { runner: 'claude', effort: 'high' },
      planner: { runner: 'codex', effort: 'high' },
      planReviewer: { runner: 'claude', effort: 'high' },
      executors: {
        trivial: { runner: 'codex', effort: 'low' },
        normal: { runner: 'codex', effort: 'medium' },
        complex: { runner: 'codex', effort: 'high' },
      },
      verification: { runner: 'codex', effort: 'medium' },
      finalReviewer: { runner: 'claude', effort: 'very_high' },
    },
    ...overrides,
  });
}

const SDD = readFileSync(join(import.meta.dirname, '../app/fixtures-sdd.md'), 'utf8');

const PLAN = {
  feature: 'weekly-recurrence',
  tasks: [
    {
      id: 'TASK-001',
      title: 'Add recurrence types',
      description: 'Domain types.',
      complexity: 'trivial',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['Types compile.'],
      validation: ['npm test'],
    },
    {
      id: 'TASK-002',
      title: 'Implement generation',
      description: 'Generate occurrences.',
      complexity: 'normal',
      risk: 'medium',
      dependencies: ['TASK-001'],
      requirements: ['FR-001'],
      acceptanceCriteria: ['Occurrences are generated.'],
      validation: ['npm test'],
    },
  ],
};

const IMPLEMENTED = `Done.

## RESULT

STATUS: COMPLETED

FILES CHANGED:
- src/recurrence.js

VALIDATION:
- npm test: passed

DEVIATIONS:
- none

NOTES:
- none
`;

async function world(options: { globalConfig?: ReturnType<typeof config> } = {}) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const global = options.globalConfig ?? config();

  for (const file of readdirSync(REAL_PROMPTS)) {
    if (file.endsWith('.md')) {
      fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
    }
  }

  fs.seed(`${PROJECT}/package.json`, JSON.stringify({ name: 'demo', scripts: { test: 'npm test' } }));

  const runners = {
    claude: new FakeAgentRunner('claude', CAPS),
    codex: new FakeAgentRunner('codex', CAPS),
  };

  const processRunner = new FakeProcessRunner().always({ exitCode: 0 });
  const store = new StateStore({ fs, clock, projectDir: PROJECT });

  const stageRunner = new StageRunner({
    fs,
    clock,
    store,
    config: global,
    capabilities: { claude: CAPS, codex: CAPS },
    promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
    getRunner: (id) => runners[id as 'claude' | 'codex'],
    projectDir: PROJECT,
  });

  const projectConfig = ProjectConfigSchema.parse({
    project: { name: 'demo', type: 'node' },
    commands: { test: 'npm test' },
  });

  const pipeline = new PlanningPipeline({
    fs,
    clock,
    store,
    stageRunner,
    config: { global, project: projectConfig },
    capabilities: { claude: CAPS, codex: CAPS },
    projectDir: PROJECT,
  });

  const executor = new TaskExecutor({
    fs,
    clock,
    store,
    stageRunner,
    processRunner,
    config: { global, project: projectConfig },
    projectDir: PROJECT,
  });

  return { fs, clock, store, runners, processRunner, pipeline, executor, global, projectConfig };
}

/** Scripts a clean planning run: discovery, impact, SDD (claude) then plan (codex), review (claude). */
function scriptPlanning(runners: { claude: FakeAgentRunner; codex: FakeAgentRunner }): void {
  runners.claude.pushText('# Architecture\n\nA small Node module.');
  runners.claude.pushText('# Architecture Impact\n\nTouches the store.');
  runners.claude.pushText(SDD);
  runners.codex.pushJson(PLAN);
  runners.claude.pushJson({ verdict: 'PASS', summary: 'Sound.', findings: [] });
}

describe('the happy path, from an empty repository to a finished feature', () => {
  it('runs init → plan → review → approve → execute → done', async () => {
    const w = await world();

    // ---- init
    const initResult = await initProject({ fs: w.fs, projectDir: PROJECT });
    expect(initResult.stack.type).toBe('node');

    // ---- plan
    const run = await w.store.createRun('weekly recurrence');
    scriptPlanning(w.runners);
    const planning = await w.pipeline.run(run.runId, 'Add weekly recurrence');

    expect(planning.review?.verdict).toBe('PASS');
    expect(planning.review?.independence).toBe('cross-provider');

    // ---- approve
    const state = await w.store.loadRun(run.runId);
    const check = checkApproval(state, planning.plan, planning.review ?? null);
    expect(check.allowed).toBe(true);

    const approved = await approveRun(w.store, run.runId, planning.plan);
    expect(approvalCoversPlan(approved, planning.plan)).toBe(true);

    // ---- execute
    w.runners.codex.pushText(IMPLEMENTED).pushText(IMPLEMENTED);
    const outcome = await new Scheduler({ store: w.store, executor: w.executor }).run(
      planning.plan,
      run.runId,
      SDD,
    );

    expect(outcome.complete).toBe(true);
    expect(outcome.results.map((r) => r.task)).toEqual(['TASK-001', 'TASK-002']);

    // ---- verify and judge
    const verification = await runVerification({
      processRunner: w.processRunner,
      project: w.projectConfig,
      cwd: PROJECT,
    });

    const done = checkDefinitionOfDone({
      approved: true,
      taskStates: outcome.results.map((r) => r.status),
      verificationPassed: verification.passed,
      finalReviewVerdict: 'PASS',
    });

    expect(done.done).toBe(true);
  });

  it('never invokes a real CLI', async () => {
    // The property that lets this suite live in CI.
    const w = await world();
    const run = await w.store.createRun('f');
    scriptPlanning(w.runners);

    await w.pipeline.run(run.runId, 'Add weekly recurrence');

    for (const call of w.processRunner.calls) {
      expect(['claude', 'codex']).not.toContain(call.command);
    }
  });
});

describe('the plan is rejected', () => {
  it('stops at the gate and refuses approval', async () => {
    const w = await world();
    const run = await w.store.createRun('f');

    w.runners.claude.pushText('# Architecture');
    w.runners.claude.pushText('# Impact');
    w.runners.claude.pushText(SDD);
    w.runners.codex.pushJson(PLAN);
    w.runners.claude.pushJson({
      verdict: 'FAIL',
      findings: [
        {
          severity: 'high',
          type: 'missing_test',
          description: 'Nothing tests the generated occurrences.',
          suggestedAction: 'Add a test task.',
        },
      ],
    });

    const planning = await w.pipeline.run(run.runId, 'Add weekly recurrence');
    const state = await w.store.loadRun(run.runId);

    expect(state.status).toBe('plan_rejected');
    expect(checkApproval(state, planning.plan, planning.review ?? null).allowed).toBe(false);
  });
});

describe('a task blocks', () => {
  it('halts the run and leaves the reason on the result', async () => {
    const w = await world();
    const run = await w.store.createRun('f');
    scriptPlanning(w.runners);
    const planning = await w.pipeline.run(run.runId, 'Add weekly recurrence');
    await approveRun(w.store, run.runId, planning.plan);

    w.runners.codex.pushText(
      '## RESULT\n\nSTATUS: BLOCKED\n\nNOTES:\n- The SDD does not say where this belongs.\n',
    );

    const outcome = await new Scheduler({ store: w.store, executor: w.executor }).run(
      planning.plan,
      run.runId,
      SDD,
    );

    expect(outcome.complete).toBe(false);
    expect(outcome.results[0]?.status).toBe('blocked');
    expect(outcome.blocked).toContain('TASK-002');
    // Not retried: BLOCKED means a missing decision (§23).
    expect(w.runners.codex.calls).toHaveLength(2);
  });
});

describe('validation fails', () => {
  it('sends the task to review rather than to another model (§55)', async () => {
    const w = await world();
    const run = await w.store.createRun('f');
    scriptPlanning(w.runners);
    const planning = await w.pipeline.run(run.runId, 'Add weekly recurrence');
    await approveRun(w.store, run.runId, planning.plan);

    w.processRunner.always({ exitCode: 1, stdout: 'expected 1 to be 2' });
    w.runners.codex.pushText(IMPLEMENTED);

    const outcome = await new Scheduler({ store: w.store, executor: w.executor }).run(
      planning.plan,
      run.runId,
      SDD,
    );

    expect(outcome.results[0]?.status).toBe('review_required');
    expect(outcome.complete).toBe(false);
  });
});

describe('quota is exhausted and a fallback exists', () => {
  it('completes on the fallback runner and records the substitution', async () => {
    const primary = new FakeAgentRunner('codex', CAPS);
    const secondary = new FakeAgentRunner('claude', CAPS);
    const events: string[] = [];

    const runner = new FallbackRunner({
      primary,
      secondary,
      onFallback: (event) => {
        events.push(`${event.from}->${event.to}:${event.errorCode}`);
      },
    });

    primary.pushFailure('quota_exceeded');
    secondary.pushText('done');

    const result = await runner.run({
      prompt: 'implement',
      reasoning: 'high',
      workingDirectory: PROJECT,
      permissions: 'write',
      timeoutSeconds: 60,
    });

    expect(result.ok).toBe(true);
    expect(events).toEqual(['codex->claude:quota_exceeded']);
  });
});

describe('resume after the process is killed', () => {
  it('does not pay again for work already completed', async () => {
    const w = await world();
    const run = await w.store.createRun('f');
    scriptPlanning(w.runners);
    const planning = await w.pipeline.run(run.runId, 'Add weekly recurrence');
    await approveRun(w.store, run.runId, planning.plan);

    // First task completes, then the process "dies".
    w.runners.codex.pushText(IMPLEMENTED).pushFailure('timeout');
    await new Scheduler({ store: w.store, executor: w.executor }).run(
      planning.plan,
      run.runId,
      SDD,
    );

    const afterCrash = await w.store.loadRun(run.runId);
    expect(afterCrash.tasks.find((t) => t.id === 'TASK-001')?.state).toBe('completed');
    expect(afterCrash.tasks.find((t) => t.id === 'TASK-002')?.state).toBe('failed');

    // A plain resume does nothing: the scheduler never retries on its own, or
    // an outage would turn into an unbounded loop paying for the same failure.
    const callsBefore = w.runners.codex.calls.length;
    const plainResume = await new Scheduler({ store: w.store, executor: w.executor }).run(
      planning.plan,
      run.runId,
      SDD,
      Object.fromEntries(afterCrash.tasks.map((t) => [t.id, t.state])),
    );

    expect(w.runners.codex.calls.length).toBe(callsBefore);
    expect(plainResume.complete).toBe(false);

    // `retry` is what puts it back in the queue — explicit and bounded (§23).
    const requeued = Object.fromEntries(
      afterCrash.tasks.map((t) => [t.id, t.id === 'TASK-002' ? 'queued' : t.state]),
    );

    w.runners.codex.pushText(IMPLEMENTED);
    const resumed = await new Scheduler({ store: w.store, executor: w.executor }).run(
      planning.plan,
      run.runId,
      SDD,
      requeued,
    );

    // Exactly one call: the completed task is not paid for twice.
    expect(w.runners.codex.calls.length - callsBefore).toBe(1);
    expect(resumed.states['TASK-002']).toBe('completed');
    expect(resumed.complete).toBe(true);
  });
});

describe('the environment is degraded', () => {
  it('runs to a plan with one provider, and says what was lost', async () => {
    // Same-provider review is permitted (§56) but is a weaker guarantee, and
    // the run has to carry that fact rather than leaving it to be inferred.
    const singleProvider = config({
      roles: {
        ...config().roles,
        planner: { runner: 'claude', effort: 'high' },
        executors: {
          trivial: { runner: 'claude', effort: 'low' },
          normal: { runner: 'claude', effort: 'medium' },
          complex: { runner: 'claude', effort: 'high' },
        },
        verification: { runner: 'claude', effort: 'medium' },
      },
    });

    const w = await world({ globalConfig: singleProvider });
    const run = await w.store.createRun('f');

    w.runners.claude
      .pushText('# Architecture')
      .pushText('# Impact')
      .pushText(SDD)
      .pushJson(PLAN)
      .pushJson({ verdict: 'PASS', findings: [] });

    const planning = await w.pipeline.run(run.runId, 'Add weekly recurrence');

    expect(planning.review?.independence).toBe('same-provider-fresh-context');

    const state = await w.store.loadRun(run.runId);
    expect(state.degradations.map((d) => d.kind)).toContain('single_provider');

    // And the person approving is told before they sign.
    const check = checkApproval(state, planning.plan, planning.review ?? null);
    expect(check.allowed).toBe(true);
    expect(check.warnings.join(' ')).toMatch(/same-provider/i);
  });

  it('reports FAIL when a role has nowhere to run', async () => {
    const verdict = assessHealth(config(), [
      { id: 'claude', installed: true, executable: true, auth: 'configured' },
      { id: 'codex', installed: true, executable: false, auth: 'unknown' },
    ]);

    expect(verdict.status).toBe('FAIL');
    expect(verdict.orphanRoles).toContain('planner');
  });
});

describe('the approved plan is edited afterwards', () => {
  it('invalidates the approval', async () => {
    // The gate is granted to a specific document (§17).
    const w = await world();
    const run = await w.store.createRun('f');
    scriptPlanning(w.runners);
    const planning = await w.pipeline.run(run.runId, 'Add weekly recurrence');

    const approved = await approveRun(w.store, run.runId, planning.plan);

    const edited = {
      ...planning.plan,
      tasks: [{ ...planning.plan.tasks[0], title: 'Something else entirely' }],
    } as typeof planning.plan;

    expect(approvalCoversPlan(approved, edited)).toBe(false);
  });
});

describe('artifacts', () => {
  it('leaves a complete, readable trail', async () => {
    const w = await world();
    const run = await w.store.createRun('f');
    scriptPlanning(w.runners);
    await w.pipeline.run(run.runId, 'Add weekly recurrence');

    expect(await w.store.readArtifact(run.runId, 'request')).toContain('weekly recurrence');
    expect(await w.store.readArtifact(run.runId, 'sdd')).toContain('FR-001');
    expect(await w.store.readArtifact(run.runId, 'plan')).toContain('TASK-001');

    const review = ReviewResultSchema.parse(
      JSON.parse((await w.store.readArtifact(run.runId, 'planReview')) ?? '{}'),
    );
    expect(review.verdict).toBe('PASS');

    const events = (await w.store.readEvents(run.runId)).map((event) => event.type);
    expect(events).toContain('run_created');
    expect(events).toContain('stage_completed');
  });
});
