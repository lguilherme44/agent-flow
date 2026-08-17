import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  FailedAttemptSchema,
  FailureContextPacketSchema,
  PlanSchema,
  RunEventSchema,
  RunStateSchema,
  TaskAttemptResultSchema,
  TaskResultSchema,
  ReviewResultSchema,
  VerificationArtifactSchema,
  mechanicalVerificationOf,
  semanticVerificationOf,
} from '../../src/contracts/index.js';

/**
 * Every schema AR-00 touched, against artifacts written before it existed.
 *
 * **This is the milestone's mandatory gate, and it is mechanical for a reason.** §8 claims
 * every change is additive and defaulted; a claim about compatibility that nothing
 * executes is a claim that holds until the first user upgrades. So the fixtures are real
 * artifacts from the AF-2026-002 evidence run, sanitized — absolute paths replaced,
 * command output bounded — and structurally untouched: no field added, none removed.
 *
 * They live under `test/fixtures/legacy-artifacts/` rather than being read out of the
 * repository's own `.agent-flow/`. A test that read the live directory would pass or fail
 * according to what somebody last ran locally, and would break the moment that run was
 * cleaned — which is the opposite of what a compatibility fixture is for.
 *
 * What each assertion is really pinning:
 *
 *   - a `TaskProgress` with no `infrastructureFailures` (AD-37) still parses, and reads 0;
 *   - a `RunState` with no `autonomy` block (AD-46) still parses, and stays *absent* —
 *     absent is not `{ correctiveRoundsUsed: 0 }`, because a run that predates the grant
 *     never had one;
 *   - an `agentReport` with no `claimedFilesChanged` (AD-39) still parses, and reads `[]`;
 *   - a task carrying `scope: "backend"` still parses — the AR §8.3 name collision, which
 *     is why the containment mode is `scopeMode`;
 *   - a flat `verification.json` still reads as a semantic verdict, and reports **no**
 *     mechanical section rather than a `NOT_RUN` one.
 */

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'legacy-artifacts');

const read = (relative: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, relative), 'utf8'));

describe('the fixtures are genuinely pre-milestone (guards every assertion below)', () => {
  // Without this, every test in this file could pass by reading artifacts somebody had
  // already migrated — and a compatibility suite that asserts nothing about the old shape
  // is a suite that will keep passing after compatibility is lost.
  it('carries none of the fields AR-00 adds', () => {
    const state = read('state.json') as Record<string, unknown>;
    const tasks = state['tasks'] as Record<string, unknown>[];

    expect(state['autonomy']).toBeUndefined();
    for (const task of tasks) {
      expect(task['infrastructureFailures']).toBeUndefined();
      expect(task['failureClass']).toBeUndefined();
    }

    const attempt = read('tasks/TASK-002/attempt-2.json') as Record<string, unknown>;
    const report = attempt['agentReport'] as Record<string, unknown>;
    expect(report['claimedFilesChanged']).toBeUndefined();
    expect(attempt['acceptance']).toBeUndefined();
    expect(attempt['treeComparison']).toBeUndefined();

    const verification = read('reviews/verification.json') as Record<string, unknown>;
    expect(verification['mechanical']).toBeUndefined();
    expect(verification['semantic']).toBeUndefined();
    expect(verification['verdict']).toBeDefined();
  });

  it('names no absolute path, so the fixture leaks no machine layout', () => {
    // §7.2's rule applied to the fixtures themselves. A sanitizer that missed is a
    // sanitizer that publishes a developer's home directory in the repository.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
      );

    for (const file of walk(FIXTURES)) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/\/Users\//);
      expect(text, file).not.toMatch(/\/home\/[a-z]/);
    }
  });
});

describe('RunStateSchema (AD-37, AD-46, §8.1, §8.2)', () => {
  it('parses a state file written before the counter was split', () => {
    const parsed = RunStateSchema.parse(read('state.json'));
    expect(parsed.tasks.length).toBeGreaterThan(0);
  });

  it('defaults infrastructureFailures to 0 rather than leaving it absent', () => {
    // The reason this matters: a reader comparing against a budget must get a number.
    // `undefined >= 2` is `false`, so an absent counter would silently read as "budget
    // available" forever.
    const parsed = RunStateSchema.parse(read('state.json'));
    for (const task of parsed.tasks) {
      expect(task.infrastructureFailures).toBe(0);
      expect(typeof task.infrastructureFailures).toBe('number');
    }
  });

  it('leaves autonomy absent, and does not invent a grant', () => {
    // A defaulted `{ correctiveRoundsUsed: 0 }` would say "this run was granted bounded
    // corrective autonomy and has used none of it" about a run created before AD-46
    // existed. Absent is the honest answer and is a third state, exactly as
    // `isolationMode` already is for runs predating MVP 2.
    const parsed = RunStateSchema.parse(read('state.json'));
    expect(parsed.autonomy).toBeUndefined();
  });

  it('keeps failureClass and lastFailureAt absent when nothing classified a failure', () => {
    const parsed = RunStateSchema.parse(read('state.json'));
    for (const task of parsed.tasks) {
      expect(task.failureClass).toBeUndefined();
      expect(task.lastFailureAt).toBeUndefined();
    }
  });
});

describe('PlanSchema and TaskSchema (AD-38, C-15, §8.3)', () => {
  it('parses a plan whose tasks predate every new field', () => {
    const parsed = PlanSchema.parse(read('plan.json'));
    expect(parsed.tasks.length).toBe(9);
  });

  it('keeps the free-form scope label intact, and adds no containment mode', () => {
    // The AR §8.3 collision, pinned. Every task in this plan carries
    // `scope: "backend" | "docs" | "infra"`, so redefining `scope` as a two-value enum
    // would have made this exact fixture fail to parse. The containment mode is
    // `scopeMode`, and it is absent here — absence means `declared`, so a plan written
    // before the field is not granted an open scope.
    const parsed = PlanSchema.parse(read('plan.json'));
    const labels = new Set(parsed.tasks.map((task) => task.scope).filter(Boolean));

    expect([...labels].sort()).toEqual(['backend', 'docs', 'infra']);
    for (const task of parsed.tasks) {
      expect(task.scopeMode).toBeUndefined();
      expect(task.expectsNoChange).toBeUndefined();
      expect(task.requiredEvidence).toBeUndefined();
    }
  });

  it('rejects a containment mode that is not one of the two declared values', () => {
    // The positive control: `scopeMode` really is the enum, so the test above is
    // asserting absence of a real field rather than of a typo.
    const plan = read('plan.json') as { tasks: Record<string, unknown>[] };
    const first = plan.tasks[0] as Record<string, unknown>;

    expect(
      PlanSchema.safeParse({ ...plan, tasks: [{ ...first, scopeMode: 'backend' }] }).success,
    ).toBe(false);
    expect(
      PlanSchema.safeParse({ ...plan, tasks: [{ ...first, scopeMode: 'open' }] }).success,
    ).toBe(true);
  });
});

describe('TaskAttemptResultSchema (AD-39, C-15, §8.6)', () => {
  const attempts = [
    'tasks/TASK-001/attempt-1.json',
    'tasks/TASK-002/attempt-2.json',
    'tasks/TASK-003/attempt-1.json',
    'tasks/TASK-003/attempt-3.json',
    'tasks/TASK-004/attempt-1.json',
    'tasks/TASK-005/attempt-1.json',
    'tasks/TASK-006/attempt-1.json',
  ];

  it.each(attempts)('parses %s unchanged', (relative) => {
    const parsed = TaskAttemptResultSchema.parse(read(relative));
    expect(parsed.attempt).toBeGreaterThan(0);
  });

  it('defaults claimedFilesChanged to an empty list', () => {
    // Empty rather than a copy of `filesChanged`. Copying would fabricate a claim the
    // agent never made, and AD-39's whole point is that the claim and the mechanical
    // answer are separate records that can be compared.
    for (const relative of attempts) {
      const parsed = TaskAttemptResultSchema.parse(read(relative));
      expect(parsed.agentReport.claimedFilesChanged).toEqual([]);
    }
  });

  it('defaults the acceptance map to empty and leaves treeComparison absent', () => {
    const parsed = TaskAttemptResultSchema.parse(read('tasks/TASK-001/attempt-1.json'));
    expect(parsed.acceptance).toEqual([]);
    expect(parsed.treeComparison).toBeUndefined();
  });

  it('cannot persist agentReport as anything but an object', () => {
    /**
     * AR-00's acceptance criterion, and a *correction* to the specification's premise.
     *
     * §8.6 states that `TASK-002/attempt-2.json` holds `agentReport` as a raw JSON string
     * while `TASK-001/attempt-1.json` holds an object, and calls it an inconsistency AR-00
     * must fix. **Measured against the artifacts, that divergence does not exist**: all
     * seven attempt artifacts of AF-2026-002 hold an object, and the byte after
     * `"agentReport":` is `{` in every one of them. There was nothing to fix.
     *
     * The invariant is still worth making mechanical rather than assumed, because the
     * failure it describes is real even if that run did not suffer it: a reader that has to
     * sniff whether it got an object or a string holding one will eventually guess wrong.
     * The schema refuses both a string and a stringified object, and the writer parses
     * through the schema — so the only way to persist one is to bypass the writer.
     */
    const attempt = read('tasks/TASK-001/attempt-1.json') as Record<string, unknown>;
    const report = attempt['agentReport'];

    expect(typeof report).toBe('object');

    expect(
      TaskAttemptResultSchema.safeParse({ ...attempt, agentReport: JSON.stringify(report) })
        .success,
      'a stringified report was accepted',
    ).toBe(false);
    expect(
      TaskAttemptResultSchema.safeParse({ ...attempt, agentReport: 'COMPLETED' }).success,
      'a bare string was accepted',
    ).toBe(false);
  });

  it('still refuses a receipt that disagrees with the judgement', () => {
    // The pre-existing refinement, re-asserted after the schema grew. A new member that
    // relaxed this would be a receipt for validation that was never satisfied.
    const attempt = read('tasks/TASK-001/attempt-1.json') as Record<string, unknown>;
    expect(
      TaskAttemptResultSchema.safeParse({ ...attempt, validationJudgement: 'unsatisfied' })
        .success,
    ).toBe(false);
  });

  it('refuses a tree comparison whose conclusion contradicts its own hashes', () => {
    const attempt = read('tasks/TASK-001/attempt-1.json') as Record<string, unknown>;
    const tree = 'a'.repeat(40);

    expect(
      TaskAttemptResultSchema.safeParse({
        ...attempt,
        treeComparison: { baseTree: tree, validatedTree: tree, identical: false },
      }).success,
    ).toBe(false);
    expect(
      TaskAttemptResultSchema.safeParse({
        ...attempt,
        treeComparison: { baseTree: tree, validatedTree: tree, identical: true },
      }).success,
    ).toBe(true);
  });
});

describe('TaskResultSchema', () => {
  it.each([
    'tasks/TASK-001/result.json',
    'tasks/TASK-002/result.json',
    'tasks/TASK-003/result.json',
    'tasks/TASK-004/result.json',
    'tasks/TASK-005/result.json',
    'tasks/TASK-006/result.json',
  ])('parses %s unchanged', (relative) => {
    expect(TaskResultSchema.safeParse(read(relative)).success).toBe(true);
  });
});

describe('review artifacts', () => {
  it.each(['reviews/plan-review.json', 'reviews/final-review.json'])(
    'parses %s unchanged',
    (relative) => {
      expect(ReviewResultSchema.safeParse(read(relative)).success).toBe(true);
    },
  );

  it('reads a legacy flat verification.json as a semantic verdict', () => {
    // The evidence run's own artifact: `{ verdict, summary, findings }` at the top level,
    // with no reviewer and no independence — it was the model's raw response, persisted.
    // `ReviewResultSchema` cannot parse it, which is exactly why AD-45 needs its own
    // artifact schema rather than reusing that one.
    const raw = read('reviews/verification.json');
    expect(ReviewResultSchema.safeParse(raw).success).toBe(false);

    const artifact = VerificationArtifactSchema.parse(raw);
    const semantic = semanticVerificationOf(artifact);

    expect(semantic?.verdict).toBe('PASS');
    expect(semantic?.findings.length).toBeGreaterThan(0);
  });

  it('reports no mechanical section for a legacy artifact, rather than NOT_RUN', () => {
    // The distinction AD-45 turns on. `undefined` means "this artifact predates the
    // question"; `NOT_RUN` means "the environment could not answer". Reading the first as
    // the second would retroactively make every completed run `not done`, and reading it
    // as `PASS` would be the silent-pass path this decision exists to close.
    const artifact = VerificationArtifactSchema.parse(read('reviews/verification.json'));
    expect(mechanicalVerificationOf(artifact)).toBeUndefined();
  });

  it('reads the new split shape from the same schema', () => {
    const artifact = VerificationArtifactSchema.parse({
      mechanical: {
        verdict: 'FAIL',
        commands: [{ command: 'npm test', exitCode: 1, durationMs: 10 }],
        skipped: [],
        workspacePrepared: true,
      },
      semantic: { verdict: 'PASS', findings: [] },
    });

    expect(mechanicalVerificationOf(artifact)?.verdict).toBe('FAIL');
    expect(semanticVerificationOf(artifact)?.verdict).toBe('PASS');
  });

  it('refuses a NOT_RUN verification that does not say why', () => {
    // C-22's rule at the schema level: an unexplained NOT_RUN is "something failed,
    // inspect logs" with the words removed.
    const base = {
      commands: [],
      skipped: [],
      workspacePrepared: false,
    };

    expect(
      VerificationArtifactSchema.safeParse({
        mechanical: { ...base, verdict: 'NOT_RUN' },
      }).success,
    ).toBe(false);
    expect(
      VerificationArtifactSchema.safeParse({
        mechanical: { ...base, verdict: 'NOT_RUN', notRunReason: 'install exited 1' },
      }).success,
    ).toBe(true);
  });
});

describe('the event log (§8.8)', () => {
  it('parses every event the evidence run wrote', () => {
    const lines = readFileSync(join(FIXTURES, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);

    expect(lines.length).toBeGreaterThan(100);
    for (const line of lines) {
      expect(RunEventSchema.safeParse(JSON.parse(line)).success).toBe(true);
    }
  });

  it('accepts an event carrying the new recovery detail, with no migration', () => {
    // `detail` is an open record, which is what makes event enrichment free. Asserted
    // rather than assumed, because the milestones above this one depend on it.
    const enriched = RunEventSchema.parse({
      at: '2026-08-17T15:00:00.000Z',
      type: 'task_failure_classified',
      detail: { task: 'TASK-002', failureClass: 'acceptance_evidence_missing', consumedAttempt: true },
    });

    expect(enriched.detail['failureClass']).toBe('acceptance_evidence_missing');
  });
});

describe('the two new artifacts (§8.4, §8.5)', () => {
  // No fixture exists for these: they are new files, and the evidence run's failed
  // attempts are precisely the ones that left nothing behind (AD-34). What is worth
  // pinning is the invariant §17.3 depends on.
  const failed = {
    run: 'AF-2026-002',
    task: 'TASK-003',
    attempt: 2,
    base: 'b'.repeat(40),
    branch: 'agent-flow/AF-2026-002-6c9e32b9e51f1c1e/TASK-003/attempt-2',
    workspace: 'AF-2026-002-6c9e32b9e51f1c1e/TASK-003/attempt-2',
    runner: 'agy',
    reasoning: 'high' as const,
    startedAt: '2026-08-17T16:30:46.277Z',
    finishedAt: '2026-08-17T16:31:15.306Z',
    failureClass: 'runner_permission_required' as const,
    runnerErrorCode: 'execution_failed' as const,
    consumedAttempt: false,
  };

  it('parses a failed attempt and defaults its repair counter', () => {
    const parsed = FailedAttemptSchema.parse(failed);
    expect(parsed.repairAttempts).toBe(1);
    expect(parsed.consumedAttempt).toBe(false);
  });

  it('has no agentReport member at all', () => {
    // The separation AD-34 rests on: "no `attempt-<n>.json`" must keep meaning "the
    // attempt's work was never observed". A report on this artifact would be evidence of
    // a report nobody made.
    const parsed = FailedAttemptSchema.parse({
      ...failed,
      agentReport: { status: 'COMPLETED', notes: [], deviations: [], claimedFilesChanged: [] },
    }) as Record<string, unknown>;

    expect(parsed['agentReport']).toBeUndefined();
  });

  it('requires consumedAttempt to be recorded rather than inferred', () => {
    const { consumedAttempt: _omitted, ...withoutDecision } = failed;
    expect(FailedAttemptSchema.safeParse(withoutDecision).success).toBe(false);
  });

  it('parses a failure context packet and defaults its truncation record', () => {
    const packet = FailureContextPacketSchema.parse({
      previousAttempt: 1,
      failureClass: 'validation_unsatisfied',
      failedChecks: [{ command: 'npm run test', exitCode: 1, tail: 'FAIL 1 test' }],
      acceptanceCriteria: ['the dispatch test fails'],
      correctiveObjective: 'make the new dispatch test pass',
    });

    expect(packet.truncated).toEqual([]);
    expect(packet.successfulChecks).toEqual([]);
    expect(packet.previousDiffStat).toBeUndefined();
  });

  it('requires a corrective objective, so a packet cannot be silent about the goal', () => {
    expect(
      FailureContextPacketSchema.safeParse({
        previousAttempt: 1,
        failureClass: 'validation_unsatisfied',
        correctiveObjective: '',
      }).success,
    ).toBe(false);
  });
});

describe('the fixture set is complete enough to be worth trusting', () => {
  it('covers every artifact kind the evidence run produced', () => {
    for (const relative of [
      'state.json',
      'plan.json',
      'events.jsonl',
      'reviews/plan-review.json',
      'reviews/verification.json',
      'reviews/final-review.json',
    ]) {
      expect(existsSync(join(FIXTURES, relative)), relative).toBe(true);
    }

    // Six tasks, and the two attempts that failed left no artifact — which is the
    // absence AD-34 exists to fix, recorded here as a fact about the fixture set.
    const tasks = readdirSync(join(FIXTURES, 'tasks')).sort();
    expect(tasks).toEqual([
      'TASK-001',
      'TASK-002',
      'TASK-003',
      'TASK-004',
      'TASK-005',
      'TASK-006',
    ]);

    const attemptFiles = tasks.flatMap((task) =>
      readdirSync(join(FIXTURES, 'tasks', task)).filter((f) => f.startsWith('attempt-')),
    );
    expect(attemptFiles.length).toBe(7);
  });
});
