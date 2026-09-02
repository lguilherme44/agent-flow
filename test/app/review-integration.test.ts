import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { StateStore } from '../../src/app/state-store.js';
import { ReviewStore } from '../../src/app/review-store.js';
import { ReviewService, ChangeReviewAdapter } from '../../src/app/review-service.js';
import { deriveAgentRoster } from '../../src/core/collaboration/roster.js';
import {
  GlobalConfigSchema,
  ProjectConfigSchema,
  TaskResultSchema,
  TaskSchema,
  type EffectiveConfig,
  type Task,
  type TaskResult,
} from '../../src/contracts/index.js';
import type { StageRunner } from '../../src/app/stage-runner.js';
import { StageFailure } from '../../src/app/stage-runner.js';

/**
 * A review of one change, end to end through the service (M6-03).
 *
 * **Everything the reviewer could have forged is asserted to come from somewhere else**:
 * the reviewer from the assignment policy, the author from the audit trail, the tree from
 * the integration block, the finding ids from a counter over the log. What the model
 * returns is content.
 *
 * The other property here is that no failure of a review may fail a run. A reviewer that
 * is unavailable, times out, or answers with something that will not parse all mean the
 * same thing — there is no review — and the quality decision refuses without one, which
 * is louder than a bad review and quieter than a halted run.
 */

const PROJECT = '/repo';
const TREE = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

const ROLES = {
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
};

function config(
  members?: Record<string, Record<string, unknown>>,
  review?: Record<string, unknown>,
): EffectiveConfig {
  return {
    global: GlobalConfigSchema.parse({
      runners: { claude: { type: 'claude-code-cli' }, agy: { type: 'agy-cli' } },
      roles: ROLES,
      quality: { gates: { test: { category: 'unit', required: true } } },
      ...(review === undefined ? {} : { review }),
      ...(members === undefined
        ? {}
        : {
            teams: {
              core: {
                members: Object.fromEntries(
                  Object.entries(members).map(([id, member]) => [
                    id,
                    { roles: 'executor.normal', runner: 'claude', ...member },
                  ]),
                ),
                policies: {},
              },
            },
          }),
    }),
    project: ProjectConfigSchema.parse({
      project: { name: 'x', type: 'node' },
      commands: { test: 'npm test' },
    }),
  };
}

const TEAM = { backend: {}, reviewer: { roles: 'finalReviewer', skills: ['review'] } };

function task(): Task {
  return TaskSchema.parse({
    id: 'TASK-003',
    title: 'Wire the endpoint',
    description: 'Some work.',
    complexity: 'normal',
    risk: 'low',
    dependencies: [],
    requirements: ['FR-001'],
    files: { likely: ['src/server/a.ts'] },
    acceptanceCriteria: ['It compiles.'],
    validation: ['test'],
  });
}

function result(overrides: Record<string, unknown> = {}): TaskResult {
  return TaskResultSchema.parse({
    task: 'TASK-003',
    status: 'completed',
    runner: 'claude',
    reasoning: 'medium',
    startedAt: '2026-09-02T12:00:00.000Z',
    finishedAt: '2026-09-02T12:01:00.000Z',
    filesChanged: ['src/server/a.ts'],
    validation: {
      passed: true,
      commands: [{ command: 'npm test', exitCode: 0, durationMs: 10, stdout: '', stderr: '' }],
    },
    integration: {
      attempt: 1,
      branch: 'agent-flow/x/integration',
      marker: 'c'.repeat(40),
      mergeCommit: TREE,
      base: BASE,
      validatedTree: 'd'.repeat(40),
      integratedAt: '2026-09-02T12:01:30.000Z',
    },
    ...overrides,
  });
}

/** A stage runner that answers with whatever the test scripted. */
function scriptedRunner(answer: unknown | (() => never)) {
  // The options matter as much as the variables: the working directory is *which tree the
  // reviewer reads*, and the first version of this harness dropped it on the floor.
  const calls: { vars: Record<string, string>; options?: { workingDirectory?: string } }[] = [];

  const runner = {
    run: async (
      _stage: unknown,
      _runId: string,
      vars: Record<string, string>,
      options?: { workingDirectory?: string },
    ) => {
      calls.push({ vars, ...(options === undefined ? {} : { options }) });
      if (typeof answer === 'function') (answer as () => never)();
      return { text: JSON.stringify(answer), data: answer, runner: 'claude', repairs: 0 };
    },
  } as unknown as StageRunner;

  return { runner, calls };
}

async function harness(options: {
  members?: Record<string, Record<string, unknown>>;
  answer?: unknown | (() => never);
  author?: string;
  review?: Record<string, unknown>;
  reviewWorkspace?: (runId: string) => Promise<string | undefined>;
} = {}) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const store = new StateStore({ fs, clock, projectDir: PROJECT });
  const run = await store.createRun('a feature');
  const reviews = new ReviewStore({ fs, projectDir: PROJECT });
  const effective = config(options.members ?? TEAM, options.review);

  // The author, as the run recorded it.
  await store.appendEvent(run.runId, 'task_assigned', {
    task: 'TASK-003',
    agent: options.author ?? 'backend',
    role: 'executor.normal',
    reason: 'team_match',
    candidates: [],
  });

  const { runner, calls } = scriptedRunner(
    options.answer ?? { verdict: 'approve', summary: 'nothing to report', findings: [] },
  );

  const service = new ReviewService({
    clock,
    store,
    reviews,
    stageRunner: runner,
    roster: deriveAgentRoster(effective.global),
    config: effective,
    canImplement: () => true,
  });

  const adapter = new ChangeReviewAdapter({
    service,
    store,
    fs,
    projectDir: PROJECT,
    inFlight: async () => new Map(),
    ...(options.reviewWorkspace === undefined
      ? {}
      : { reviewWorkspace: options.reviewWorkspace }),
  });

  return { fs, store, run, reviews, service, adapter, calls };
}

describe('a change is reviewed after it integrates', () => {
  it('records a review naming the tree the change integrated as', async () => {
    const h = await harness();
    await h.adapter.review(h.run.runId, task(), result());

    const [record] = await h.reviews.readReviews(h.run.runId);
    expect(record?.reviewedTree).toBe(TREE);
    expect(record?.taskId).toBe('TASK-003');
    expect(record?.round).toBe(1);
  });

  it('takes the reviewer from the policy and the author from the run', async () => {
    const h = await harness();
    await h.adapter.review(h.run.runId, task(), result());

    const [record] = await h.reviews.readReviews(h.run.runId);
    expect(record?.reviewer).toBe('reviewer');
    expect(record?.author).toBe('backend');
  });

  it('gives the reviewer the task, the files and what the commands already said', async () => {
    const h = await harness();
    await h.adapter.review(h.run.runId, task(), result());

    const vars = h.calls[0]?.vars ?? {};
    expect(vars['taskId']).toBe('TASK-003');
    expect(vars['changedFiles']).toContain('src/server/a.ts');
    expect(vars['qualityEvidence']).toContain('npm test: exit 0');
  });

  it('numbers a second review of the same task as round two', async () => {
    const h = await harness();
    await h.adapter.review(h.run.runId, task(), result());
    await h.adapter.review(h.run.runId, task(), result());

    expect((await h.reviews.readReviews(h.run.runId)).map((r) => r.round)).toEqual([1, 2]);
  });

  it('allocates finding ids across the whole run, never per review', async () => {
    const findings = [
      { severity: 'medium', type: 'correctness', description: 'a', suggestedAction: 'b' },
    ];
    const h = await harness({ answer: { verdict: 'changes_requested', findings } });

    await h.adapter.review(h.run.runId, task(), result());
    await h.adapter.review(h.run.runId, task(), result());

    const ids = (await h.reviews.readReviews(h.run.runId)).flatMap((r) =>
      r.findings.map((f) => f.id),
    );
    expect(ids).toEqual(['FIND-0001', 'FIND-0002']);
  });
});

describe('what the audit trail records', () => {
  it('names the reviewer, its independence, and each finding', async () => {
    const findings = [
      {
        severity: 'high',
        type: 'security',
        description: 'the token is logged',
        suggestedAction: 'redact it',
        file: 'src/server/a.ts',
      },
    ];
    const h = await harness({ answer: { verdict: 'changes_requested', findings } });

    await h.adapter.review(h.run.runId, task(), result());
    const events = await h.store.readEvents(h.run.runId);
    const byType = Object.fromEntries(events.map((e) => [e.type, e.detail]));

    expect(byType['reviewer_assigned']).toMatchObject({ reviewer: 'reviewer', independence: 1 });
    expect(byType['review_started']).toMatchObject({ round: 1, tree: TREE });
    expect(byType['finding_raised']).toMatchObject({ severity: 'high', category: 'security' });
    expect(byType['review_completed']).toMatchObject({ verdict: 'changes_requested', findings: 1 });
  });

  it('records what each quality gate said, from evidence rather than by running it', async () => {
    const h = await harness();
    await h.adapter.review(h.run.runId, task(), result());

    const gate = (await h.store.readEvents(h.run.runId)).find(
      (event) => event.type === 'quality_gate_evaluated',
    );

    expect(gate?.detail).toMatchObject({ gate: 'test', required: true, status: 'passed' });
  });
});

/**
 * §4 and I-41: the reviewer reads the tree it is judging.
 *
 * It read the project directory — the operator's own checkout, which in worktree mode does
 * not have the change. `reviewedTree` was recorded correctly the whole time, which is what
 * made it dangerous: the record named the right commit and the model had read a different
 * one. The live M6 run produced `[critical] truncateSlug does not exist` about a function
 * sitting on the integration branch, and an earlier reviewer had filed the cause itself as
 * `info` — "the checked-out working tree does not contain this change".
 */
describe('the reviewer reads the tree under review (§4, I-41)', () => {
  it('runs in the integration checkout, not in the project directory', async () => {
    const h = await harness({ reviewWorkspace: async () => '/wk/integration/AF-2026-001' });

    await h.adapter.review(h.run.runId, task(), result());

    expect(h.calls[0]?.options?.workingDirectory).toBe('/wk/integration/AF-2026-001');
  });

  it('falls back to the project directory when there is no separate tree', async () => {
    // Sequential mode, and a refused preparation. Both mean the project directory *is* the
    // tree, and `undefined` is how the stage runner says so.
    const h = await harness({ reviewWorkspace: async () => undefined });

    await h.adapter.review(h.run.runId, task(), result());

    expect(h.calls[0]?.options?.workingDirectory).toBeUndefined();
  });

  it('names the same commit it reads', async () => {
    const h = await harness({ reviewWorkspace: async () => '/wk/integration/AF-2026-001' });

    await h.adapter.review(h.run.runId, task(), result());

    const [record] = await h.reviews.readReviews(h.run.runId);
    expect(record?.reviewedTree).toBe(TREE);
  });
});

describe('a review that cannot happen is not an approval', () => {
  it('does nothing at all when no member reviews', async () => {
    const h = await harness({ members: { backend: {} } });
    await h.adapter.review(h.run.runId, task(), result());

    expect(await h.reviews.readReviews(h.run.runId)).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });

  it('records no review when the only reviewer wrote the code', async () => {
    // I-42, reached through the adapter: the author comes from the audit trail, and the
    // policy refuses it.
    const h = await harness({
      members: { backend: { roles: 'finalReviewer', skills: ['review'] } },
      author: 'backend',
    });

    await h.adapter.review(h.run.runId, task(), result());

    expect(await h.reviews.readReviews(h.run.runId)).toEqual([]);
    const requested = (await h.store.readEvents(h.run.runId)).find(
      (event) => event.type === 'review_requested',
    );
    expect(requested?.detail['reason']).toContain('no configured member');
  });

  it('records a blocked review when the reviewer answers with nothing usable', async () => {
    const h = await harness({ answer: { verdict: 'yes please' } });
    await h.adapter.review(h.run.runId, task(), result());

    expect(await h.reviews.readReviews(h.run.runId)).toEqual([]);
    const completed = (await h.store.readEvents(h.run.runId)).find(
      (event) => event.type === 'review_completed',
    );
    expect(completed?.detail['verdict']).toBe('blocked');
  });

  it('survives a reviewer that could not run at all', async () => {
    const h = await harness({
      answer: () => {
        throw new StageFailure('code-review', 'runner_unavailable', 'the runner was unavailable');
      },
    });

    await expect(h.adapter.review(h.run.runId, task(), result())).resolves.toBeUndefined();
    expect(await h.reviews.readReviews(h.run.runId)).toEqual([]);
  });

  it('refuses an approve that came with findings it did not explain', async () => {
    // The schema's own refusal: a verdict other than approve needs at least one finding,
    // and the inverse — a reviewer that says approve is saying it found nothing blocking.
    const h = await harness({ answer: { verdict: 'changes_requested', findings: [] } });
    await h.adapter.review(h.run.runId, task(), result());

    expect(await h.reviews.readReviews(h.run.runId)).toEqual([]);
  });
});

describe('a sequential run has no tree to name', () => {
  it('records the review without one rather than inventing it', async () => {
    const h = await harness();
    const { integration, ...sequential } = result();
    void integration;

    await h.adapter.review(h.run.runId, task(), TaskResultSchema.parse(sequential));

    const [record] = await h.reviews.readReviews(h.run.runId);
    expect(record).toBeDefined();
    expect(record?.reviewedTree).toBeUndefined();
  });
});

/**
 * I-46 and M6-ACC-19: every loop terminates.
 *
 * The round number was computed from the log and compared against nothing, so a task
 * whose review kept asking for changes could be reviewed without end. Checked before a
 * reviewer is named and before a call is spent — a budget that stops the *next* round
 * after paying for this one is not a budget.
 */
describe('a review loop has an end (§30, I-46)', () => {
  it('stops asking once the rounds are spent', async () => {
    const h = await harness({ review: { maxRounds: 2 } });

    await h.adapter.review(h.run.runId, task(), result());
    await h.adapter.review(h.run.runId, task(), result());
    await h.adapter.review(h.run.runId, task(), result());

    expect((await h.reviews.readReviews(h.run.runId)).map((r) => r.round)).toEqual([1, 2]);
  });

  it('spends no model call on the round it refuses', async () => {
    const h = await harness({ review: { maxRounds: 1 } });

    await h.adapter.review(h.run.runId, task(), result());
    const spent = h.calls.length;
    await h.adapter.review(h.run.runId, task(), result());

    expect(h.calls.length).toBe(spent);
  });

  it('records why it stopped, with the budget it was given', async () => {
    const h = await harness({ review: { maxRounds: 1 } });

    await h.adapter.review(h.run.runId, task(), result());
    await h.adapter.review(h.run.runId, task(), result());

    const exhausted = (await h.store.readEvents(h.run.runId)).filter(
      (event) => event.type === 'review_budget_exhausted',
    );

    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.detail).toMatchObject({ task: 'TASK-003', rounds: 1, budget: 1 });
  });

  /** Running out is not agreement. Nothing new is written, so the last verdict stands. */
  it('leaves the last review standing rather than approving anything', async () => {
    const findings = [
      { severity: 'high', type: 'correctness', description: 'a', suggestedAction: 'b' },
    ];
    const h = await harness({
      review: { maxRounds: 1 },
      answer: { verdict: 'changes_requested', findings },
    });

    await h.adapter.review(h.run.runId, task(), result());
    await h.adapter.review(h.run.runId, task(), result());

    const records = await h.reviews.readReviews(h.run.runId);
    expect(records).toHaveLength(1);
    expect(records[0]?.verdict).toBe('changes_requested');
  });
});
