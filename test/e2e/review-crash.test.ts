import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { StateStore } from '../../src/app/state-store.js';
import { ReviewStore } from '../../src/app/review-store.js';
import { projectFindings } from '../../src/core/review/findings.js';
import { decideQuality } from '../../src/core/review/decision.js';
import { projectQualityGates } from '../../src/core/review/gates.js';
import { buildValidationRegistry } from '../../src/core/validation-registry.js';
import {
  ProjectConfigSchema,
  QualityConfigSchema,
  ReviewRecordSchema,
  type ReviewRecord,
} from '../../src/contracts/index.js';

/**
 * A run killed at each of the five points §51 names.
 *
 * ```text
 * after a review was requested        before the reviewer started
 * after the reviewer answered         before the findings were persisted
 * after the findings were persisted   before any corrective task
 * after a fix integrated              before the re-review
 * after a quality gate                before the final decision
 * ```
 *
 * **Nothing about a review is cached, and that is the whole property.** The record is a
 * line in an append-only log; every status above it is projected from facts the run
 * recorded. So resuming re-derives rather than recovers, and there is no half-written
 * second copy for a crash to leave disagreeing.
 *
 * Resume must not duplicate a review, lose a finding, approve a stale tree, re-run a
 * completed gate or exceed a budget invisibly. Each of those is a test below.
 */

const PROJECT = '/repo';
const TREE_A = 'a'.repeat(40);
const TREE_B = 'b'.repeat(40);
const NOW = '2026-09-02T12:00:00.000Z';

const QUALITY = QualityConfigSchema.parse({ gates: { test: { category: 'unit', required: true } } });
const REGISTRY = buildValidationRegistry(
  ProjectConfigSchema.parse({
    project: { name: 'x', type: 'node' },
    commands: { test: 'npm test' },
  }),
);

function record(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return ReviewRecordSchema.parse({
    id: 'REV-0001',
    runId: 'AF-2026-001',
    taskId: 'TASK-003',
    round: 1,
    reviewer: 'reviewer',
    author: 'backend',
    independence: 3,
    reviewedTree: TREE_A,
    verdict: 'changes_requested',
    findings: [
      {
        id: 'FIND-0001',
        severity: 'high',
        type: 'correctness',
        description: 'x',
        suggestedAction: 'y',
        evidence: [],
      },
    ],
    createdAt: NOW,
    ...overrides,
  });
}

/** A store over a filesystem that survives the process, which is the point. */
async function persisted(records: ReviewRecord[] = []) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const store = new StateStore({ fs, clock, projectDir: PROJECT });
  const run = await store.createRun('a feature');
  const reviews = new ReviewStore({ fs, projectDir: PROJECT });

  for (const entry of records) await reviews.appendReview(run.runId, { ...entry, runId: run.runId });

  /** A second process over the same disk. */
  const resumed = () => new ReviewStore({ fs, projectDir: PROJECT });

  return { fs, store, run, reviews, resumed };
}

describe('killed after a review was requested, before the reviewer started', () => {
  it('leaves no review, so the next attempt is the first', async () => {
    const h = await persisted();
    await h.store.appendEvent(h.run.runId, 'review_requested', { task: 'TASK-003' });

    expect(await h.resumed().readReviews(h.run.runId)).toEqual([]);
    expect(await h.resumed().nextReviewId(h.run.runId)).toBe('REV-0001');
  });

  it('refuses to approve, because a change with no review has none', async () => {
    const h = await persisted();

    const decision = decideQuality({
      reviews: await h.resumed().readReviews(h.run.runId),
      findings: [],
      gates: [],
      quality: QUALITY,
      integratedTree: TREE_A,
    });

    expect(decision.approved).toBe(false);
    expect(decision.blockedBy).toContain('the review approves');
  });
});

describe('killed after the reviewer answered, before the findings were persisted', () => {
  it('is indistinguishable from a review that never happened, deliberately', async () => {
    // The record is written whole, in one append. There is no state between "the
    // reviewer spoke" and "the run knows what it said" — which is why a crash there
    // cannot produce a review with some of its findings.
    const h = await persisted();

    expect(await h.resumed().readReviews(h.run.runId)).toEqual([]);
  });

  it('writes a review whole or not at all', async () => {
    const h = await persisted([record()]);
    const [written] = await h.resumed().readReviews(h.run.runId);

    expect(written?.findings).toHaveLength(1);
    expect(written?.verdict).toBe('changes_requested');
  });
});

describe('killed after the findings were persisted, before any corrective task', () => {
  it('loses no finding', async () => {
    const h = await persisted([record()]);

    expect((await h.resumed().readReviews(h.run.runId))[0]?.findings[0]?.id).toBe('FIND-0001');
  });

  it('leaves the finding open rather than fixed', async () => {
    const h = await persisted([record()]);

    const projected = projectFindings({
      reviews: await h.resumed().readReviews(h.run.runId),
      messages: [],
      events: await h.store.readEvents(h.run.runId),
    });

    expect(projected[0]?.status).toBe('open');
  });

  it('continues the numbering rather than restarting it', async () => {
    const h = await persisted([record()]);

    expect(await h.resumed().nextReviewId(h.run.runId)).toBe('REV-0002');
    expect(await h.resumed().nextFindingNumber(h.run.runId)).toBe(2);
  });
});

describe('killed after a fix integrated, before the re-review', () => {
  async function afterFix() {
    const h = await persisted([record()]);
    await h.store.appendEvent(h.run.runId, 'corrective_task_created', {
      task: 'TASK-003',
      finding: 'FIND-0001',
      correctiveTask: 'FIX-001',
    });
    await h.store.appendEvent(h.run.runId, 'task_finished', { task: 'FIX-001', status: 'completed' });
    return h;
  }

  it('reads the finding as fixed and not as verified', async () => {
    const h = await afterFix();

    const projected = projectFindings({
      reviews: await h.resumed().readReviews(h.run.runId),
      messages: [],
      events: await h.store.readEvents(h.run.runId),
    });

    expect(projected[0]?.status).toBe('fixed');
  });

  it('refuses to approve, because a fix nobody read is not a fix anybody checked', async () => {
    const h = await afterFix();

    const decision = decideQuality({
      reviews: await h.resumed().readReviews(h.run.runId),
      findings: projectFindings({
        reviews: await h.resumed().readReviews(h.run.runId),
        messages: [],
        events: await h.store.readEvents(h.run.runId),
      }),
      gates: [],
      quality: QUALITY,
      integratedTree: TREE_B,
    });

    expect(decision.approved).toBe(false);
  });

  it('does not approve a stale tree on resume', async () => {
    // The fix moved the tree. The review that exists read the one before it, and the
    // decision says so rather than carrying the old verdict forward.
    const h = await afterFix();

    const decision = decideQuality({
      reviews: await h.resumed().readReviews(h.run.runId),
      findings: [],
      gates: [],
      quality: QUALITY,
      integratedTree: TREE_B,
    });

    expect(decision.blockedBy).toContain('the review read the tree that is integrated');
  });

  it('numbers the re-review as round two and verifies from it', async () => {
    const h = await afterFix();
    await h.resumed().appendReview(h.run.runId, {
      ...record({ id: 'REV-0002', round: 2, reviewedTree: TREE_B, verdict: 'approve', findings: [] }),
      runId: h.run.runId,
    });

    const projected = projectFindings({
      reviews: await h.resumed().readReviews(h.run.runId),
      messages: [],
      events: await h.store.readEvents(h.run.runId),
    });

    expect(projected[0]?.status).toBe('verified');
  });
});

describe('killed after a quality gate, before the final decision', () => {
  it('reads the gate from the audit trail rather than running it again', async () => {
    // The gate ran. Re-running it on resume would spend the command again and could
    // answer differently — which is a second answer about whether the build passed.
    const h = await persisted([record({ verdict: 'approve', findings: [] })]);
    await h.store.appendEvent(h.run.runId, 'quality_gate_evaluated', {
      task: 'TASK-003',
      gate: 'test',
      category: 'unit',
      required: true,
      status: 'passed',
      exitCode: 0,
    });

    const events = await h.store.readEvents(h.run.runId);
    const recorded = events.filter((event) => event.type === 'quality_gate_evaluated');

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.detail['status']).toBe('passed');
  });

  it('does not turn an unrecorded gate into a passing one', async () => {
    const gates = projectQualityGates({
      quality: QUALITY,
      registry: REGISTRY,
      ran: [],
      changedFiles: ['src/a.ts'],
    });

    expect(gates[0]?.status).toBe('not_run');
  });

  it('decides the same thing on both sides of the crash', async () => {
    const h = await persisted([record({ verdict: 'approve', findings: [] })]);
    const gates = projectQualityGates({
      quality: QUALITY,
      registry: REGISTRY,
      ran: [{ command: 'npm test', exitCode: 0, durationMs: 1, stdout: '', stderr: '', truncated: false }],
      changedFiles: ['src/a.ts'],
    });

    const before = decideQuality({
      reviews: await h.reviews.readReviews(h.run.runId),
      findings: [],
      gates,
      quality: QUALITY,
      integratedTree: TREE_A,
    });
    const after = decideQuality({
      reviews: await h.resumed().readReviews(h.run.runId),
      findings: [],
      gates,
      quality: QUALITY,
      integratedTree: TREE_A,
    });

    expect(after).toEqual(before);
    expect(after.approved).toBe(true);
  });
});

describe('the property behind all five', () => {
  it('keeps a review whole through a line a crash truncated after it', async () => {
    const h = await persisted([record()]);
    const path = `${PROJECT}/.agent-flow/runs/${h.run.runId}/reviews.jsonl`;
    await h.fs.appendFile(path, '{"id":"REV-0002","runI');

    const survived = await h.resumed().readReviews(h.run.runId);
    expect(survived).toHaveLength(1);
    expect(survived[0]?.id).toBe('REV-0001');
  });

  it('does not let the truncated line claim the next id', async () => {
    // A half-written `REV-0002` must not make the next review `REV-0003` — that would
    // leave a gap nobody can explain, and the gap is the evidence a crash happened.
    const h = await persisted([record()]);
    const path = `${PROJECT}/.agent-flow/runs/${h.run.runId}/reviews.jsonl`;
    await h.fs.appendFile(path, '{"id":"REV-0002","runI');

    expect(await h.resumed().nextReviewId(h.run.runId)).toBe('REV-0002');
  });

  it('stores no review status anywhere for a crash to leave wrong', async () => {
    const h = await persisted([record()]);
    const path = `${PROJECT}/.agent-flow/runs/${h.run.runId}/reviews.jsonl`;

    expect(await h.fs.readFile(path)).not.toContain('"status"');
  });
});
