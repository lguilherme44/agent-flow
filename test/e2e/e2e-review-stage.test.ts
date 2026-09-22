import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { review } from '../../src/app/run-actions.js';
import { fakeRunActionDeps } from '../fakes/run-action-deps.js';


const PLAN = {
  feature: 'sample web app',
  tasks: [
    {
      id: 'TASK-001',
      title: 'Build login flow',
      description: 'Implement login page and form.',
      complexity: 'normal',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['User can log in.'],
      validation: ['test'],
    },
  ],
};

const PROMPTS = [
  'discovery',
  'architecture-impact',
  'sdd',
  'planning',
  'plan-review',
  'verification',
  'e2e',
  'final-review',
];

async function setupProject(options: { e2eEnabled: boolean; e2eVerdict?: 'PASS' | 'FAIL'; e2eFindings?: unknown[] }) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const host = new FakeHost();

  fs.seed(
    '/install/config.yaml',
    `runners:\n  agy:\n    type: agy-cli\n    enabled: true\n    dangerouslySkipPermissions: true\nroles:\n  e2e:\n    enabled: ${String(options.e2eEnabled)}\n    runner: agy\n    effort: high\n`,
  );

  for (const name of PROMPTS) {
    const required = name === 'e2e' ? ['sdd', 'changedFiles', 'agentsMd'] : [];
    fs.seed(
      `/install/prompts/${name}.md`,
      `---\npermissions: write\noutputFormat: json\nrequiredVars: [${required.join(', ')}]\n---\n\n# ${name}\n`,
    );
  }

  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const run = await store.createRun('test e2e flow', () => ({
    isolationMode: 'none' as const,
  }));

  await store.writeArtifact(run.runId, 'sdd', '# SDD\n\nLogin feature specification.\n');
  await store.writeArtifact(run.runId, 'plan', JSON.stringify(PLAN));
  await store.updateRun(run.runId, (state) => ({
    ...state,
    approved: true,
    approvedAt: '2026-08-09T20:00:00.000Z',
    tasks: [
      {
        id: 'TASK-001',
        state: 'completed',
        attempts: 1,
        infrastructureFailures: 0,
      },
    ],
  }));

  const e2eResponse = {
    verdict: options.e2eVerdict ?? 'PASS',
    summary: 'E2E browser tests executed with agent-browser.',
    findings: options.e2eFindings ?? [],
  };

  const defaultReviewResponse = {
    verdict: 'PASS',
    summary: 'All good.',
    findings: [],
  };

  const runner = new FakeProcessRunner().always((opts) => {
    if (opts.args.some((arg) => arg.includes('e2e'))) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          is_error: false,
          status: 'SUCCESS',
          result: JSON.stringify(e2eResponse),
          structured_output: e2eResponse,
        }),
      };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        is_error: false,
        status: 'SUCCESS',
        result: JSON.stringify(defaultReviewResponse),
        structured_output: defaultReviewResponse,
      }),
    };
  });

  const deps = fakeRunActionDeps({
    fs,
    clock,
    processRunner: runner,
    projectDir: '/repo',
    globalConfigPath: '/install/config.yaml',
    promptsDir: '/install/prompts',
    host,
    owner: 'cli',
  });

  return { fs, store, deps, runId: run.runId };
}

describe('E2E testing stage with agent-browser and agy provider', () => {
  it('executes e2e stage with agy when e2e is enabled', async () => {
    const { store, deps, runId } = await setupProject({ e2eEnabled: true });

    const stagesObserved: string[] = [];
    const outcome = await review(deps, runId, {
      onStage: (stage) => stagesObserved.push(stage),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(stagesObserved).toContain('e2e');
    expect(outcome.value.e2eReview).toBeDefined();
    expect(outcome.value.e2eReview?.reviewer.runner).toBe('agy');
    expect(outcome.value.e2eReview?.verdict).toBe('PASS');

    // Artifact reviews/e2e.json should be written
    const e2eArtifact = await store.readArtifact(runId, 'e2e');
    expect(e2eArtifact).not.toBeNull();
    const parsed = JSON.parse(e2eArtifact!);
    expect(parsed.verdict).toBe('PASS');
    expect(parsed.summary).toContain('agent-browser');
  });

  it('skips e2e stage when e2e is disabled', async () => {
    const { store, deps, runId } = await setupProject({ e2eEnabled: false });

    const stagesObserved: string[] = [];
    const outcome = await review(deps, runId, {
      onStage: (stage) => stagesObserved.push(stage),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(stagesObserved).not.toContain('e2e');
    expect(outcome.value.e2eReview).toBeUndefined();

    // Artifact reviews/e2e.json should not exist
    const e2eArtifact = await store.readArtifact(runId, 'e2e');
    expect(e2eArtifact).toBeNull();
  });

  it('fails Definition of Done when e2e finds blocking issues', async () => {
    const { deps, runId } = await setupProject({
      e2eEnabled: true,
      e2eVerdict: 'FAIL',
      e2eFindings: [
        {
          severity: 'critical',
          type: 'e2e_failure',
          file: 'src/login.ts',
          description: 'Login button fails to submit credentials in browser',
          suggestedAction: 'Fix submit handler event listener',
        },
      ],
    });

    const outcome = await review(deps, runId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.e2eReview?.verdict).toBe('FAIL');
    expect(outcome.value.done.done).toBe(false);
    expect(outcome.value.done.missing).toContain('no blocking review finding is open');
    const blockingCondition = outcome.value.done.conditions.find(
      (c) => c.name === 'no blocking review finding is open',
    );
    expect(blockingCondition?.detail).toContain('still open: unidentified finding');
  });
});
