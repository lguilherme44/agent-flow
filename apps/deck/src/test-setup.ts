import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

/**
 * `AbortSignal.timeout` hung on a clock the fake timers can actually move.
 *
 * jsdom implements it as `globalObject.setTimeout(...)` against its own window, and Vitest 5
 * stopped making that window the object `vi.useFakeTimers()` patches. Measured on this
 * machine, same jsdom (25.0.1) and same Node (22): under Vitest 2 the abort fires after
 * `advanceTimersByTimeAsync(200)`; under Vitest 5 it never fires, and `api.test.ts`'s
 * deadline test stopped being an assertion and became a five-second timeout — the loudest
 * possible way for a test to say nothing.
 *
 * Rebuilt here on the global `setTimeout`, which is the same three lines jsdom runs and the
 * same observable contract: a signal that aborts after `ms` with a `TimeoutError`
 * DOMException. **No assertion was relaxed** — `getJson` is still required to be pending at
 * nineteen seconds and rejected by twenty-one. Only the clock the abort hangs on moved.
 */
Object.defineProperty(AbortSignal, 'timeout', {
  writable: true,
  configurable: true,
  value(milliseconds: number): AbortSignal {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    }, milliseconds);
    return controller.signal;
  },
});
