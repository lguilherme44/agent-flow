/**
 * Formatting the dashboard shares.
 *
 * Kept apart from the components so it can be tested without rendering
 * anything — these are the parts most likely to be quietly wrong, and the
 * hardest to notice in a screenshot.
 */

/**
 * A duration a person can read at a glance.
 *
 * Two units at most: `41m22s`, not `41m 22s 431ms`. The third unit is never the
 * one anybody is reading, and it makes the column jump every second.
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1_000) return `${String(Math.round(ms))}ms`;

  const totalSeconds = Math.floor(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${String(hours)}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${String(minutes)}m${String(seconds).padStart(2, '0')}s`;
  return `${String(seconds)}s`;
}

/** Clock time, for a log line or a start marker. */
export function formatTime(iso: string | undefined): string {
  if (iso === undefined) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
}

/** "Today at 19:34" for something recent, a date for anything older. */
export function formatWhen(iso: string | undefined, now = new Date()): string {
  if (iso === undefined) return '—';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const sameDay = date.toDateString() === now.toDateString();
  const time = formatTime(iso);

  if (sameDay) return `Today at ${time}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday at ${time}`;

  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`;
}

/**
 * Acronyms this project uses as words, and that title-casing would mangle.
 *
 * `sdd` is a stage name everywhere else in the tool — in the CLI, in the file on
 * disk, in the specification. Rendering it "Sdd" in one place makes the reader
 * wonder whether it is the same thing.
 */
const ACRONYMS = new Set(['sdd', 'dag', 'cli', 'ui', 'api', 'fr', 'nfr', 'sec']);

/** Turns a snake or kebab identifier into something readable. */
export function humanise(value: string): string {
  return value
    .replace(/[-_]/g, ' ')
    .split(' ')
    .map((word) =>
      ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.replace(/^\w/, (character) => character.toUpperCase()),
    )
    .join(' ');
}

export function formatPercent(value: number): string {
  return `${String(Math.round(value))}%`;
}
