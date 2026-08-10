import { useEffect, useState } from 'react';

/**
 * A media query as state, so a layout choice can be made in JavaScript.
 *
 * Used for exactly one thing: whether the inspector sits beside the table or
 * opens as a drawer over it. That could have been done with `hidden` classes and
 * no hook — and was, briefly — but CSS visibility leaves *both* inspectors in
 * the document. One of them is invisible to the eye and entirely present to a
 * screen reader, which then finds two panels describing the same task.
 *
 * Everything else responsive in this app stays in CSS, where it belongs. This is
 * the case where the DOM itself has to differ.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchesNow(query));

  useEffect(() => {
    // Absent in some test environments. Reporting the initial answer and not
    // subscribing is better than throwing on mount.
    if (typeof window.matchMedia !== 'function') return undefined;

    const list = window.matchMedia(query);
    const update = (): void => {
      setMatches(list.matches);
    };

    update();
    list.addEventListener('change', update);
    return () => {
      list.removeEventListener('change', update);
    };
  }, [query]);

  return matches;
}

function matchesNow(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia(query).matches;
}

/** Where the inspector stops sharing the row with the table (§66). */
export const INSPECTOR_PANE = '(min-width: 1200px)';
