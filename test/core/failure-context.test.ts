import { describe, it, expect } from 'vitest';
import { buildFailureContextPacket, renderFailureContext } from '../../src/core/failure-context.js';

/**
 * AD-40 (AR-03) — what a retry is told, assembled mechanically.
 *
 * `requeue` wrote `state: 'queued'` and nothing else, so the next attempt re-read the same
 * task description that had already failed once. The system held the failing command, its
 * exit code, its stderr, the previous diff and the acceptance criteria — and asked the
 * operator to explain the failure to the next attempt in a hand-written revision.
 *
 * Everything here is copied from persisted artifacts. `correctiveObjective` may be phrased
 * by a model; **no other field may be**, and a model's phrasing may not alter one.
 */

const base = {
  previousAttempt: 1,
  failureClass: 'validation_unsatisfied' as const,
  acceptanceCriteria: ['Types compile.'],
  correctiveObjective: 'Make the failing test pass.',
  budgets: { maxPacketBytes: 8192, maxRawExcerptBytes: 2048, maxDiffStatLines: 40 },
};

describe('building the packet (AD-40, C-08)', () => {
  it('carries the class, the failing command, its exit code and its tail', () => {
    const packet = buildFailureContextPacket({
      ...base,
      failedChecks: [{ command: 'npm test', exitCode: 1, tail: 'Expected 2, got 3' }],
    });

    expect(packet.failureClass).toBe('validation_unsatisfied');
    expect(packet.failedChecks[0]).toMatchObject({ command: 'npm test', exitCode: 1 });
    expect(packet.failedChecks[0]?.tail).toContain('Expected 2');
  });

  it('carries the acceptance criteria the attempt was judged against', () => {
    expect(buildFailureContextPacket(base).acceptanceCriteria).toEqual(['Types compile.']);
  });

  it('records what passed as ids only, because what failed is the work', () => {
    const packet = buildFailureContextPacket({ ...base, successfulChecks: ['lint', 'typecheck'] });
    expect(packet.successfulChecks).toEqual(['lint', 'typecheck']);
  });

  it('never contains a patch', () => {
    // AD-40 rejects handing over the previous diff: it makes a rejected attempt a
    // starting point and erodes the isolation that makes a validated tree mean anything.
    // `--stat` conveys shape without conveying content.
    const packet = buildFailureContextPacket({
      ...base,
      previousDiffStat: ' src/a.ts | 12 ++++++------\n 1 file changed',
    });

    expect(packet.previousDiffStat).toContain('1 file changed');
    expect(JSON.stringify(packet)).not.toMatch(/^\+\+\+|^---|@@/m);
  });

  it('is deterministic: identical evidence produces an identical packet', () => {
    // C-08 asks for this by name. A packet that varied between two runs of one failure
    // would make every comparison downstream meaningless.
    const input = {
      ...base,
      failedChecks: [{ command: 'npm test', exitCode: 1, tail: 'boom' }],
      successfulChecks: ['lint'],
    };

    expect(buildFailureContextPacket(input)).toEqual(buildFailureContextPacket(input));
  });
});

describe('the size budget is applied in a fixed order (§6.5)', () => {
  const huge = (n: number) => 'x'.repeat(n);

  it('stays inside maxPacketBytes', () => {
    const packet = buildFailureContextPacket({
      ...base,
      rawExcerpt: huge(6000),
      previousDiffStat: huge(6000),
      successfulChecks: Array.from({ length: 400 }, (_, i) => `check-${String(i)}`),
      failedChecks: [{ command: 'npm test', exitCode: 1, tail: huge(2000) }],
      budgets: { maxPacketBytes: 4096, maxRawExcerptBytes: 2048, maxDiffStatLines: 40 },
    });

    expect(new TextEncoder().encode(JSON.stringify(packet)).length).toBeLessThanOrEqual(4096);
  });

  it('drops previousDiffStat first, then successfulChecks, then rawExcerpt', () => {
    // Reverse-priority and fixed, so what survives is predictable rather than whatever
    // happened to be serialised last.
    const packet = buildFailureContextPacket({
      ...base,
      rawExcerpt: huge(400),
      previousDiffStat: huge(3000),
      successfulChecks: ['lint'],
      budgets: { maxPacketBytes: 1200, maxRawExcerptBytes: 2048, maxDiffStatLines: 40 },
    });

    expect(packet.truncated).toContain('previousDiffStat');
    expect(packet.previousDiffStat).toBeUndefined();
  });

  it('never truncates the class, the failed checks or the acceptance criteria', () => {
    // §6.5 names these three as untouchable: they are the evidence the retry exists to
    // act on, and a budget that ate them would leave a packet that says nothing.
    const packet = buildFailureContextPacket({
      ...base,
      rawExcerpt: huge(9000),
      previousDiffStat: huge(9000),
      successfulChecks: Array.from({ length: 900 }, (_, i) => `c-${String(i)}`),
      failedChecks: [{ command: 'npm test', exitCode: 1, tail: 'the one thing that matters' }],
      budgets: { maxPacketBytes: 900, maxRawExcerptBytes: 2048, maxDiffStatLines: 40 },
    });

    expect(packet.failureClass).toBe('validation_unsatisfied');
    expect(packet.failedChecks[0]?.tail).toContain('the one thing that matters');
    expect(packet.acceptanceCriteria).toEqual(['Types compile.']);
  });

  it('marks every field it cut, rather than cutting quietly', () => {
    const packet = buildFailureContextPacket({
      ...base,
      rawExcerpt: huge(4000),
      previousDiffStat: huge(4000),
      successfulChecks: Array.from({ length: 300 }, (_, i) => `c-${String(i)}`),
      budgets: { maxPacketBytes: 700, maxRawExcerptBytes: 2048, maxDiffStatLines: 40 },
    });

    expect(packet.truncated.length).toBeGreaterThan(0);
  });

  it('bounds the diff stat by line count as well as by bytes', () => {
    const packet = buildFailureContextPacket({
      ...base,
      previousDiffStat: Array.from({ length: 200 }, (_, i) => ` file-${String(i)}.ts | 2 +-`).join('\n'),
      budgets: { maxPacketBytes: 8192, maxRawExcerptBytes: 2048, maxDiffStatLines: 5 },
    });

    expect((packet.previousDiffStat ?? '').split('\n').length).toBeLessThanOrEqual(6);
  });

  it('leaves a small packet untouched', () => {
    const packet = buildFailureContextPacket({
      ...base,
      rawExcerpt: 'short',
      previousDiffStat: ' a.ts | 1 +',
      successfulChecks: ['lint'],
    });

    expect(packet.truncated).toEqual([]);
    expect(packet.rawExcerpt).toBe('short');
  });
});

describe('rendering it into a prompt', () => {
  it('produces a block a person and a model can both read', () => {
    const text = renderFailureContext(
      buildFailureContextPacket({
        ...base,
        failedChecks: [{ command: 'npm test', exitCode: 1, tail: 'Expected 2, got 3' }],
      }),
    );

    expect(text).toContain('npm test');
    expect(text).toContain('Expected 2, got 3');
    expect(text).toContain('Types compile.');
    expect(text).toContain('Make the failing test pass.');
  });

  it('says which attempt failed, so the next one knows it is not the first', () => {
    expect(renderFailureContext(buildFailureContextPacket(base))).toMatch(/attempt 1/i);
  });

  it('names what was cut, when anything was', () => {
    const packet = buildFailureContextPacket({
      ...base,
      previousDiffStat: 'x'.repeat(4000),
      budgets: { maxPacketBytes: 800, maxRawExcerptBytes: 2048, maxDiffStatLines: 40 },
    });

    expect(renderFailureContext(packet)).toMatch(/truncated|omitted/i);
  });
});
