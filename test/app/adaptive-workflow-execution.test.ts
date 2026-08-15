import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { PlanSchema, type WorkflowClass } from '../../src/contracts/index.js';
import { planHash } from '../../src/app/approval.js';
import { review, start, type RunActionDeps } from '../../src/app/run-actions.js';

const PROJECT_CONFIG = `project:
  name: test-project
  type: node
commands: {}
validationCommands: {}
`;

const PROMPTS = [
  'discovery',
  'architecture-impact',
  'sdd',
  'planning',
  'plan-review',
  'verification',
  'final-review',
];

const PLAN = {
  feature: 'dark-theme-toggle',
  tasks: [
    {
      id: 'TASK-001',
      title: 'Implement dark theme',
      description: 'Add dark mode toggle and tokens.',
      complexity: 'trivial',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['Theme switches cleanly.'],
      validation: [],
    },
  ],
};

async function createTestHarness(options: {
  workflow?: WorkflowClass;
  sdd?: string | null;
  approved?: boolean;
}) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const host = new FakeHost();

  fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);
  for (const name of PROMPTS) {
    fs.seed(
      `/install/prompts/${name}.md`,
      `---\npermissions: read-only\noutputFormat: json\nrequiredVars: []\n---\n\n# ${name}\n`,
    );
  }
  fs.seed(
    '/install/prompts/implementation.md',
    '---\npermissions: write\noutputFormat: markdown\nrequiredVars: [task, sdd, projectConfig, agentsMd]\n---\n\n# implementation\n',
  );

  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const run = await store.createRun('dark theme toggle', () => ({
    isolationMode: 'none' as const,
    ...(options.workflow === undefined ? {} : { workflow: options.workflow }),
  }));

  const parsedPlan = PlanSchema.parse(PLAN);
  await store.writeArtifact(run.runId, 'plan', JSON.stringify(parsedPlan, null, 2));

  if (options.sdd !== null && options.sdd !== undefined) {
    await store.writeArtifact(run.runId, 'sdd', options.sdd);
  }

  const hash = planHash(parsedPlan);
  await store.writeArtifact(
    run.runId,
    'planReview',
    JSON.stringify({
      verdict: 'PASS',
      independence: 'cross-provider',
      reviewer: { runner: 'codex', reasoning: 'high' },
      planHash: hash,
      findings: [],
    }),
  );

  await store.updateRun(run.runId, (state) => ({
    ...state,
    status: options.approved ? 'approved' : 'waiting_for_approval',
    approved: options.approved ?? false,
    approvedAt: options.approved ? clock.now() : undefined,
    approvedPlanHash: options.approved ? hash : undefined,
    tasks: [{ id: 'TASK-001', state: 'queued', attempts: 0 }],
  }));

  const fakeRunner = new FakeProcessRunner().always((opts) => {
    if (opts.args.includes('--version') || opts.command === 'git') {
      return { exitCode: 0, stdout: '1.0.0' };
    }
    // Review and verification responses require valid JSON schema
    if (opts.args.includes('--json-schema')) {
      const payload = {
        verdict: 'PASS',
        summary: 'Looks good.',
        findings: [],
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          is_error: false,
          subtype: 'success',
          result: JSON.stringify(payload),
          structured_output: payload,
        }),
      };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        is_error: false,
        subtype: 'success',
        result: `## RESULT\n\nSTATUS: COMPLETED\n\nFILES CHANGED:\n- index.html\n\nDEVIATIONS:\n- none\n\nNOTES:\n- none\n`,
      }),
    };
  });

  const deps: RunActionDeps = {
    fs,
    clock,
    processRunner: fakeRunner,
    projectDir: '/repo',
    globalConfigPath: '/install/config.yaml',
    promptsDir: '/install/prompts',
    host,
    owner: 'cli',
  };

  return { fs, host, store, deps, runId: run.runId, parsedPlan, hash };
}

describe('Adaptive Workflow Execution & Review without SDD', () => {
  it('allows SIMPLE workflow execution when SDD is absent and plan is approved', async () => {
    const { deps, runId } = await createTestHarness({
      workflow: 'simple',
      sdd: null,
      approved: true,
    });

    const outcome = await start(deps, runId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('Expected ok');
    expect(outcome.value.taskCount).toBe(1);
    expect(outcome.value.outcome.complete).toBe(true);
  });

  it('allows TRIVIAL workflow execution when SDD is absent and plan is approved', async () => {
    const { deps, runId } = await createTestHarness({
      workflow: 'trivial',
      sdd: null,
      approved: true,
    });

    const outcome = await start(deps, runId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('Expected ok');
    expect(outcome.value.taskCount).toBe(1);
    expect(outcome.value.outcome.complete).toBe(true);
  });

  it('refuses STANDARD workflow execution when SDD is absent', async () => {
    const { deps, runId } = await createTestHarness({
      workflow: 'standard',
      sdd: null,
      approved: true,
    });

    const outcome = await start(deps, runId);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.code).toBe('no_sdd');
    expect(!outcome.ok && outcome.error.message).toContain('STANDARD workflow requires');
  });

  it('refuses HIGH-RISK workflow execution when SDD is absent', async () => {
    const { deps, runId } = await createTestHarness({
      workflow: 'high-risk',
      sdd: null,
      approved: true,
    });

    const outcome = await start(deps, runId);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.code).toBe('no_sdd');
    expect(!outcome.ok && outcome.error.message).toContain('HIGH-RISK workflow requires');
  });

  it('fails safe for unclassified legacy runs when SDD is absent (defaults to STANDARD requirement)', async () => {
    const { deps, runId } = await createTestHarness({
      workflow: undefined,
      sdd: null,
      approved: true,
    });

    const outcome = await start(deps, runId);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.code).toBe('no_sdd');
  });

  it('preserves approval requirement for SIMPLE workflow without SDD', async () => {
    const { deps, runId } = await createTestHarness({
      workflow: 'simple',
      sdd: null,
      approved: false,
    });

    const outcome = await start(deps, runId);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.code).toBe('approval_required');
  });

  it('preserves planHash staleness detection for SIMPLE workflow without SDD', async () => {
    const { deps, store, runId } = await createTestHarness({
      workflow: 'simple',
      sdd: null,
      approved: true,
    });

    // Modify plan after approval
    const modifiedPlan = PlanSchema.parse({
      ...PLAN,
      tasks: [
        {
          ...PLAN.tasks[0],
          description: 'Modified description after approval.',
        },
      ],
    });
    await store.writeArtifact(runId, 'plan', JSON.stringify(modifiedPlan, null, 2));

    const outcome = await start(deps, runId);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.code).toBe('approval_stale');
  });

  it('allows final review on SIMPLE workflow when SDD is absent', async () => {
    const { deps, store, runId } = await createTestHarness({
      workflow: 'simple',
      sdd: null,
      approved: true,
    });

    // Progress task cleanly: queued -> running -> completed
    await store.updateRun(runId, (s) => ({
      ...s,
      tasks: [{ id: 'TASK-001', state: 'running', attempts: 1 }],
    }));
    await store.updateRun(runId, (s) => ({
      ...s,
      stage: 'implementation',
      tasks: [{ id: 'TASK-001', state: 'completed', attempts: 1 }],
    }));

    const outcome = await review(deps, runId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('Expected ok');
    expect(outcome.value.finalReview.verdict).toBe('PASS');
  });

  it('refuses final review on STANDARD workflow when SDD is absent', async () => {
    const { deps, store, runId } = await createTestHarness({
      workflow: 'standard',
      sdd: null,
      approved: true,
    });

    await store.updateRun(runId, (s) => ({
      ...s,
      tasks: [{ id: 'TASK-001', state: 'running', attempts: 1 }],
    }));
    await store.updateRun(runId, (s) => ({
      ...s,
      stage: 'implementation',
      tasks: [{ id: 'TASK-001', state: 'completed', attempts: 1 }],
    }));

    const outcome = await review(deps, runId);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.code).toBe('no_sdd');
  });

  it('refuses final review on HIGH-RISK workflow when SDD is absent', async () => {
    const { deps, store, runId } = await createTestHarness({
      workflow: 'high-risk',
      sdd: null,
      approved: true,
    });

    await store.updateRun(runId, (s) => ({
      ...s,
      tasks: [{ id: 'TASK-001', state: 'running', attempts: 1 }],
    }));
    await store.updateRun(runId, (s) => ({
      ...s,
      stage: 'implementation',
      tasks: [{ id: 'TASK-001', state: 'completed', attempts: 1 }],
    }));

    const outcome = await review(deps, runId);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.code).toBe('no_sdd');
  });
});
