import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { fakeRunActionDeps } from '../fakes/run-action-deps.js';
import { StateStore } from '../../src/app/state-store.js';
import { StageRunner } from '../../src/app/stage-runner.js';
import { PromptLoader } from '../../src/app/prompt-loader.js';
import { TaskExecutor } from '../../src/app/task-executor.js';
import { planHash } from '../../src/app/approval.js';
import { approve, type ActionOutcome } from '../../src/app/run-actions.js';
import {
  GlobalConfigSchema,
  PlanSchema,
  ProjectConfigSchema,
  TaskSchema,
} from '../../src/contracts/index.js';
import { DEFAULT_GLOBAL_CONFIG_YAML } from '../../src/config/defaults.js';
import { ptBR } from '../../src/core/phrases/index.js';

/**
 * FR-010, FR-016, FR-017, FR-018 — approving over a failed review, with its findings handed
 * to the tasks they are about.
 *
 * **The defect this exists for.** Once a run's revision budget was spent, the only way past a
 * failed plan review was `approve --force`, and the findings it overruled reached no executor:
 * `grantApproval` forwarded nothing, so the tasks were implemented by agents that never saw
 * what the reviewer objected to. `--attach-findings` is the approval that forwards them.
 *
 * The prompt assertions go through the real `approve`, the real `TaskExecutor` and the real
 * `prompts/implementation.md`, and read what the runner was handed. A test that checked the
 * amendment on disk would pass on a system that records the attachment and delivers nothing.
 */

const PROJECT = '/repo';
const PROMPTS = '/install/prompts';
const REAL_PROMPTS = join(import.meta.dirname, '../../prompts');

const CAPS = {
  supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
  supportsReadOnly: true,
  supportsNonInteractive: true,
  supportsWorkingDirectory: true,
  structuredOutputStrategy: 'native',
  nonInteractiveToolGrants: { fileEdit: true, commandExecution: true },
} as const;

const REPORT = `Done.

## RESULT

STATUS: COMPLETED

FILES CHANGED:
- src/a.ts

DEVIATIONS:
- none

NOTES:
- none
`;

const PROJECT_CONFIG = `project:
  name: demo
  type: node
commands:
  test: npm test
`;

const TASK_IDS = ['TASK-001', 'TASK-002', 'TASK-003'] as const;

const planTask = (id: string) => ({
  id,
  title: `${id} title`,
  description: `${id} description.`,
  complexity: 'normal',
  risk: 'low',
  dependencies: [],
  requirements: ['FR-001'],
  acceptanceCriteria: ['It works.'],
  validation: ['test'],
});

const PLAN = PlanSchema.parse({ feature: 'weekly-recurrence', tasks: TASK_IDS.map(planTask) });

const SDD = '# SDD\n\nFR-001 — weekly recurrence.\n';

/**
 * Three findings, each carrying a marker that appears nowhere else, so a prompt holding a
 * marker holds that finding. Finding 0 cites TASK-001, finding 1 cites TASK-002, and finding 2
 * cites no task at all — which FR-017 sends to every task.
 */
const FINDINGS = [
  {
    severity: 'high',
    type: 'requirement',
    requirement: 'FR-001',
    description: 'TASK-001 drops the end date of a series (marker-f0).',
    suggestedAction: 'Keep the end date through the parser.',
  },
  {
    severity: 'medium',
    type: 'test-gap',
    description: 'Nothing tests the weekday mask (marker-f1).',
    suggestedAction: 'Cover it in TASK-002.',
    file: 'src/recurrence/mask.ts',
  },
  {
    severity: 'low',
    type: 'maintainability',
    description: 'The recurrence module has no error vocabulary (marker-f2).',
    suggestedAction: 'Name the errors once, in one place.',
  },
];

const MARKERS = ['marker-f0', 'marker-f1', 'marker-f2'] as const;

type ReviewShape = 'failed' | 'passed' | 'stale' | 'missing' | 'unverifiable';

function reviewOf(shape: Exclude<ReviewShape, 'missing'>): Record<string, unknown> {
  return {
    verdict: shape === 'passed' ? 'PASS' : 'FAIL',
    independence: 'cross-provider',
    reviewer: { runner: 'codex', reasoning: 'high' },
    ...(shape === 'unverifiable'
      ? {}
      : { planHash: shape === 'stale' ? 'sha256:another-plan' : planHash(PLAN) }),
    findings: shape === 'passed' ? [] : FINDINGS,
    // An adjudication of finding 1 of the *previous* review. FR-017: nothing is subtracted
    // for it, because its index counts another review's findings.
    adjudications: [{ findingIndex: 1, decision: 'ACCEPTED' }],
  };
}

async function world(options: { review?: ReviewShape; status?: 'waiting_for_approval' | 'plan_rejected' } = {}) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const runner = new FakeAgentRunner('claude', CAPS);

  fs.seed(`${PROJECT}/.agent-flow/config.yaml`, PROJECT_CONFIG);
  for (const file of readdirSync(REAL_PROMPTS)) {
    if (file.endsWith('.md')) fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
  }

  const store = new StateStore({ fs, clock, projectDir: PROJECT });
  const run = await store.createRun('weekly recurrence');
  const runId = run.runId;

  await store.writeArtifact(runId, 'plan', JSON.stringify(PLAN, null, 2));
  await store.writeArtifact(runId, 'sdd', SDD);
  const shape = options.review ?? 'failed';
  if (shape !== 'missing') {
    await store.writeArtifact(runId, 'planReview', JSON.stringify(reviewOf(shape)));
  }
  await store.updateRun(runId, (state) => ({
    ...state,
    status: options.status ?? 'waiting_for_approval',
    tasks: TASK_IDS.map((id) => ({ id, state: 'queued' as const, attempts: 0, infrastructureFailures: 0 })),
  }));

  const deps = fakeRunActionDeps({
    fs,
    clock,
    processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: '1.0.0' }),
    projectDir: PROJECT,
    globalConfigPath: '/install/config.yaml',
    promptsDir: PROMPTS,
    host: new FakeHost(),
    owner: 'cli',
  });

  const globalConfig = GlobalConfigSchema.parse(parseYaml(DEFAULT_GLOBAL_CONFIG_YAML));
  const executor = new TaskExecutor({
    fs,
    clock,
    store,
    stageRunner: new StageRunner({
      fs,
      clock,
      store,
      config: globalConfig,
      capabilities: { claude: CAPS },
      promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
      getRunner: () => runner,
      projectDir: PROJECT,
    }),
    processRunner: new FakeProcessRunner().always({ exitCode: 0 }),
    config: {
      global: globalConfig,
      project: ProjectConfigSchema.parse({
        project: { name: 'demo', type: 'node' },
        commands: { test: 'npm test' },
      }),
    },
    projectDir: PROJECT,
  });

  /** The prompt a task's next attempt is sent, in sequential mode. */
  const promptFor = async (taskId: string): Promise<string> => {
    runner.pushText(REPORT);
    await executor.execute(TaskSchema.parse(planTask(taskId)), runId, SDD);
    const prompt = runner.calls.at(-1)?.prompt;
    if (prompt === undefined) throw new Error('the implementation stage never reached the runner');
    // `autocrlf` on a Windows checkout gives the template CRLF; nothing here is about that.
    return prompt.replace(/\r\n/g, '\n');
  };

  const statePath = `${PROJECT}/.agent-flow/runs/${runId}/state.json`;
  return { fs, store, deps, runId, promptFor, statePath };
}

function ok<T>(outcome: ActionOutcome<T>): T {
  if (!outcome.ok) throw new Error(`refused: ${outcome.error.code}`);
  return outcome.value;
}

/** The markers a prompt holds, in finding order. */
function markersIn(prompt: string): string[] {
  return MARKERS.filter((marker) => prompt.includes(marker));
}

describe('approve --attach-findings over a failed review (FR-016)', () => {
  it('approves as forced, and run_approved keeps exactly its four keys', async () => {
    const { store, deps, runId } = await world();

    const approved = ok(await approve(deps, runId, { attachFindings: true }));

    expect(approved).toMatchObject({ forced: true, taskCount: 3, attachedFindings: 3, tasksReached: 3 });
    const state = await store.loadRun(runId);
    expect(state.approved).toBe(true);
    expect(state.approvedPlanHash).toBe(planHash(PLAN));

    const events = (await store.readEvents(runId)).filter((event) => event.type === 'run_approved');
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]?.detail ?? {}).sort()).toEqual(
      ['approvedAt', 'forced', 'planHash', 'taskCount'].sort(),
    );
    expect(events[0]?.detail['forced']).toBe(true);
  });

  it('records exactly one attached_findings amendment with every finding, its index and its tasks', async () => {
    const { store, deps, runId } = await world();

    ok(await approve(deps, runId, { attachFindings: true }));

    const amendments = (await store.loadRun(runId)).amendments ?? [];
    // One amendment, and it is the attachment: the forced approval it implies is recorded as
    // a degradation, not as a second `forced_approval` entry about the same act.
    expect(amendments).toHaveLength(1);
    const [attachment] = amendments;
    expect(attachment).toMatchObject({
      id: 'AMD-001',
      kind: 'attached_findings',
      actor: { kind: 'keyboard' },
      planHash: planHash(PLAN),
      findingCount: 3,
    });
    // All three, the adjudicated one included (FR-017), each with the tasks it routes to.
    expect(attachment?.findings?.map((attached) => [attached.index, attached.tasks])).toEqual([
      [0, ['TASK-001']],
      [1, ['TASK-002']],
      [2, ['TASK-001', 'TASK-002', 'TASK-003']],
    ]);
    expect(attachment?.findings?.map((attached) => attached.finding.description)).toEqual(
      FINDINGS.map((finding) => finding.description),
    );

    const recorded = (await store.readEvents(runId)).filter((event) => event.type === 'amendment_recorded');
    expect(recorded.map((event) => event.detail['kind'])).toEqual(['attached_findings']);
  });

  it('says in the degradation that the findings were attached rather than resolved', async () => {
    const { store, deps, runId } = await world();

    ok(await approve(deps, runId, { attachFindings: true }));

    const degradations = (await store.loadRun(runId)).degradations.filter(
      (degradation) => degradation.kind === 'forced_approval',
    );
    expect(degradations).toHaveLength(1);
    expect(degradations[0]?.reason).toMatch(/attached/);
    expect(degradations[0]?.reason).toMatch(/rather than resolved/);
  });

  it('accepts a rejected run whose review also failed, because review_failed is checked first', async () => {
    const { store, deps, runId } = await world({ status: 'plan_rejected' });

    const approved = ok(await approve(deps, runId, { attachFindings: true }));

    expect(approved.forced).toBe(true);
    expect((await store.loadRun(runId)).amendments?.map((amendment) => amendment.kind)).toEqual([
      'attached_findings',
    ]);
  });
});

describe('the attached findings reach the tasks they route to (FR-018)', () => {
  it('gives each task the findings that cite it and the one that cites nobody', async () => {
    const run = await world();
    ok(await approve(run.deps, run.runId, { attachFindings: true }));

    const expected: Record<(typeof TASK_IDS)[number], string[]> = {
      'TASK-001': ['marker-f0', 'marker-f2'],
      'TASK-002': ['marker-f1', 'marker-f2'],
      'TASK-003': ['marker-f2'],
    };

    for (const id of TASK_IDS) {
      const prompt = await run.promptFor(id);
      expect(markersIn(prompt), id).toEqual(expected[id]);

      // Under the heading that names their source (SEC-005), never before it.
      const heading = prompt.indexOf('\n## Attached review findings\n');
      expect(heading, `${id} has no attached-findings block`).toBeGreaterThan(-1);
      for (const marker of expected[id]) expect(prompt.indexOf(marker)).toBeGreaterThan(heading);
    }
  });

  it('carries each finding whole: severity, type, requirement, file and suggested action', async () => {
    const run = await world();
    ok(await approve(run.deps, run.runId, { attachFindings: true }));

    const first = await run.promptFor('TASK-001');
    expect(first).toContain('### high — requirement');
    expect(first).toContain('Requirement: FR-001');
    expect(first).toContain('Suggested action: Keep the end date through the parser.');

    const second = await run.promptFor('TASK-002');
    expect(second).toContain('File: src/recurrence/mask.ts');
  });

  it('delivers nothing after a forced approval over the same review', async () => {
    // POSITIVE CONTROL. `--force` approves the same run over the same failed review and
    // attaches nothing. If the findings above reached the prompts by any route other than
    // the attachment, they would be here too.
    const run = await world();
    ok(await approve(run.deps, run.runId, { force: true }));

    for (const id of TASK_IDS) {
      const prompt = await run.promptFor(id);
      expect(markersIn(prompt), id).toEqual([]);
      expect(prompt).not.toContain('## Attached review findings');
    }
  });
});

describe('approve --attach-findings refuses with nothing written (FR-016)', () => {
  const cases: readonly { shape: ReviewShape; state: string }[] = [
    { shape: 'passed', state: 'passed' },
    { shape: 'stale', state: 'review_stale' },
    { shape: 'missing', state: 'review_missing' },
    { shape: 'unverifiable', state: 'review_unverifiable' },
  ];

  for (const { shape, state } of cases) {
    it(`refuses a ${shape} review with findings_not_attachable`, async () => {
      const { fs, store, deps, runId, statePath } = await world({ review: shape });
      const stateBefore = await fs.readFile(statePath);
      const eventsBefore = await store.readEvents(runId);

      const outcome = await approve(deps, runId, { attachFindings: true });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe('findings_not_attachable');
      expect(outcome.error.detail).toMatchObject({ state });

      expect(await fs.readFile(statePath)).toBe(stateBefore);
      expect(await store.readEvents(runId)).toEqual(eventsBefore);
      expect((await store.loadRun(runId)).approved).toBe(false);
    });
  }

  it('names the state the gate actually found', async () => {
    const passed = await world({ review: 'passed' });
    const refusedPassed = await approve(passed.deps, passed.runId, { attachFindings: true });
    expect(!refusedPassed.ok && refusedPassed.error.message).toContain('passed this plan');

    const stale = await world({ review: 'stale' });
    const refusedStale = await approve(stale.deps, stale.runId, { attachFindings: true });
    expect(!refusedStale.ok && refusedStale.error.message).toContain('a different version of this plan');

    // And in the caller's language, through the same phrase book.
    const missing = await world({ review: 'missing' });
    const refusedMissing = await approve(
      { ...missing.deps, say: ptBR },
      missing.runId,
      { attachFindings: true },
    );
    expect(!refusedMissing.ok && refusedMissing.error.message).toContain(ptBR.actions.planNotReviewed);
  });

  it('refuses --attach-findings with --force as invalid_input, before anything is read or written', async () => {
    const { fs, store, deps, runId, statePath } = await world();
    const stateBefore = await fs.readFile(statePath);
    const eventsBefore = await store.readEvents(runId);

    const outcome = await approve(deps, runId, { attachFindings: true, force: true });

    expect(!outcome.ok && outcome.error.code).toBe('invalid_input');
    expect(await fs.readFile(statePath)).toBe(stateBefore);
    expect(await store.readEvents(runId)).toEqual(eventsBefore);
  });
});

describe('approve --force records the findings it overruled, and only those (FR-010)', () => {
  it('appends exactly one forced_approval amendment over review_failed', async () => {
    const { store, deps, runId } = await world();

    const approved = ok(await approve(deps, runId, { force: true }));

    expect(approved.forced).toBe(true);
    expect(approved).not.toHaveProperty('attachedFindings');
    const amendments = (await store.loadRun(runId)).amendments ?? [];
    expect(amendments).toHaveLength(1);
    expect(amendments[0]).toMatchObject({
      kind: 'forced_approval',
      planHash: planHash(PLAN),
      findingCount: 3,
    });
    // A count, not a copy: `--force` hands no finding to any task.
    expect(amendments[0]).not.toHaveProperty('findings');

    const degradation = (await store.loadRun(runId)).degradations.find(
      (entry) => entry.kind === 'forced_approval',
    );
    expect(degradation?.reason).toBe('the plan was approved with --force, over a failed or missing review');
  });

  it('appends nothing over review_missing', async () => {
    const { store, deps, runId } = await world({ review: 'missing' });

    const approved = ok(await approve(deps, runId, { force: true }));

    expect(approved.forced).toBe(true);
    expect((await store.loadRun(runId)).amendments).toBeUndefined();
    expect((await store.readEvents(runId)).map((event) => event.type)).not.toContain(
      'amendment_recorded',
    );
  });

  it('appends nothing on an approval that needed no force', async () => {
    const { store, deps, runId } = await world({ review: 'passed' });

    ok(await approve(deps, runId, { force: true }));

    expect((await store.loadRun(runId)).amendments).toBeUndefined();
  });
});
