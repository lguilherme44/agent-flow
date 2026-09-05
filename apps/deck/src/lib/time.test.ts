import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MINUTE, SECOND, formatDuration, formatOffset, formatRelative, scaleTime, ticks } from './time';

describe('formatDuration', () => {
  it('picks the grain a person would', () => {
    expect(formatDuration(840)).toBe('840ms');
    expect(formatDuration(2_400)).toBe('2.4s');
    expect(formatDuration(41 * SECOND)).toBe('41s');
    expect(formatDuration(41 * MINUTE + 22 * SECOND)).toBe('41m 22s');
    expect(formatDuration(5 * MINUTE)).toBe('5m');
    expect(formatDuration(HOUR + 3 * MINUTE)).toBe('1h 03m');
    expect(formatDuration(2 * DAY + 5 * HOUR)).toBe('2d 05h');
  });

  it('is honest about nothing', () => {
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-09-04T12:00:00.000Z');

  it('rounds towards the reader', () => {
    expect(formatRelative('2026-09-04T11:59:40.000Z', now)).toBe('just now');
    expect(formatRelative('2026-09-04T11:57:00.000Z', now)).toBe('3m ago');
    expect(formatRelative('2026-09-04T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelative('2026-09-03T06:00:00.000Z', now)).toBe('yesterday');
    expect(formatRelative(undefined, now)).toBe('—');
  });
});

describe('formatOffset', () => {
  it('carries a sign, so a scrubber reads as a distance', () => {
    expect(formatOffset(41 * MINUTE + 22 * SECOND)).toBe('+41m 22s');
    expect(formatOffset(-3 * SECOND)).toBe('−3.0s');
  });
});

describe('scaleTime', () => {
  const scale = scaleTime([1_000, 2_000], [0, 500]);

  it('maps and inverts, clamped to the range', () => {
    expect(scale(1_000)).toBe(0);
    expect(scale(1_500)).toBe(250);
    expect(scale(2_000)).toBe(500);
    expect(scale(9_000)).toBe(500);
    expect(scale.invert(250)).toBe(1_500);
    expect(scale.invert(-50)).toBe(1_000);
  });

  it('survives a zero-width domain, which a run that just started has', () => {
    const flat = scaleTime([5, 5], [0, 100]);
    expect(flat(5)).toBe(0);
    expect(flat.invert(50)).toBe(5);
  });
});

describe('ticks', () => {
  it('lands on round instants at a density the width can hold', () => {
    const start = Date.parse('2026-09-04T12:00:07.000Z');
    const end = start + 47 * MINUTE;
    const out = ticks([start, end], 900);
    // 47 minutes over 900px: a five-minute step, 12:05 through 12:45.
    expect(out.length).toBe(9);
    for (const at of out) expect(at % MINUTE).toBe(0);
    expect(out[0]).toBeGreaterThanOrEqual(start);
    expect(out[out.length - 1]).toBeLessThanOrEqual(end);
  });

  it('is empty when there is nowhere to put a tick', () => {
    expect(ticks([10, 10], 900)).toEqual([]);
    expect(ticks([0, 10], 0)).toEqual([]);
  });
});
