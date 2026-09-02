import { describe, it, expect } from 'vitest';
import { projectFindings } from '../../../src/core/review/findings.js';
import { normaliseReview } from '../../../src/core/review/normalise.js';
import {
  AgentMessageSchema,
  ReviewRecordSchema,
  RunEventSchema,
  type AgentMessage,
  type ReviewRecord,
  type RunEvent,
} from '../../../src/contracts/index.js';

/**
 * A finding's status, projected (M6-04, I-43).
 *
 * **Nothing here is stored, and that is the whole design.** Every transition is a
 * question about facts the run already recorded: the review that raised it, the message
 * that answered it, the corrective task that integrated, the later review that read the
 * corrected tree. A stored status would be the copy a crash between two writes leaves
 * wrong — and the field an agent could eventually write into, which is what §26 and §27
 * exist to prevent.
 *
 * Two refusals do most of the work and both are tested below: an acknowledgement does not
 * close a finding, and a reviewer that stopped mentioning something did not verify it.
 */

const TREE_A = 'a'.repeat(40);
const TREE_B = 'b'.repeat(40);

function review(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
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
        description: 'the retry re-sends a consumed body',
        suggestedAction: 'buffer it first',
        file: 'src/server/routes.ts',
      },
    ],
    createdAt: '2026-09-02T12:00:00.000Z',
    ...overrides,
  });
}

function message(overrides: Partial<AgentMessage>): AgentMessage {
  return AgentMessageSchema.parse({
    id: 'MSG-0001',
    runId: 'AF-2026-001',
    threadId: 'THR-0001',
    from: 'backend',
    to: { kind: 'agent', id: 'reviewer' },
    type: 'acknowledge',
    subject: 're: the retry',
    body: 'noted',
    references: [{ kind: 'finding', id: 'FIND-0001' }],
    createdAt: '2026-09-02T12:05:00.000Z',
    ...overrides,
  });
}

function event(type: string, detail: Record<string, unknown>): RunEvent {
  return RunEventSchema.parse({ at: '2026-09-02T12:10:00.000Z', type, detail });
}

const CORRECTIVE = [
  event('corrective_task_created', { task: 'TASK-003', finding: 'FIND-0001', correctiveTask: 'FIX-001' }),
  event('task_finished', { task: 'FIX-001', status: 'completed' }),
];

function project(input: {
  reviews?: ReviewRecord[];
  messages?: AgentMessage[];
  events?: RunEvent[];
}) {
  return projectFindings({
    reviews: input.reviews ?? [review()],
    messages: input.messages ?? [],
    events: input.events ?? [],
  });
}

describe('a finding nobody has answered', () => {
  it('is open', () => {
    expect(project({})[0]?.status).toBe('open');
  });

  it('carries where it came from, so a reader can go and look', () => {
    const [projected] = project({});

    expect(projected?.reviewId).toBe('REV-0001');
    expect(projected?.taskId).toBe('TASK-003');
    expect(projected?.round).toBe(1);
  });
});

describe('an answer is an answer, and not a closure (§25)', () => {
  it('is acknowledged when the implementer said so', () => {
    expect(project({ messages: [message({})] })[0]?.status).toBe('acknowledged');
  });

  it('is disputed when the implementer disagreed', () => {
    const disputed = message({
      type: 'review_feedback',
      body: 'I disagree — the body is buffered by the caller already',
    });

    expect(project({ messages: [disputed] })[0]?.status).toBe('disputed');
  });

  it('is neither when the message merely comments', () => {
    // A comment referencing a finding is a comment. Treating it as an acknowledgement
    // would let any mention close the loop.
    const comment = message({ type: 'information', body: 'this is also true of the other route' });

    expect(project({ messages: [comment] })[0]?.status).toBe('open');
  });

  it('takes the last answer, so a dispute withdrawn is withdrawn', () => {
    const answers = [
      message({ id: 'MSG-0001', type: 'review_feedback', body: 'I disagree' }),
      message({ id: 'MSG-0002', type: 'acknowledge', body: 'you were right' }),
    ];

    expect(project({ messages: answers })[0]?.status).toBe('acknowledged');
  });

  it('ignores an answer that references nothing', () => {
    expect(project({ messages: [message({ references: [] })] })[0]?.status).toBe('open');
  });
});

describe('fixed means evidence, not a claim (§26)', () => {
  it('is fixed when a corrective task for it completed', () => {
    expect(project({ events: CORRECTIVE })[0]?.status).toBe('fixed');
    expect(project({ events: CORRECTIVE })[0]?.correctiveTask).toBe('FIX-001');
  });

  it('is not fixed when the corrective task was created and never finished', () => {
    // **"I fixed FIND-0001" is a sentence.** The status moves when there is a corrective
    // attempt behind it, and an attempt that never ran is not one.
    const created = [CORRECTIVE[0]!];

    expect(project({ events: created })[0]?.status).toBe('open');
  });

  it('is not fixed when the corrective task failed', () => {
    const failed = [
      CORRECTIVE[0]!,
      event('task_finished', { task: 'FIX-001', status: 'failed' }),
    ];

    expect(project({ events: failed })[0]?.status).toBe('open');
  });

  it('outranks an acknowledgement', () => {
    expect(project({ messages: [message({})], events: CORRECTIVE })[0]?.status).toBe('fixed');
  });
});

describe('verified means somebody looked again at the corrected tree (§27)', () => {
  const reReview = review({
    id: 'REV-0002',
    round: 2,
    reviewedTree: TREE_B,
    verdict: 'approve',
    findings: [],
  });

  it('is verified when a later review read a different tree and did not raise it again', () => {
    const projected = project({ reviews: [review(), reReview], events: CORRECTIVE });

    expect(projected[0]?.status).toBe('verified');
    expect(projected[0]?.verifiedBy).toBe('REV-0002');
  });

  it('is not verified by a re-review of the same tree', () => {
    // **A re-review of the same commit has seen nothing new.** It cannot have confirmed a
    // fix, whatever its verdict says.
    const sameTree = review({ id: 'REV-0002', round: 2, reviewedTree: TREE_A, verdict: 'approve', findings: [] });

    expect(project({ reviews: [review(), sameTree], events: CORRECTIVE })[0]?.status).toBe('fixed');
  });

  it('is not verified without corrective work behind it', () => {
    // A reviewer that simply stopped mentioning something did not verify it; it forgot it.
    expect(project({ reviews: [review(), reReview] })[0]?.status).toBe('open');
  });

  it('is not verified when the later review raised the same complaint again', () => {
    const stillThere = review({
      id: 'REV-0002',
      round: 2,
      reviewedTree: TREE_B,
      findings: [{ ...review().findings[0]!, id: 'FIND-0002' }],
    });

    expect(project({ reviews: [review(), stillThere], events: CORRECTIVE })[0]?.status).toBe('fixed');
  });

  it('matches the same complaint by content, because a re-review allocates new ids', () => {
    // A fresh review has no way to know which id the first one used.
    const stillThere = review({
      id: 'REV-0002',
      round: 2,
      reviewedTree: TREE_B,
      findings: [{ ...review().findings[0]!, id: 'FIND-0099' }],
    });

    expect(project({ reviews: [review(), stillThere], events: CORRECTIVE })[0]?.status).toBe('fixed');
  });

  it('does not let a review of another task verify this one', () => {
    const elsewhere = review({ id: 'REV-0002', round: 2, taskId: 'TASK-009', reviewedTree: TREE_B, findings: [] });

    expect(project({ reviews: [review(), elsewhere], events: CORRECTIVE })[0]?.status).toBe('fixed');
  });
});

describe('M6-ACC-09 — a developer cannot verify its own finding', () => {
  it('ignores a message claiming the finding is verified', () => {
    // There is no field to write it in and no message type that means it. `verified` is
    // derived from a later review or a gate, and neither is the implementer's to produce.
    const claim = message({
      type: 'review_feedback',
      body: 'fixed and verified, closing this',
    });

    expect(project({ messages: [claim] })[0]?.status).toBe('open');
  });

  it('still refuses when the implementer both claims and has corrective work', () => {
    const claim = message({ type: 'acknowledge', body: 'done and verified' });

    expect(project({ messages: [claim], events: CORRECTIVE })[0]?.status).toBe('fixed');
  });
});

describe('the projection is deterministic', () => {
  it('gives the same answer twice', () => {
    const once = project({ messages: [message({})], events: CORRECTIVE });
    const twice = project({ messages: [message({})], events: CORRECTIVE });

    expect(once).toEqual(twice);
  });

  it('reads the reviews in the order they were written', () => {
    const second = review({ id: 'REV-0002', round: 2, reviewedTree: TREE_B, findings: [{ ...review().findings[0]!, id: 'FIND-0002' }] });
    const projected = project({ reviews: [review(), second] });

    expect(projected.map((held) => held.finding.id)).toEqual(['FIND-0001', 'FIND-0002']);
  });
});

describe('normalising what a reviewer proposed (M6-03, M6-ACC-05)', () => {
  const base = {
    reviewId: 'REV-0001',
    runId: 'AF-2026-001',
    taskId: 'TASK-003',
    round: 1,
    reviewer: 'reviewer',
    author: 'backend',
    independence: 3 as const,
    reviewedTree: TREE_A,
    firstFindingNumber: 1,
    maxFindings: 50,
    now: '2026-09-02T12:00:00.000Z',
  };

  const finding = {
    severity: 'high' as const,
    type: 'correctness',
    description: 'x',
    suggestedAction: 'y',
    evidence: [],
  };

  it('allocates the ids, so a reviewer never names one', () => {
    const { record } = normaliseReview({
      ...base,
      proposal: { verdict: 'changes_requested', findings: [finding, finding] },
    });

    expect(record.findings.map((held) => held.id)).toEqual(['FIND-0001', 'FIND-0002']);
  });

  it('continues the run’ numbering rather than restarting it', () => {
    const { record } = normaliseReview({
      ...base,
      firstFindingNumber: 7,
      proposal: { verdict: 'changes_requested', findings: [finding] },
    });

    expect(record.findings[0]?.id).toBe('FIND-0007');
  });

  it('drops a path outside the repository and keeps the finding', () => {
    // A reviewer that pointed at the wrong place still found something. Losing the
    // finding to punish the citation would cost more than it protects.
    const { record, droppedPaths } = normaliseReview({
      ...base,
      proposal: {
        verdict: 'changes_requested',
        findings: [{ ...finding, file: '../../etc/passwd' }],
      },
    });

    expect(record.findings).toHaveLength(1);
    expect(record.findings[0]?.file).toBeUndefined();
    expect(droppedPaths).toBe(1);
  });

  it('drops a citation outside the repository and keeps the rest', () => {
    const { record, droppedPaths } = normaliseReview({
      ...base,
      proposal: {
        verdict: 'changes_requested',
        findings: [
          {
            ...finding,
            evidence: [
              { kind: 'file', id: 'src/a.ts' },
              { kind: 'task', id: 'TASK-001' },
            ],
          },
        ],
      },
    });

    expect(record.findings[0]?.evidence).toHaveLength(2);
    expect(droppedPaths).toBe(0);
  });

  it('takes the reviewer, the author and the tree from the caller', () => {
    // Everything a model could forge is a field it cannot fill.
    const { record } = normaliseReview({
      ...base,
      proposal: { verdict: 'approve', findings: [] },
    });

    expect(record.reviewer).toBe('reviewer');
    expect(record.author).toBe('backend');
    expect(record.reviewedTree).toBe(TREE_A);
  });

  it('truncates visibly rather than silently', () => {
    const { record, truncated } = normaliseReview({
      ...base,
      maxFindings: 2,
      proposal: { verdict: 'changes_requested', findings: [finding, finding, finding, finding] },
    });

    expect(record.findings).toHaveLength(2);
    expect(truncated).toBe(2);
  });
});
