import type { Clock } from '../../ports/clock.js';

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }

  monotonicMs(): number {
    return performance.now();
  }
}
