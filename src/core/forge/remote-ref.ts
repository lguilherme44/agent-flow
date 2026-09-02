// A run id is a string in this codebase; `RunIdSchema` validates it at the boundary.
type RunId = string;

/**
 * The branch a run publishes to (M7 §10).
 *
 * **Derived, never chosen.** No agent picks a ref, no model output reaches this function,
 * and the shape is one a person would not type by accident — which is what makes "this
 * branch belongs to that run" checkable rather than assumed.
 */
export const RUN_BRANCH_PREFIX = 'agent-flow/';

/**
 * Branch names this product refuses to publish to, whatever the remote says its default
 * is (M7 §9).
 *
 * A static list is half the rule and the half that always works. Asking the API for the
 * repository's real default requires a configured provider, so a `publish` without one
 * could only ever enforce this half — which is why publication is *also* restricted to the
 * run-owned prefix. A repository whose default is `develop` is protected by the prefix
 * rather than by this list, and the spec says so rather than pretending the list is
 * complete.
 */
const NEVER: readonly string[] = ['main', 'master', 'trunk', 'develop', 'default', 'HEAD'];

export function runBranchFor(runId: RunId): string {
  // The id is already `AF-2026-001`-shaped and validated by its schema; the replace is a
  // belt on top of braces, so a future id format cannot smuggle a ref-path separator.
  return `${RUN_BRANCH_PREFIX}${runId.replace(/[^A-Za-z0-9._-]/g, '-')}`;
}

/** Whether a branch is one this run may publish to. */
export function isRunOwnedBranch(branch: string, runId: RunId): boolean {
  return branch === runBranchFor(runId);
}

/**
 * Why a destination is refused, or `undefined` when it is allowed.
 *
 * A sentence rather than a boolean: every refusal in this product is something an operator
 * has to be able to act on, and "publication refused" without the reason sends them to the
 * source.
 */
export function refuseDestination(branch: string, runId: RunId): string | undefined {
  const trimmed = branch.trim();

  if (trimmed !== branch || trimmed.length === 0) {
    return 'a destination branch cannot be empty or padded with whitespace';
  }

  if (NEVER.includes(trimmed) || NEVER.includes(trimmed.toLowerCase())) {
    return `"${trimmed}" is an integration branch of the repository, and this tool never publishes to one`;
  }

  // Git's own ref rules, the subset that matters here. `git check-ref-format` is the
  // authority and this is not trying to replace it — it is refusing the shapes that would
  // let a ref mean something other than a branch.
  if (/^-|\.\.|@\{|[~^:?*[\\\x00-\x20\x7f]|\/\/|\/$|\.lock$|^\/|\.$/.test(trimmed)) {
    return `"${trimmed}" is not a shape this tool will use as a branch name`;
  }

  if (!isRunOwnedBranch(trimmed, runId)) {
    return (
      `"${trimmed}" is not this run's branch — ${runId} publishes to ` +
      `"${runBranchFor(runId)}" and to nothing else`
    );
  }

  return undefined;
}
