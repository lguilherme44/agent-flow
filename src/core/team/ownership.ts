import {
  validateAndNormalizeRepositoryPath,
  type OwnershipRule,
  type ResourcePattern,
} from '../../contracts/index.js';

/**
 * Who is expected to touch what, and which two tasks must not touch it at once (M5).
 *
 * **Coordination, never containment** (I-37). The execution boundary is the worktree and
 * the process group; this decides who *should* take a task and which pair may not share
 * a wave. An ownership rule that was load-bearing for safety would be a sandbox
 * implemented in a policy file, and it would be the weakest one in the product.
 *
 * Pure: patterns and declared paths in, verdicts out. No filesystem, no Git, no glob
 * library — the plan writes literal repository-relative paths and the ownership map only
 * has to cover directories, so `**` and `*` are the whole vocabulary.
 *
 * **Every path is validated by `validateAndNormalizeRepositoryPath` before it is
 * matched.** That function already rejects absolute paths, `..`, percent-encoded
 * traversal, URL schemes, drive letters, UNC shares, control characters, `.git` and
 * `.agent-flow`, and a second implementation of that list is a second chance to miss one
 * of them. A path that fails it matches nothing — an unmatchable path cannot grant
 * ownership, which is the fail-closed direction.
 */

export type OwnershipVerdict = 'exclusive' | 'preferred' | 'shared' | 'none';

/**
 * Whether a pattern covers a path.
 *
 * Segment-aware, in the same sense `core/file-overlap.ts` is and for the same reason:
 * `src/auth` must cover `src/auth/login.ts` and must not cover `src/authz.ts`. A prefix
 * comparison gets the second wrong, and the second is somebody else's file.
 *
 *   `src/server/**`  covers everything under `src/server`, and `src/server` itself
 *   `src/*.ts`       covers `src/a.ts`, not `src/deep/a.ts`
 *   `src/server`     covers `src/server` and everything under it
 */
export function patternCovers(pattern: ResourcePattern, path: string): boolean {
  const normalised = validateAndNormalizeRepositoryPath(path);
  if (!normalised.valid) return false;

  const target = (normalised.normalizedPath ?? path).split('/');
  const trimmed = pattern.replace(/\/+$/, '');

  // A bare directory is `dir/**` written short. Treating it as an exact match only would
  // make every ownership map a wall of `/**`, and the one somebody forgot would silently
  // own nothing.
  const parts = (trimmed.endsWith('/**') ? trimmed.slice(0, -3) : trimmed).split('/');
  const openEnded = trimmed.endsWith('/**') || !trimmed.includes('*');

  if (!openEnded && parts.length !== target.length) return false;
  if (openEnded && target.length < parts.length) return false;

  return parts.every((part, index) => {
    const segment = target[index];
    if (segment === undefined) return false;
    if (part === '*') return true;
    if (!part.includes('*')) return part === segment;

    // A single `*` inside a segment: `*.ts`, `run-*.json`. Escaped so a pattern cannot
    // smuggle a regular expression through a path.
    const escaped = part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    return new RegExp(`^${escaped}$`).test(segment);
  });
}

/**
 * What one member's rule says about one path.
 *
 * Ordered by how much it constrains: `exclusive` narrows a wave, `preferred` only ranks,
 * `shared` says explicitly that anyone may. A path a rule does not mention is `none`,
 * which is not a refusal — most files belong to nobody in particular.
 */
export function verdictFor(rule: OwnershipRule, path: string): OwnershipVerdict {
  if (rule.exclusive.some((pattern) => patternCovers(pattern, path))) return 'exclusive';
  if (rule.preferred.some((pattern) => patternCovers(pattern, path))) return 'preferred';
  if (rule.shared.some((pattern) => patternCovers(pattern, path))) return 'shared';
  return 'none';
}

export interface OwnershipInput {
  readonly rule: OwnershipRule;
  readonly files: readonly string[];
}

/**
 * How much of a task's declared files this member owns, as 0…1.
 *
 * The ranking term. `1` for a member that owns every file the plan says the task will
 * touch, `0` for one that owns none, and the fraction in between — so a task spanning two
 * areas scores both owners partially and neither wins by accident.
 *
 * A task that declares no files scores `0` for everybody, which is a constant and
 * therefore changes no ranking. Scoring it `1` would make every ownerless task a tie the
 * tie-break has to settle.
 */
export function ownershipScore(input: OwnershipInput): number {
  if (input.files.length === 0) return 0;

  const owned = input.files.filter((file) => {
    const verdict = verdictFor(input.rule, file);
    return verdict === 'preferred' || verdict === 'exclusive';
  });

  return owned.length / input.files.length;
}

/**
 * The paths two tasks both touch that somebody has declared `exclusive`.
 *
 * **A scheduling constraint, not a permission** (I-37). Two tasks writing into an area
 * declared exclusive may not run in the same wave — whoever they are assigned to, and
 * whether or not the DAG says they are independent.
 *
 * Distinct from `core/file-overlap.ts`, which asks a different question and keeps
 * asking it: overlap is *can these changes safely happen together*, and this is *has
 * somebody said this area takes one writer at a time*. A single file both tasks name is
 * caught by overlap; a directory two different files sit under is caught only here.
 */
export function exclusiveContention(
  rules: readonly OwnershipRule[],
  a: readonly string[],
  b: readonly string[],
): string[] {
  const contended = new Set<string>();

  for (const rule of rules) {
    for (const pattern of rule.exclusive) {
      const hitsA = a.some((file) => patternCovers(pattern, file));
      const hitsB = b.some((file) => patternCovers(pattern, file));
      if (hitsA && hitsB) contended.add(pattern);
    }
  }

  return [...contended].sort();
}
