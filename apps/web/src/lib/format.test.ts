import { describe, it, expect } from 'vitest';
import {
  formatCompactCount,
  formatDuration,
  formatPercent,
  formatTime,
  formatWhen,
  humanise,
} from './format';

describe('formatDuration', () => {
  it('reads at a glance, never in three units', () => {
    // `41m22s`, not `41m 22s 431ms`. The third unit is never the one anybody is
    // reading, and it makes the column jump every second.
    expect(formatDuration(2_482_000)).toBe('41m22s');
    expect(formatDuration(5_000)).toBe('5s');
    expect(formatDuration(432)).toBe('432ms');
  });

  it('switches to hours without losing the minutes', () => {
    expect(formatDuration(3_600_000 + 300_000)).toBe('1h05m');
  });

  it('says nothing rather than zero when there is nothing to say', () => {
    // A dash is honest about a missing measurement; `0ms` is a claim.
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('formatWhen', () => {
  const now = new Date('2026-08-10T20:00:00.000Z');

  it('says today for today', () => {
    expect(formatWhen('2026-08-10T19:34:00.000Z', now)).toMatch(/^Today at /);
  });

  it('says yesterday for yesterday', () => {
    expect(formatWhen('2026-08-09T19:34:00.000Z', now)).toMatch(/^Yesterday at /);
  });

  it('falls back to a date for anything older', () => {
    const formatted = formatWhen('2026-07-01T19:34:00.000Z', now);
    expect(formatted).not.toMatch(/Today|Yesterday/);
    expect(formatted).toMatch(/ at /);
  });

  it('refuses to invent a time from a bad value', () => {
    expect(formatWhen('not a date', now)).toBe('—');
    expect(formatWhen(undefined, now)).toBe('—');
  });
});

describe('formatTime', () => {
  it('is 24-hour, so a log reads in order', () => {
    expect(formatTime('2026-08-10T19:56:42.000Z')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('gives up rather than guess', () => {
    expect(formatTime('nope')).toBe('—');
  });
});

describe('humanise', () => {
  it('turns an identifier into something readable', () => {
    expect(humanise('architecture-impact')).toBe('Architecture Impact');
    expect(humanise('plan_review')).toBe('Plan Review');
  });

  it('leaves an acronym alone', () => {
    // The stage is `sdd` in the CLI, in the file on disk and in the spec.
    // Title-casing it to "Sdd" in one place makes the reader wonder whether it
    // is the same thing.
    expect(humanise('sdd')).toBe('SDD');
    expect(humanise('final-review')).toBe('Final Review');
  });
});

describe('formatPercent', () => {
  it('rounds, because a dashboard is not a report', () => {
    expect(formatPercent(78.4)).toBe('78%');
  });
});

describe('formatCompactCount', () => {
  it('prints the exact number when it is short enough to read', () => {
    expect(formatCompactCount(0)).toBe('0');
    expect(formatCompactCount(999)).toBe('999');
    expect(formatCompactCount(9_999)).toBe('9999');
  });

  it('switches to one decimal at ten thousand', () => {
    expect(formatCompactCount(10_000)).toBe('10k');
    expect(formatCompactCount(47_390)).toBe('47.4k');
    expect(formatCompactCount(1_234_567)).toBe('1.2M');
  });

  it('drops a trailing zero from the decimal', () => {
    expect(formatCompactCount(11_000)).toBe('11k');
    expect(formatCompactCount(2_000_000)).toBe('2M');
  });

  it('says nothing rather than a nonsense number', () => {
    expect(formatCompactCount(undefined)).toBe('—');
    expect(formatCompactCount(-1)).toBe('—');
    expect(formatCompactCount(Number.NaN)).toBe('—');
    expect(formatCompactCount(Number.POSITIVE_INFINITY)).toBe('—');
  });
});
