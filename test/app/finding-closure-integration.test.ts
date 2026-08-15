import { describe, it, expect } from 'vitest';
import { PlanSchema, ReviewResultSchema } from '../../src/contracts/index.js';
import { describeApprovalGate } from '../../src/app/run-actions.js';
import { planHash } from '../../src/app/approval.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { type RunActionDeps } from '../../src/app/run-actions.js';

describe('Finding Closure & Residual Risk Integration', () => {
  const PROJECT = '/repo';

  it('validates planner proposals, reviewer adjudications, residual risks, and approval read model', async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock();
    const host = new FakeHost();
    const store = new StateStore({ fs, clock, projectDir: PROJECT });

    const run = await store.createRun('Migrate payment database');
    await store.updateRun(run.runId, (s) => ({ ...s, status: 'waiting_for_approval' }));

    const plan = PlanSchema.parse({
      feature: 'migrate-payment-db',
      tasks: [
        {
          id: 'TASK-001',
          title: 'Apply payment column migration',
          description: 'Migrates column nullable to non-null with fallback default.',
          complexity: 'normal',
          risk: 'medium',
          dependencies: [],
          requirements: ['FR-001'],
          files: { likely: ['db/migrations/002_payment.sql'] },
          flags: { databaseChange: true },
          acceptanceCriteria: ['Migration passes cleanly on clean DB.'],
          validation: [],
          validationExpectation: 'pass',
        },
      ],
      findingProposals: [
        {
          findingIndex: 0,
          status: 'PROPOSE_ACCEPT_WITH_RATIONALE',
          rationale: 'Table lock duration during index rebuild is accepted during off-peak hours.',
        },
      ],
    });

    const planJson = JSON.stringify(plan, null, 2);
    await store.writeArtifact(run.runId, 'plan', planJson);
    const hash = planHash(plan);

    const review = ReviewResultSchema.parse({
      verdict: 'PASS',
      independence: 'cross-provider',
      reviewer: { runner: 'codex', reasoning: 'high' },
      summary: 'Plan addresses migration safely with accepted off-peak residual risk.',
      findings: [
        {
          severity: 'medium',
          type: 'risk_misjudged',
          description: 'Index rebuild acquires brief exclusive table lock.',
          suggestedAction: 'Ensure operation is scheduled during off-peak window.',
        },
      ],
      adjudications: [
        {
          findingIndex: 0,
          decision: 'ACCEPT_AS_RESIDUAL_RISK',
          reason: 'Accepted by reviewer since maintenance window procedure is specified.',
        },
      ],
      residualRisks: [
        'Table lock duration during index rebuild requires deployment in maintenance window.',
      ],
      planHash: hash,
    });

    await store.writeArtifact(run.runId, 'planReview', JSON.stringify(review, null, 2));

    // Seed global config in fake fs
    fs.seed('/install/config.yaml', 'runners:\n  claude:\n    type: claude-code-cli\n');

    const deps: RunActionDeps = {
      fs,
      clock,
      processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: '1.0.0' }),
      projectDir: PROJECT,
      globalConfigPath: '/install/config.yaml',
      promptsDir: '/install/prompts',
      host,
      owner: 'cli',
    };

    // Read through approval gate action outcome
    const outcome = await describeApprovalGate(deps, run.runId);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('Expected ok');

    const gate = outcome.value;
    expect(gate.canApprove).toBe(true);
    expect(gate.planHash).toBe(hash);
    expect(gate.review?.verdict).toBe('PASS');
    expect(gate.review?.findings).toHaveLength(1);
    expect(gate.review?.adjudications).toEqual([
      {
        findingIndex: 0,
        decision: 'ACCEPT_AS_RESIDUAL_RISK',
        reason: 'Accepted by reviewer since maintenance window procedure is specified.',
      },
    ]);
    expect(gate.review?.residualRisks).toEqual([
      'Table lock duration during index rebuild requires deployment in maintenance window.',
    ]);
  });
});
