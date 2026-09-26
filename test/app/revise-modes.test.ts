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
import { PlanSchema, type RunEvent, type WorkflowClass } from '../../src/contracts/index.js';
import { en, ptBR } from '../../src/core/phrases/index.js';
import type { ProcessSpawnOptions } from '../../src/ports/index.js';

/**
 * `revise --decision` and `revise --escalate`, and the amendment plain `revise` now leaves
 * (P7.5, P7.4).
 *
 * The harness is `revise-budget.test.ts`'s — real prompts, a fake runner answering by role —
 * with two differences that matter here: a run may be born without the SDD and architecture
 * artefacts a `trivial` or `simple` run never produced, so an escalation into `standard` has
 * to *run* those stages rather than find them; and a run may be born with no `workflow` at
 * all, which is what state written before classification was persisted looks like.
 */

const REAL_PROMPTS = join(import.meta.dirname, '../../prompts');

const PROJECT_CONFIG = `project:
  name: demo
  type: node
commands:
  test: npm test
`;

// A complete SDD, because an escalation into `standard` runs the SDD stage and that stage
// refuses a document missing any required section.
const SDD_TEXT = readFileSync(join(import.meta.dirname, 'fixtures-sdd.md'), 'utf8');

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

interface RunShape {
  /** `undefined` seeds a run with no `state.workflow`. */
  readonly workflow: WorkflowClass | undefined;
  readonly revisionCount: number;
  /** Seed the SDD and architecture impact, as a run that planned `standard` would have. */
  readonly specified?: boolean;
  /** Seed TASK-001 as completed. */
  readonly implemented?: boolean;
}

/** An approved run of the given shape. */
async function approvedRun(shape: RunShape) {
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
    ...(shape.workflow === undefined ? {} : { workflow: shape.workflow }),
  }));

  await store.writeArtifact(run.runId, 'request', 'Add a CSV export\n');
  if (shape.specified === true) {
    await store.writeArtifact(run.runId, 'sdd', SDD_TEXT);
    await store.writeArtifact(run.runId, 'architectureImpact', '# Impact\n\nThe report module.\n');
  }
  await store.writeArtifact(run.runId, 'plan', JSON.stringify(PLAN, null, 2));
  // Approved, so a replan that ran has to write `approval_invalidated` — which is what makes
  // its absence on a refusal mean something.
  await store.updateRun(run.runId, (state) => ({
    ...state,
    status: 'approved',
    approved: true,
    approvedAt: clock.now(),
    approvedPlanHash: planHash(PLAN),
    revisionCount: shape.revisionCount,
    ...(shape.implemented === true
      ? {
          stage: 'implementation' as const,
          tasks: [{ id: 'TASK-001', state: 'completed' as const, attempts: 1, infrastructureFailures: 0 }],
        }
      : {}),
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

  const statePath = `/repo/.agent-flow/runs/${run.runId}/state.json`;
  return { fs, store, deps, runId: run.runId, processRunner, statePath };
}

/** Every prompt an agent was handed. The planning pipeline reaches a model only this way. */
function agentPrompts(processRunner: FakeProcessRunner): string[] {
  return processRunner.calls
    .map((call) => call.stdin ?? '')
    .filter((stdin) => stdin.includes('ROLE: '));
}

function rolesRun(processRunner: FakeProcessRunner): Set<string> {
  return new Set(
    agentPrompts(processRunner).flatMap((prompt) => /ROLE: (\w+)/.exec(prompt)?.[1] ?? []),
  );
}

function only(events: readonly RunEvent[], type: string): Record<string, unknown> {
  const matching = events.filter((event) => event.type === type);
  expect(matching, type).toHaveLength(1);
  return matching[0]?.detail ?? {};
}

describe('plain revise records a revision amendment (FR-009)', () => {
  it('appends one revision amendment and keeps its events as they were', async () => {
    const { store, deps, runId } = await approvedRun({
      workflow: 'standard',
      revisionCount: 1,
      specified: true,
    });

    const outcome = await revise(deps, runId, '  split TASK-001  ');

    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    const state = await store.loadRun(runId);
    expect(state.revisionCount).toBe(2);
    expect(state.amendments).toHaveLength(1);
    expect(state.amendments?.[0]).toMatchObject({
      id: 'AMD-001',
      kind: 'revision',
      text: 'split TASK-001',
      actor: { kind: 'keyboard' },
    });

    const events = await store.readEvents(runId);
    const requested = only(events, 'revision_requested');
    const completed = only(events, 'revision_completed');
    expect(requested).not.toHaveProperty('kind');
    expect(requested).not.toHaveProperty('fromWorkflow');
    expect(requested).toMatchObject({ attemptedRevision: 2, maxAllowed: 2 });
    expect(completed).toEqual({ instruction: 'split TASK-001', revisionCount: 2 });
    expect(only(events, 'amendment_recorded')).toMatchObject({ id: 'AMD-001', kind: 'revision' });

    // A plain revision's result carries none of the new fields.
    expect(outcome.ok && outcome.value).not.toHaveProperty('mode');
    expect(outcome.ok && outcome.value).not.toHaveProperty('revisionCount');
  });

  it('writes no amendment when the budget refuses it', async () => {
    // POSITIVE CONTROL for the ordering: the amendment comes after the refusals, so a refused
    // revision is not on the record as a decision somebody made.
    const { store, deps, runId } = await approvedRun({ workflow: 'standard', revisionCount: 2 });

    const outcome = await revise(deps, runId, 'split TASK-001');

    expect(!outcome.ok && outcome.error.code).toBe('ceremony_budget_exceeded');
    expect((await store.loadRun(runId)).amendments).toBeUndefined();
    expect((await store.readEvents(runId)).map((event) => event.type)).not.toContain(
      'amendment_recorded',
    );
  });
});

describe('revise --decision (FR-013)', () => {
  it('replans at the ceiling without spending a cycle', async () => {
    const { store, deps, runId, processRunner } = await approvedRun({
      workflow: 'standard',
      revisionCount: 2,
      specified: true,
    });

    const outcome = await revise(deps, runId, 'use the v2 endpoint', 'planning', 'decision');

    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    // The pipeline ran and wrote a plan: the planner was asked, with the decision in hand.
    const plannerPrompts = agentPrompts(processRunner).filter((prompt) =>
      prompt.includes('ROLE: PLANNING_AGENT'),
    );
    expect(plannerPrompts.length).toBeGreaterThan(0);
    expect(plannerPrompts.some((prompt) => prompt.includes('use the v2 endpoint'))).toBe(true);
    expect(await store.readArtifact(runId, 'plan')).not.toBeNull();

    const state = await store.loadRun(runId);
    expect(state.revisionCount).toBe(2);
    expect(state.approved).toBe(false);
    expect(state.amendments).toHaveLength(1);
    expect(state.amendments?.[0]).toMatchObject({ kind: 'decision', text: 'use the v2 endpoint' });

    const events = await store.readEvents(runId);
    expect(only(events, 'revision_requested')).toMatchObject({
      kind: 'decision',
      attemptedRevision: 2,
      maxAllowed: 2,
    });
    expect(only(events, 'revision_completed')).toEqual({
      instruction: 'use the v2 endpoint',
      revisionCount: 2,
      kind: 'decision',
    });
    expect(events.map((event) => event.type)).toContain('approval_invalidated');

    expect(outcome.ok && outcome.value).toMatchObject({
      mode: 'decision',
      revisionCount: 2,
      maxAllowed: 2,
    });
    expect(outcome.ok && outcome.value).not.toHaveProperty('fromWorkflow');
  });

  it('is not refused on a trivial run', async () => {
    const { store, deps, runId, processRunner } = await approvedRun({
      workflow: 'trivial',
      revisionCount: 0,
    });

    const outcome = await revise(deps, runId, 'keep it to one file', 'planning', 'decision');

    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    const state = await store.loadRun(runId);
    expect(state.revisionCount).toBe(0);
    expect(state.workflow).toBe('trivial');
    expect(rolesRun(processRunner)).toContain('PLANNING_AGENT');

    const types = (await store.readEvents(runId)).map((event) => event.type);
    expect(types).toContain('revision_requested');
    expect(types).toContain('revision_completed');
  });
});

describe('revise --escalate (FR-014)', () => {
  it('takes a trivial run to simple, where a plan review runs', async () => {
    const { store, deps, runId, processRunner } = await approvedRun({
      workflow: 'trivial',
      revisionCount: 0,
    });

    const outcome = await revise(deps, runId, 'this touches two modules', 'planning', 'escalation');

    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    const state = await store.loadRun(runId);
    expect(state.workflow).toBe('simple');
    expect(state.revisionCount).toBe(0);
    expect(rolesRun(processRunner)).toContain('PLAN_REVIEW_AGENT');

    const events = await store.readEvents(runId);
    expect(only(events, 'revision_requested')).toMatchObject({
      kind: 'escalation',
      fromWorkflow: 'trivial',
      toWorkflow: 'simple',
      attemptedRevision: 0,
      maxAllowed: 1,
    });
    expect(only(events, 'revision_completed')).toEqual({
      instruction: 'this touches two modules',
      revisionCount: 0,
      kind: 'escalation',
      fromWorkflow: 'trivial',
      toWorkflow: 'simple',
    });

    expect(state.amendments).toHaveLength(1);
    expect(state.amendments?.[0]).toMatchObject({
      kind: 'escalation',
      text: 'this touches two modules',
      fromWorkflow: 'trivial',
      toWorkflow: 'simple',
    });

    expect(outcome.ok && outcome.value).toMatchObject({
      mode: 'escalation',
      revisionCount: 0,
      maxAllowed: 1,
      fromWorkflow: 'trivial',
      toWorkflow: 'simple',
    });
  });

  it('takes a simple run to standard, running architecture impact and the SDD', async () => {
    const { store, deps, runId, processRunner } = await approvedRun({
      workflow: 'simple',
      revisionCount: 1,
    });

    const outcome = await revise(deps, runId, 'this needs a contract', 'planning', 'escalation');

    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    const state = await store.loadRun(runId);
    expect(state.workflow).toBe('standard');
    // Kept, not reset: the step up grants the difference between the ceilings.
    expect(state.revisionCount).toBe(1);

    const roles = rolesRun(processRunner);
    expect(roles).toContain('ARCHITECTURE_IMPACT_AGENT');
    expect(roles).toContain('SDD_AGENT');

    const events = await store.readEvents(runId);
    expect(only(events, 'revision_requested')).toMatchObject({
      kind: 'escalation',
      fromWorkflow: 'simple',
      toWorkflow: 'standard',
      attemptedRevision: 1,
      maxAllowed: 2,
    });
    expect(only(events, 'revision_completed')).toMatchObject({ toWorkflow: 'standard' });
  });

  it('reads a run with no recorded class as standard, and targets high-risk', async () => {
    const { store, deps, runId } = await approvedRun({
      workflow: undefined,
      revisionCount: 0,
      specified: true,
    });
    expect((await store.loadRun(runId)).workflow).toBeUndefined();

    const outcome = await revise(deps, runId, 'this needs more scrutiny', 'planning', 'escalation');

    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    const state = await store.loadRun(runId);
    expect(state.workflow).toBe('high-risk');
    expect(state.revisionCount).toBe(0);

    const events = await store.readEvents(runId);
    expect(only(events, 'revision_requested')).toMatchObject({
      kind: 'escalation',
      fromWorkflow: 'standard',
      toWorkflow: 'high-risk',
      maxAllowed: 3,
    });
    expect(only(events, 'revision_completed')).toMatchObject({
      fromWorkflow: 'standard',
      toWorkflow: 'high-risk',
    });
    expect(state.amendments?.[0]).toMatchObject({ fromWorkflow: 'standard', toWorkflow: 'high-risk' });
  });
});

describe('revise --escalate refuses with nothing written (FR-015)', () => {
  const cases = [
    {
      name: 'a high-risk run',
      shape: { workflow: 'high-risk', revisionCount: 0, specified: true },
      code: 'workflow_at_ceiling',
    },
    {
      name: 'a run with a completed task',
      shape: { workflow: 'simple', revisionCount: 0, implemented: true },
      code: 'implementation_started',
    },
  ] as const;

  for (const { name, shape, code } of cases) {
    it(`refuses ${name} with ${code}`, async () => {
      const { fs, store, deps, runId, processRunner, statePath } = await approvedRun(shape);
      const stateBefore = await fs.readFile(statePath);
      const eventsBefore = await store.readEvents(runId);

      const outcome = await revise(deps, runId, 'move up', 'planning', 'escalation');

      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.error.code).toBe(code);

      expect(await fs.readFile(statePath)).toBe(stateBefore);
      expect((await store.loadRun(runId)).amendments).toBeUndefined();
      const events = await store.readEvents(runId);
      expect(events).toEqual(eventsBefore);
      const types = events.map((event) => event.type);
      expect(types).not.toContain('revision_requested');
      expect(types).not.toContain('approval_invalidated');
      expect(types).not.toContain('amendment_recorded');
      expect(agentPrompts(processRunner)).toEqual([]);
    });
  }

  it('points a run with completed work at plain revise', async () => {
    const { deps, runId } = await approvedRun({
      workflow: 'simple',
      revisionCount: 0,
      implemented: true,
    });

    const outcome = await revise(deps, runId, 'move up', 'planning', 'escalation');

    expect(!outcome.ok && outcome.error.message).toContain('TASK-001');
    expect(!outcome.ok && outcome.error.action).toContain('`agent-flow revise`');
  });

  it('escalates the same simple run while nothing has completed', async () => {
    // POSITIVE CONTROL for the case above: without the completed task the same shape gets
    // through, so the refusal is about the task and not about the harness.
    const { store, deps, runId } = await approvedRun({ workflow: 'simple', revisionCount: 0 });

    const outcome = await revise(deps, runId, 'move up', 'planning', 'escalation');

    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    expect((await store.loadRun(runId)).workflow).toBe('standard');
  });
});

describe('the ceiling refusal names the ways past it (FR-019)', () => {
  it('names revise --decision, revise --escalate and approve --attach-findings in both books', () => {
    for (const book of [en, ptBR]) {
      const sentence = book.actions.ceremonyBudget('STANDARD', 2);
      expect(sentence).toContain('`agent-flow revise --decision`');
      expect(sentence).toContain('`agent-flow revise --escalate`');
      expect(sentence).toContain('`agent-flow approve --attach-findings`');
    }
  });

  it('is the message plain revise refuses with at the ceiling', async () => {
    const { deps, runId } = await approvedRun({ workflow: 'standard', revisionCount: 2 });

    const outcome = await revise(deps, runId, 'split TASK-001');

    expect(!outcome.ok && outcome.error.message).toContain('agent-flow revise --decision');
  });
});
