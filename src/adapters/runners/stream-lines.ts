/**
 * What every streaming adapter does the same way (dogfood 08/10: "tela congelada").
 *
 * Each CLI prints one JSON object per line while it works — `claude` with `stream-json`, `agy`
 * with `stream-json`, `codex exec --json` — and a pipe delivers those lines in chunks that
 * split them anywhere. The shapes inside differ per CLI and stay in each adapter; the line
 * splitting and the length of a reported message do not.
 */

/** How long a reported message may be: enough to recognise it, not a transcript. */
export const ACTIVITY_TEXT_CHARS = 200;

/** A message, trimmed and shortened for an activity line. */
export function activityText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > ACTIVITY_TEXT_CHARS ? `${trimmed.slice(0, ACTIVITY_TEXT_CHARS)}…` : trimmed;
}

/** A target (a path, a command line), trimmed and cut to the same length, without an ellipsis. */
export function activityTarget(value: string): string {
  return value.trim().slice(0, ACTIVITY_TEXT_CHARS);
}

/** One line, as the JSON object it holds, or nothing when it holds none. */
export function jsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whole lines out of chunks. `push` takes what the pipe delivered; `flush` hands over the last
 * line when the process ends without a trailing newline.
 */
export function lineSplitter(onLine: (line: string) => void): {
  readonly push: (chunk: string) => void;
  readonly flush: () => void;
} {
  let pending = '';
  return {
    push: (chunk) => {
      pending += chunk;
      // Split only when a line ended: re-splitting a long line on every chunk is quadratic, and
      // one tool result can be megabytes on a single line (adversarial review).
      if (!chunk.includes('\n')) return;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    },
    flush: () => {
      const last = pending;
      pending = '';
      if (last !== '') onLine(last);
    },
  };
}

/** A string field of a parsed line, or nothing. */
export function stringField(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}
