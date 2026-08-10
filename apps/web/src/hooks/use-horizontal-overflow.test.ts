import { describe, it, expect } from 'vitest';
import { measureOverflow, NO_OVERFLOW } from './use-horizontal-overflow';

/**
 * UI-P02 — where the fade appears, and where it must not.
 *
 * The arithmetic is tested rather than the hook, because the hook is listeners
 * and the arithmetic is the part that can be wrong. A fade over a row with
 * nothing behind it is worse than no fade at all: it tells the reader to scroll
 * and then nothing moves.
 */
describe('measureOverflow', () => {
  it('reports nothing when the content fits', () => {
    expect(measureOverflow({ scrollWidth: 800, clientWidth: 800, scrollLeft: 0 })).toEqual(
      NO_OVERFLOW,
    );
  });

  it('treats a single pixel of slack as rounding rather than content', () => {
    // `scrollWidth` is an integer and `clientWidth` is a rounded layout width, so
    // a row that fits exactly can report one pixel of overflow. Believing it
    // leaves a permanent fade on a pipeline that has nothing hidden.
    expect(measureOverflow({ scrollWidth: 801, clientWidth: 800, scrollLeft: 0 })).toEqual(
      NO_OVERFLOW,
    );
  });

  it('fades right at the start of a scrollable row', () => {
    expect(measureOverflow({ scrollWidth: 1_200, clientWidth: 800, scrollLeft: 0 })).toEqual({
      left: false,
      right: true,
    });
  });

  it('fades both sides in the middle', () => {
    expect(measureOverflow({ scrollWidth: 1_200, clientWidth: 800, scrollLeft: 200 })).toEqual({
      left: true,
      right: true,
    });
  });

  it('fades left only at the end', () => {
    expect(measureOverflow({ scrollWidth: 1_200, clientWidth: 800, scrollLeft: 400 })).toEqual({
      left: true,
      right: false,
    });
  });

  it('does not fade right when a fractional scroll leaves the row at its end', () => {
    // Browsers report a fractional `scrollLeft` on high-DPI displays, so the
    // last pixel is never reached exactly and the right fade would never clear.
    expect(measureOverflow({ scrollWidth: 1_200, clientWidth: 800, scrollLeft: 399.6 })).toEqual({
      left: true,
      right: false,
    });
  });
});
