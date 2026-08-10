import { useCallback, useEffect, useState } from 'react';

/**
 * Whether a horizontally scrollable element has content out of sight, and where.
 *
 * The pipeline scrolls sideways below 1440 (§71), and a row that scrolls with no
 * visible edge is a row people read as complete. The fade is the only thing on
 * screen that says otherwise, so it has to be driven by measurement rather than
 * by a breakpoint: a stage list of three steps does not overflow at any width,
 * and a fade over it would be a lie in the other direction.
 *
 * Measured on scroll and on resize. Nothing here reads a media query — the
 * question is about this element's content, not about the viewport.
 */
export interface HorizontalOverflow {
  /** Content is hidden to the left, i.e. the element has been scrolled. */
  readonly left: boolean;
  /** Content is hidden to the right. */
  readonly right: boolean;
}

export const NO_OVERFLOW: HorizontalOverflow = { left: false, right: false };

/**
 * A pixel of slack is rounding, not content.
 *
 * `scrollWidth` is an integer and `clientWidth` is a rounded layout width, so a
 * row that fits exactly can report one pixel of overflow — which would leave a
 * permanent fade on a pipeline with nothing hidden behind it.
 */
const SLACK_PX = 1;

export function useHorizontalOverflow(): {
  readonly ref: (node: HTMLElement | null) => void;
  readonly overflow: HorizontalOverflow;
} {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [overflow, setOverflow] = useState<HorizontalOverflow>(NO_OVERFLOW);

  const ref = useCallback((next: HTMLElement | null) => {
    setNode(next);
  }, []);

  useEffect(() => {
    if (node === null) return undefined;

    const measure = (): void => {
      setOverflow(measureOverflow(node));
    };

    measure();
    node.addEventListener('scroll', measure, { passive: true });

    // The row can start fitting and stop fitting without anybody scrolling:
    // the window resizes, the inspector opens, a stage appears. Absent in some
    // test environments, where the initial measurement is the whole answer.
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined;
    observer?.observe(node);

    return () => {
      node.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [node]);

  return { ref, overflow };
}

/** Exported for tests: the arithmetic, without a DOM to attach listeners to. */
export function measureOverflow(element: {
  scrollWidth: number;
  clientWidth: number;
  scrollLeft: number;
}): HorizontalOverflow {
  const hidden = element.scrollWidth - element.clientWidth;
  if (hidden <= SLACK_PX) return NO_OVERFLOW;

  return {
    left: element.scrollLeft > SLACK_PX,
    right: element.scrollLeft < hidden - SLACK_PX,
  };
}
