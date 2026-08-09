import type { Clock } from '../../src/ports/index.js';

/** Deterministic clock. Advances only when a test says so. */
export class FixedClock implements Clock {
  private current: number;

  constructor(start = '2026-08-09T20:00:00.000Z') {
    this.current = Date.parse(start);
  }

  now(): string {
    return new Date(this.current).toISOString();
  }

  monotonicMs(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
