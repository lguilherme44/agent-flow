import { describe, it, expect, afterEach, vi } from 'vitest';
import { resumeHint, writeStageProgress } from '../../src/cli/feature.js';
import { renderPlanningProgress } from '../../src/cli/status.js';
import { formatElapsed, writeProgress } from '../../src/cli/render/progress.js';

/**
 * The three defects a real run exposed, all of them about the same thing: from
 * the terminal, a run that is working and a run that has died look identical.
 *
 * A5 — `discovery` ran for 4m08s and printed nothing until it was over, because
 *      the start line was behind `--verbose`.
 * A7 — `status` marked the stage that was generating with `·`, the same mark as
 *      the four stages that had not begun.
 * A11 — the failure printed the runner's error and stopped, never mentioning
 *      `--from`, which resumes keeping everything already produced.
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

afterEach(() => {
  captured.length = 0;
});

describe('A5 — a stage announces itself before it runs, not only after', () => {
  it('writes the stage as it starts, without --verbose', () => {
    const restore = capture();
    try {
      writeStageProgress('discovery', 'started', false);
    } finally {
      restore();
    }
    expect(captured.join('')).toContain('discovery');
    expect(captured.join('')).toContain('→');
  });

  it('still writes the finished line', () => {
    const restore = capture();
    try {
      writeStageProgress('discovery', 'completed', false);
    } finally {
      restore();
    }
    expect(captured.join('')).toContain('✓');
    expect(captured.join('')).toContain('discovery');
  });

  it('marks a reused stage as cached rather than as work done', () => {
    const restore = capture();
    try {
      writeStageProgress('discovery', 'cached', false);
    } finally {
      restore();
    }
    expect(captured.join('')).toContain('(cached)');
  });

  it('ends a non-TTY start line, so a log file gets one stage per line', () => {
    // `isTTY` is undefined under vitest, which is the redirected case: `\r`
    // would mean nothing there and both lines have to stand on their own.
    const restore = capture();
    try {
      writeStageProgress('sdd', 'started', false);
    } finally {
      restore();
    }
    expect(captured.join('')).toMatch(/\n$/);
  });
});

describe('A11 — the failure says where to pick the run back up', () => {
  it('names the stage that stopped, in a line that can be run', () => {
    const hint = resumeHint('planning');
    expect(hint).toContain('--from planning');
    expect(hint).toContain('agent-flow feature');
  });

  it('says the earlier stages survive, because that is the reason to use it', () => {
    expect(resumeHint('planning')).toContain('kept');
  });

  it('warns that revise is the other tool, and costs a cycle', () => {
    const hint = resumeHint('sdd');
    expect(hint).toContain('revision cycle');
  });

  it('stays silent when no stage had started — nothing to resume from', () => {
    expect(resumeHint(undefined)).toBe('');
  });
});

describe('A7 — status distinguishes running from not started', () => {
  it('marks the stage the log is inside, even when state.stage lags behind', () => {
    // Measured on AF-2026-002: `state.stage` read `architecture-impact` while
    // `stage_started` for `sdd` was already written and the model was generating.
    const lines = renderPlanningProgress(
      ['discovery', 'architecture-impact'],
      'architecture-impact',
      'running',
      ['discovery', 'architecture-impact', 'sdd'],
    );

    const sdd = lines.find((line) => line.includes('SDD'));
    expect(sdd).toContain('…');
  });

  it('leaves a stage that has not begun as pending', () => {
    const lines = renderPlanningProgress(['discovery'], 'sdd', 'running', ['discovery', 'sdd']);
    const planReview = lines.find((line) => line.includes('Plan Review'));
    expect(planReview).toContain('·');
    expect(planReview).not.toContain('…');
  });

  it('keeps a finished stage finished, even though it also started', () => {
    const lines = renderPlanningProgress(['discovery'], 'sdd', 'running', ['discovery', 'sdd']);
    const discovery = lines.find((line) => line.includes('Discovery'));
    expect(discovery).toContain('✓');
  });

  it('marks nothing as running once the run itself stopped', () => {
    const lines = renderPlanningProgress(['discovery'], 'sdd', 'failed', ['discovery', 'sdd']);
    expect(lines.some((line) => line.includes('…'))).toBe(false);
  });

  it('still falls back to state.stage when no events were written yet', () => {
    // The window between `createRun` and the first `stage_started`: the field is
    // the only thing that knows the run has begun.
    const lines = renderPlanningProgress([], 'discovery', 'running');
    expect(lines.find((line) => line.includes('Discovery'))).toContain('…');
  });
});

describe('a stage served from cache is not a stage pending', () => {
  it('marks a reused stage as done, with its provenance beside it', () => {
    const lines = renderPlanningProgress([], 'sdd', 'running', ['sdd'], ['discovery']);
    const discovery = lines.find((line) => line.includes('Discovery'));
    expect(discovery).toContain('✓');
    expect(discovery).toContain('(cached)');
  });

  it('does not print the cache suffix on a stage this run actually executed', () => {
    const lines = renderPlanningProgress(['discovery'], 'sdd', 'running', ['discovery'], []);
    expect(lines.find((line) => line.includes('Discovery'))).not.toContain('(cached)');
  });

  it('prefers a real execution over an earlier reuse of the same stage', () => {
    const lines = renderPlanningProgress(['sdd'], 'planning', 'running', ['sdd'], ['sdd']);
    const sdd = lines.find((line) => line.includes('SDD'));
    expect(sdd).toContain('✓');
    expect(sdd).not.toContain('(cached)');
  });
});

describe('a stale cache is a note, not a second start', () => {
  it('says nothing about staleness by default — the stage is already announced', () => {
    // Measured: discovery emitted `started` and then `stale`, and the log showed
    // `→ discovery` twice above one `✓ discovery`.
    const restore = capture();
    try {
      writeStageProgress('discovery', 'started', false);
      writeStageProgress('discovery', 'stale', false);
    } finally {
      restore();
    }
    const arrows = captured.join('').match(/→/g) ?? [];
    expect(arrows).toHaveLength(1);
  });

  it('explains the re-run under --verbose, where detail belongs', () => {
    const restore = capture();
    try {
      writeStageProgress('discovery', 'stale', true);
    } finally {
      restore();
    }
    expect(captured.join('')).toContain('stale');
  });
});


describe('a finished unit says how long it took (§95)', () => {
  it('times each label separately, so overlapping tasks do not borrow each other\'s clock', () => {
    // Measured on a live run: `→ discovery` and `✓ discovery` printed 116 seconds apart,
    // with no number on either line. A slow stage and a hung one read the same.
    vi.useFakeTimers();
    const lines: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });

    try {
      writeProgress('TASK-001', 'started');
      vi.advanceTimersByTime(4_000);
      writeProgress('TASK-002', 'started');
      vi.advanceTimersByTime(112_000);
      // TASK-001 has been open 116s, TASK-002 only 112s.
      writeProgress('TASK-001', 'completed');
      writeProgress('TASK-002', 'failed');
    } finally {
      write.mockRestore();
      vi.useRealTimers();
    }

    expect(lines.find((line) => line.includes('✓ TASK-001'))).toMatch(/1m56s/);
    expect(lines.find((line) => line.includes('✗ TASK-002'))).toMatch(/1m52s/);
  });

  it('reads seconds under a minute and minutes above it', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(59_400)).toBe('59s');
    expect(formatElapsed(116_500)).toBe('1m57s');
    expect(formatElapsed(3_600_000)).toBe('60m00s');
  });

  it('says nothing when the unit was never announced, rather than timing from zero', () => {
    const lines: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      writeProgress('never-started', 'completed');
    } finally {
      write.mockRestore();
    }
    expect(lines[0]?.trimEnd()).toMatch(/✓ never-started$/);
  });
});


describe('the prompt size reaches a screen (§95, AR-09)', () => {
  it('shows what each finished stage was given, and stays quiet about the ones it cannot', () => {
    // Measured live: 3.9 KB at discovery, 57.4 KB at plan-review — fifteen-fold across
    // five stages, recorded on every run and visible only to somebody parsing
    // `events.jsonl`. The 80% window warning that would otherwise catch this is inert:
    // it needs a `contextWindow` that no runner declares.
    const lines = renderPlanningProgress(
      ['discovery', 'sdd'],
      'planning',
      'running',
      ['planning'],
      [],
      new Map([['discovery', 4041], ['sdd', 30515]]),
    );

    expect(lines.find((line) => line.includes('Discovery'))).toContain('3.9 KB in');
    expect(lines.find((line) => line.includes('SDD'))).toContain('29.8 KB in');
    // Nothing measured for a stage that has not finished, and nothing invented for it.
    expect(lines.find((line) => line.includes('Task Planning'))).not.toContain('KB');
  });
});
