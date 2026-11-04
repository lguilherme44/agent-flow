/**
 * What a test runner's output says, for the two readers that need it.
 *
 * `positive-control.ts` asks "does a failure record name one of *these* tests"; the
 * downstream attribution asks the mirror question, "which tests does it name at all". Both
 * answers come from the same two facts — where a failure record starts and where it ends —
 * and a second copy of those would be a second vocabulary for one thing.
 *
 * Pure: text in, paths and judgements out.
 */

/**
 * A line where a runner reports one failing test or file: TAP `not ok` (node:test),
 * vitest/jest `FAIL <file>`, pytest `FAILED`/`ERROR <file>::…`, the `×`/`✗`/`✖` marks, go's
 * `--- FAIL`, flutter's `[E]`, mocha's numbered `1) suite` (its stack names the file).
 */
const FAILURE_RECORD = /^\s*(?:not ok \d+|FAIL\b|FAILED\b|ERROR\b|[×✗✖]\s|--- FAIL|\d+\) \S)|\[E\]\s*$/;

/** At most this many lines under a failure mark belong to its record (TAP YAML, go's `file_test.go:12:`). */
const RECORD_LINES = 12;

/** A line that starts the next record, passing or failing: the current one ends there. */
const NEXT_RECORD =
  /^\s*(?:ok \d+|not ok \d+|PASS\b|FAIL\b|FAILED\b|ERROR\b|[✓√×✗✖]\s|--- (?:FAIL|PASS)|Test Files\b|Tests\s)/;

/** ANSI escape sequences: colour, bold, cursor moves. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

/**
 * Colours off before any match: vitest paints its `FAIL` label even through a pipe, the line
 * begins with an escape code, and a proof of 27 failures reads as nothing at all.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * Each failure record in the output: the marked line plus the lines under it up to the next
 * record. TAP puts the file in `location:`, go in the message. Without the stop,
 * `FAIL other.test.ts` followed by `✓ a.test.ts` reads as a failure of `a.test.ts`.
 */
export function failureRecords(output: string): readonly string[] {
  const lines = stripAnsi(output).split(/\r?\n/);
  const records: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (!FAILURE_RECORD.test(line)) continue;
    const record = [line];
    for (const next of lines.slice(index + 1, index + 1 + RECORD_LINES)) {
      if (NEXT_RECORD.test(next)) break;
      record.push(next);
    }
    records.push(record.join('\n'));
  }
  return records;
}

/** A character that cannot be part of a path token in runner output. */
const TOKEN_EDGE = /[\s\x27\x22\x60()[\]<>,]/;

/**
 * A path token with a file extension, as a runner prints it. Anchored on the extension
 * rather than on a directory, because go and mocha print the bare file name — and keeping a
 * leading `/` so an absolute path (TAP's `location:`) reaches the operator as printed.
 */
const PATH_TOKEN = /\/?(?:[\w@.~-]+[/\\])*[\w@.~-]+\.[A-Za-z][A-Za-z0-9]{0,9}/g;

/**
 * Whether a token looks like a source path rather than a version, a host or a sentence.
 *
 * `v1.2`, `example.com` and `Sentence.The` all survive the shape test above; the extension
 * list is what separates a file somebody can own from a word with a dot in it.
 */
const SOURCE_EXTENSION =
  /\.(?:[cm]?[jt]sx?|go|py|rb|exs?|java|kt|cs|scala|swift|php|rs|dart)$/i;

/**
 * Every source path a failure record names, normalised to `/` and de-duplicated.
 *
 * Only failure records are read: a passing `✓ a.test.ts` line names a path too, and counting
 * it would attribute a green test to whoever owns the file.
 */
export function failingPaths(output: string): readonly string[] {
  const seen = new Set<string>();
  for (const record of failureRecords(output)) {
    const text = record.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    for (const match of text.matchAll(PATH_TOKEN)) {
      const token = match[0];
      if (!SOURCE_EXTENSION.test(token)) continue;
      const before = text[match.index - 1];
      if (before !== undefined && !TOKEN_EDGE.test(before) && before !== '/') continue;
      seen.add(token.replace(/^\.\//, ''));
    }
  }
  return [...seen];
}

/**
 * Whether the text names one of the given files. Slashes are normalised and collapsed: TAP
 * escapes Windows paths, so `test\double.test.mjs` arrives doubled.
 *
 * A name counts only as a whole path token that agrees with the wanted path on every segment
 * they share, read from the file name back: runners print the path from their own root
 * (`test/unit/a.test.ts` for `backend/test/unit/a.test.ts`), absolute (TAP `location:`), or
 * the bare file name (go). **A substring was not enough**: `a.test.mjs` matched inside
 * `data.test.mjs`, and `frontend/src/index.test.ts` named `backend/src/index.test.ts`.
 */
export function namesAnyOf(output: string, wanted: readonly string[]): boolean {
  const text = output.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  return wanted.some((candidate) => {
    const parts = candidate
      .replace(/\\/g, '/')
      .split('/')
      .filter((segment) => segment.length > 0);
    const name = parts[parts.length - 1];
    if (name === undefined) return false;
    for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
      const after = text[at + name.length];
      if (after !== undefined && !TOKEN_EDGE.test(after) && after !== ':' && after !== '>') continue;
      let start = at;
      while (start > 0 && !TOKEN_EDGE.test(text[start - 1] ?? '')) start -= 1;
      const token = text
        .slice(start, at + name.length)
        .split('/')
        .filter((segment) => segment.length > 0);
      const shared = Math.min(token.length, parts.length);
      let agrees = token[token.length - 1] === name;
      for (let i = 1; agrees && i <= shared; i += 1) {
        agrees = token[token.length - i] === parts[parts.length - i];
      }
      if (agrees) return true;
    }
    return false;
  });
}

/** Whether any failure record names one of the given files. */
export function aFailureNamesAnyOf(output: string, wanted: readonly string[]): boolean {
  return failureRecords(output).some((record) => namesAnyOf(record, wanted));
}
