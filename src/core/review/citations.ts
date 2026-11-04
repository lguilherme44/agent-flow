/**
 * Citations a document makes about the code, and whether they point at anything real
 * (ported from the Smart Place kit's `lib/cite-check.ts`).
 *
 * **Two measured failures.** A request put a component in the results grid when the code had
 * it elsewhere, and nothing caught the wrong `file:line` before the work started; and a fix
 * was implemented in a file nothing imported. A reviewer judges what a citation *means* —
 * this checks, by rule, that it exists.
 *
 * Measured here too, on 04/11/2026: a plan declared `backoffice/app/routes/plan-edit.tsx` and
 * `plan-create.tsx` for one of its tasks. The directory existed; neither file did, anywhere in
 * the repository. Plausible names, invented whole, and nothing between the plan and the
 * executor that could tell.
 *
 * Pure: text in, citations out; citations plus a view of the tree in, problems out. Reading
 * the tree belongs to the caller.
 */

/** A reference to a place in the code, as written in prose or in a plan. */
export interface Citation {
  /** Line of the *citing* document, from 1. */
  readonly line: number;
  /** As written, e.g. `src/app/run-actions.ts:915`. */
  readonly text: string;
  readonly path: string;
  readonly start: number;
  readonly end?: number;
  /** Present only when the citation claims a symbol there is live code. */
  readonly symbol?: string;
}

export interface CitationProblem {
  readonly citation: Citation;
  readonly reason: 'no-such-file' | 'line-out-of-range';
  readonly detail: string;
}

/**
 * The last segment needs an extension starting with a letter, so `v1.2:3` and `10.30:00` are
 * not citations.
 */
const CITATION =
  /(?<![\w/.:@~-])((?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z][A-Za-z0-9]*):(\d+)(?:-(\d+))?(?::\d+)?(?:#([A-Za-z_$][\w$.]*))?/g;

/**
 * A slash-less name whose extension is a common top-level domain is a host, not a file:
 * `api.example.com:443` is a port, not a line.
 */
const TLD = /^(?:com|net|org|io|dev|app|co|br|ai|sh|me)$/i;

/** Fenced blocks hold command output, whose paths are relative to wherever the command ran. */
function withoutFences(text: string): string[] {
  const lines = text.split('\n');
  let fence: string | undefined;
  return lines.map((line) => {
    // `match`, not `exec`: the architecture rule forbidding spawns matches `exec(` by name,
    // and `RegExp.prototype.exec` reads the same to it.
    const opener = line.match(/^\s*(\x60\x60\x60|~~~)/);
    if (fence === undefined && opener !== null) {
      fence = opener[1];
      return '';
    }
    if (fence !== undefined) {
      if (line.includes(fence)) fence = undefined;
      return '';
    }
    return line;
  });
}

/** Every citation the text makes, in document order. */
export function citationsIn(text: string): readonly Citation[] {
  const found: Citation[] = [];
  withoutFences(text).forEach((line, index) => {
    for (const match of line.matchAll(CITATION)) {
      const [whole, path = '', startText = '', endText, symbol] = match;
      const segment = path.slice(path.lastIndexOf('/') + 1);
      const extension = segment.slice(segment.lastIndexOf('.') + 1);
      // A host, not a file. Only when there is no slash: `docs/a.io:3` is a real path.
      if (!path.includes('/') && TLD.test(extension)) continue;
      const start = Number(startText);
      found.push({
        line: index + 1,
        text: whole,
        path,
        start,
        ...(endText === undefined ? {} : { end: Number(endText) }),
        ...(symbol === undefined ? {} : { symbol }),
      });
    }
  });
  return found;
}

/** How many lines each known file has. The caller reads the tree; this only decides. */
export type LineCounts = ReadonlyMap<string, number>;

const normalise = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Resolve a cited path against what the tree holds.
 *
 * A path with no slash is looked up by file name, because specs write them that way
 * (`ProductCard.vue:680-694`). An exact match wins; a unique basename match is accepted; an
 * ambiguous basename is left unresolved rather than guessed.
 */
export function resolveCitedPath(path: string, counts: LineCounts): string | undefined {
  const wanted = normalise(path);
  if (counts.has(wanted)) return wanted;
  if (wanted.includes('/')) {
    const suffix = `/${wanted}`;
    const matches = [...counts.keys()].filter((known) => known.endsWith(suffix));
    return matches.length === 1 ? matches[0] : undefined;
  }
  const matches = [...counts.keys()].filter(
    (known) => known.slice(known.lastIndexOf('/') + 1) === wanted,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** Citations that point at nothing, or past the end of what they point at. */
export function checkCitations(
  citations: readonly Citation[],
  counts: LineCounts,
): readonly CitationProblem[] {
  const problems: CitationProblem[] = [];
  for (const citation of citations) {
    const resolved = resolveCitedPath(citation.path, counts);
    if (resolved === undefined) {
      problems.push({
        citation,
        reason: 'no-such-file',
        detail: `${citation.path} is not a file in this tree`,
      });
      continue;
    }
    const lines = counts.get(resolved) ?? 0;
    const last = citation.end ?? citation.start;
    if (last > lines) {
      problems.push({
        citation,
        reason: 'line-out-of-range',
        detail: `${resolved} has ${String(lines)} lines; the citation names ${String(last)}`,
      });
    }
  }
  return problems;
}

/**
 * A task whose declared files all fail to resolve.
 *
 * Not an error on its own — a task that *creates* files names files that do not exist yet. It
 * is a question worth asking before execution, because the other cause is a plan that invented
 * plausible paths, and the two look identical from here.
 */
export function tasksWithNoExistingFile(
  tasks: readonly { readonly id: string; readonly files: readonly string[] }[],
  counts: LineCounts,
): readonly { readonly task: string; readonly files: readonly string[] }[] {
  return tasks
    .filter(
      (task) =>
        task.files.length > 0 &&
        task.files.every((file) => resolveCitedPath(file, counts) === undefined),
    )
    .map((task) => ({ task: task.id, files: task.files }));
}
