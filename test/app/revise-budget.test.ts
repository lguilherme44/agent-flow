import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { fakeRunActionDeps } from '../fakes/run-action-deps.js';
import { StateStore } from '../../src/app/state-store.js';
import { planHash } from '../../src/app/approval.js';
import { revise } from '../../src/app/run-actions.js';
import { PlanSchema, type WorkflowClass } from '../../src/contracts/index.js';
import type { ProcessSpawnOptions } from '../../src/ports/index.js';

/**
 * The ceremony budget of plain `revise`, as it stands before decisions and escalations
 * exist (P7.5).
 *
 * **Why a baseline, and why now.** No test pinned these refusals. The work that follows
 * adds `revise --decision` and `revise --escalate`, both of which skip exactly these two
 * checks — so the change most likely to break them is the one about to be made, and a
 * refusal that quietly stopped refusing would look like a feature. `maxRevisionCycles` is
 * trivial 0, simple 1, standard 2 (`adaptive-workflow.ts`); each case below sits on its
 * ceiling.
 *
 * A refusal is only a refusal if nothing happened: the count is where it was, the approval
 * was not invalidated, no revision was recorded, and no planning stage ran.
 */

const REAL_PROMPTS = join(import.meta.dirname, '../../prompts');

const PROJECT_CONFIG = `project:
  name: demo
  type: node
commands:
  test: npm test
`;

const SDD_TEXT = `# Software Design Document

## Functional Requirements
- FR-001: The report page offers a CSV export of the rows it shows.
## Acceptance Criteria
- The export holds exactly the visible rows.
`;

const PLAN = PlanSchema.parse({
  feature: 'csv-export',
  tasks: [
    {
      id: 'TASK-001',
      title: 'Add the export button',
      description: 'Add a button that exports the current report as CSV.',
      complexity: 'trivial',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['The button downloads a CSV of the visible rows.'],
      validation: [],
    },
  ],
});

function envelope(payload: unknown): { exitCode: number; stdout: string } {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      is_error: false,
      subtype: 'success',
      result: typeof payload === 'string' ? payload : JSON.stringify(payload),
      ...(typeof payload === 'string' ? {} : { structured_output: payload }),
    }),
  };
}

/** An approved run of the given class that has already spent `revisionCount` revisions. */
async function approvedRun(workflow: WorkflowClass, revisionCount: number) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();

  fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);
  for (const file of readdirSync(REAL_PROMPTS)) {
    if (file.endsWith('.md')) {
      fs.seed(`/install/prompts/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
    }
  }

  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const run = await store.createRun('Add a CSV export', () => ({
    isolationMode: 'none' as const,
    workflow,
  }));

  await store.writeArtifact(run.runId, 'request', 'Add a CSV export\n');
  await store.writeArtifact(run.runId, 'sdd', SDD_TEXT);
  await store.writeArtifact(run.runId, 'architectureImpact', '# Impact\n\nThe report module.\n');
  await store.writeArtifact(run.runId, 'plan', JSON.stringify(PLAN, null, 2));
  // Approved, so a revision that got past the budget would have to write
  // `approval_invalidated` — which is what makes its absence below mean something.
  await store.updateRun(run.runId, (state) => ({
    ...state,
    status: 'approved',
    approved: true,
    approvedAt: clock.now(),
    approvedPlanHash: planHash(PLAN),
    revisionCount,
  }));

  const processRunner = new FakeProcessRunner().always((opts: ProcessSpawnOptions) => {
    if (opts.args.includes('--version') || opts.command === 'git') {
      return { exitCode: 0, stdout: '1.0.0' };
    }
    const prompt = opts.stdin ?? '';
    if (prompt.includes('ROLE: PLANNING_AGENT')) return envelope(PLAN);
    if (prompt.includes('ROLE: PLAN_REVIEW_AGENT')) {
      return envelope({ verdict: 'PASS', summary: 'Sound.', findings: [] });
    }
    if (prompt.includes('ROLE: SDD_AGENT')) return envelope(SDD_TEXT);
    return envelope('# Architecture\n\nA Node service.\n');
  });

  const deps = fakeRunActionDeps({
    fs,
    clock,
    processRunner,
    projectDir: '/repo',
    globalConfigPath: '/install/config.yaml',
    promptsDir: '/install/prompts',
    host: new FakeHost(),
    owner: 'cli',
  });

  return { store, deps, runId: run.runId, processRunner };
}

/** Every prompt an agent was handed. The planning pipeline reaches a model only this way. */
function agentPrompts(processRunner: FakeProcessRunner): string[] {
  return processRunner.calls
    .map((call) => call.stdin ?? '')
    .filter((stdin) => stdin.includes('ROLE: '));
}

const CEILINGS: readonly { workflow: WorkflowClass; revisionCount: number }[] = [
  { workflow: 'trivial', revisionCount: 0 },
  { workflow: 'simple', revisionCount: 1 },
  { workflow: 'standard', revisionCount: 2 },
];

describe('plain revise refuses once the ceremony budget is spent (P7.5 baseline)', () => {
  for (const { workflow, revisionCount } of CEILINGS) {
    it(`refuses a ${workflow} run at revisionCount ${String(revisionCount)} and changes nothing`, async () => {
      const { store, deps, runId, processRunner } = await approvedRun(workflow, revisionCount);

      const outcome = await revise(deps, runId, 'split TASK-001');

      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.error.code).toBe('ceremony_budget_exceeded');

      const state = await store.loadRun(runId);
      expect(state.revisionCount).toBe(revisionCount);
      expect(state.approved).toBe(true);

      const types = (await store.readEvents(runId)).map((event) => event.type);
      expect(types).not.toContain('revision_requested');
      expect(types).not.toContain('approval_invalidated');
      expect(types).not.toContain('revision_completed');
      expect(types).not.toContain('stage_started');

      expect(agentPrompts(processRunner)).toEqual([]);
    });
  }

  it('revises a standard run one cycle below its ceiling', async () => {
    // POSITIVE CONTROL. The same harness, one revision short of the ceiling, gets past the
    // budget: the pipeline reaches the planner, the approval is invalidated and the count
    // moves. Without this, every assertion above would also hold for a `revise` that could
    // not run at all.
    const { store, deps, runId, processRunner } = await approvedRun('standard', 1);

    const outcome = await revise(deps, runId, 'split TASK-001');

    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    expect((await store.loadRun(runId)).revisionCount).toBe(2);

    const types = (await store.readEvents(runId)).map((event) => event.type);
    expect(types).toContain('revision_requested');
    expect(types).toContain('approval_invalidated');

    expect(agentPrompts(processRunner).some((prompt) => prompt.includes('ROLE: PLANNING_AGENT'))).toBe(
      true,
    );
  });
});
