import { describe, it, expect } from 'vitest';
import { renderEscalation } from '../../src/cli/render/escalation.js';
import type { RuntimeEscalation } from '../../src/contracts/index.js';

/**
 * AR-08 — `AUTO_RECOVERY_EXHAUSTED` renders the full C-22 contract.
 *
 * C-22's last line is a prohibition: **no surface renders the message "something failed,
 * inspect logs"**. It is written as a prohibition because that sentence is what a surface
 * emits by default — the run knows the class, the counters, the evidence and every repair
 * it tried, and none of it reaches the person unless something puts it there.
 *
 * The cost is not aesthetic. The evidence run's sixteen manual operations were mostly a
 * person reconstructing, from `events.jsonl` by hand, facts the run already held.
 */

const escalation = (overrides: Partial<RuntimeEscalation> = {}): RuntimeEscalation => ({
  task: 'TASK-003',
  failureClass: 'validation_unsatisfied',
  counts: { attempts: 3, modelCalls: 3, identicalFailures: 2 },
  evidence: ['npm test → exit 1: AssertionError: expected 2, got 3'],
  attemptedRepairs: [
    { step: 'work_retry', outcome: 'requeued' },
    { step: 'env_repair', outcome: 'did not complete' },
  ],
  humanAction: 'Read .agent-flow/runs/AF-1/tasks/TASK-003/attempt-3.failed.json and fix `npm test`',
  ...overrides,
});

describe('what an exhausted run tells the person who has to fix it', () => {
  it('names the task and the failure class', () => {
    const rendered = renderEscalation(escalation());

    expect(rendered).toContain('TASK-003');
    expect(rendered).toContain('validation_unsatisfied');
  });

  it('shows every counter, so the numbers in the message are re-checkable', () => {
    const rendered = renderEscalation(escalation());

    expect(rendered).toContain('attempts');
    expect(rendered).toContain('3');
    expect(rendered).toContain('identicalFailures');
  });

  it('shows the evidence', () => {
    expect(renderEscalation(escalation())).toContain('AssertionError: expected 2, got 3');
  });

  it('lists every repair with how it ended, including the one that did not finish', () => {
    // "What was already tried" is the first question, and a repair that crashed halfway is
    // the one most likely to have left something behind.
    const rendered = renderEscalation(escalation());

    expect(rendered).toContain('work_retry');
    expect(rendered).toContain('requeued');
    expect(rendered).toContain('env_repair');
    expect(rendered).toContain('did not complete');
  });

  it('ends with the one action, spelled out', () => {
    const rendered = renderEscalation(escalation());

    expect(rendered).toContain('attempt-3.failed.json');
    expect(rendered.trimEnd().split('\n').at(-1)).toContain('attempt-3.failed.json');
  });

  it('never renders the sentence C-22 forbids', () => {
    // Asserted against the degenerate input, which is where a renderer falls back to it:
    // no counts, no evidence, no repairs. Even then the task and the action are known.
    const rendered = renderEscalation(
      escalation({ counts: {}, evidence: [], attemptedRepairs: [] }),
    );

    expect(rendered).not.toMatch(/inspect (the )?logs/i);
    expect(rendered).not.toMatch(/something (went wrong|failed)/i);
    expect(rendered).toContain('TASK-003');
  });

  it('says plainly that nothing was tried, rather than printing an empty heading', () => {
    const rendered = renderEscalation(escalation({ attemptedRepairs: [] }));

    expect(rendered).toMatch(/no repair|nothing was attempted|no automatic repair/i);
  });
});

describe('an escalation that is thin says so', () => {
  it('marks a record that predates the enrichment, rather than reading as complete', () => {
    // `isCompleteEscalation` is the predicate C-22 exports so "both the CLI and the HTTP
    // API can be held to it by the same predicate, rather than each surface asserting its
    // own idea of enough detail". Neither held it, so a run recorded before the counters
    // and evidence were captured rendered as a full escalation with a few empty sections —
    // and a reader concluded the machine had barely tried.
    const rendered = renderEscalation(
      escalation({ counts: {}, evidence: [], attemptedRepairs: [] }),
    );

    expect(rendered).toMatch(/recorded before|incomplete|not recorded/i);
    // The action still leads, because it is still the thing to do.
    expect(rendered.trimEnd().split('\n').at(-1)).toContain('attempt-3.failed.json');
  });

  it('says nothing extra when the record is complete', () => {
    expect(renderEscalation(escalation())).not.toMatch(/recorded before|incomplete/i);
  });
});
