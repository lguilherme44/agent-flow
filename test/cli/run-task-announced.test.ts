import { describe, it, expect, afterEach } from 'vitest';
import { writeProgress, writeTaskOutcome } from '../../src/cli/render/progress.js';

/**
 * `run` announced a task only when it finished, and only under `--verbose` when
 * it started — the same defect `feature` had, on a third surface. A task that
 * spent 45 minutes before timing out printed nothing for all of them.
 */
const captured: string[] = [];

function capture(): () => void {
  const original = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: unknown): boolean => {
    captured.push(String(chunk));
    return true;
  };
  return () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = original;
  };
}

function write(fn: () => void): string {
  const restore = capture();
  try {
    fn();
  } finally {
    restore();
  }
  return captured.join('');
}

afterEach(() => {
  captured.length = 0;
});

describe('a unit of work announces itself before it runs', () => {
  it('writes the label on start without --verbose', () => {
    expect(write(() => { writeProgress('TASK-001', 'started'); })).toContain('→ TASK-001');
  });

  it('ends the non-TTY start line, so a log gets one row per event', () => {
    expect(write(() => { writeProgress('TASK-001', 'started'); })).toMatch(/\n$/);
  });

  it('marks a completed unit', () => {
    expect(write(() => { writeProgress('sdd', 'completed'); })).toContain('✓ sdd');
  });

  it('marks a reused unit as cached, not as work done', () => {
    expect(write(() => { writeProgress('discovery', 'cached'); })).toContain('(cached)');
  });

  it('keeps stale quiet by default — it is a note, not a second start', () => {
    const out = write(() => {
      writeProgress('discovery', 'started');
      writeProgress('discovery', 'stale');
    });
    expect((out.match(/→/g) ?? [])).toHaveLength(1);
  });

  it('explains staleness under --verbose', () => {
    expect(write(() => { writeProgress('discovery', 'stale', true); })).toContain('stale');
  });
});

describe('a task outcome keeps the word beside the mark', () => {
  it('spells out completed', () => {
    const out = write(() => { writeTaskOutcome('TASK-001', 'completed'); });
    expect(out).toContain('✓ TASK-001');
    expect(out).toContain('(completed)');
  });

  it('spells out states that are neither success nor failure', () => {
    // `blocked` and `review_required` are exactly why the parenthesis exists:
    // the mark alone cannot carry them.
    const out = write(() => { writeTaskOutcome('TASK-004', 'review_required'); });
    expect(out).toContain('(review_required)');
  });

  it('marks a failure', () => {
    expect(write(() => { writeTaskOutcome('TASK-004', 'failed'); })).toContain('✗ TASK-004');
  });
});
