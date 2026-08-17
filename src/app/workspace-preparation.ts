import type { GitWorkspaces } from '../adapters/git/git-workspaces.js';
import type { ProcessRunner } from '../ports/index.js';
import { runCommands } from './verification-commands.js';

/**
 * The one preparation sequence (§8.1, AD-44).
 *
 * ```text
 * assert clean  →  project.commands.install  →  assert clean
 *   (checkout)        only when configured        (setup)
 * ```
 *
 * **Extracted because it had exactly one caller and needed two.** Every task worktree went
 * through this and the integration worktree did not, so the evidence run's `review`
 * produced four `exit 127`s — lint, typecheck, test and build, each reporting a missing
 * binary — in a tree where `npm install` had never run. Those exit codes described the
 * environment and were read as a verdict on the code.
 *
 * `install` is **not** a verification step and is deliberately absent from
 * `VERIFICATION_ORDER`. It has to run before the step whose failure it would otherwise be
 * blamed for, and a project that declares no install command is not a project that failed
 * to install.
 *
 * Nothing model-authored reaches a shell here: `commands.install` is human-written
 * configuration, run through the same `runCommands` and the same timeout policy as
 * validation (S-11, V-01).
 */

const MAX_REPORTED_CHANGES = 5;

/** Which assertion refused. `checkout` never reaches the install. */
export type PreparationPhase = 'checkout' | 'setup';

export interface PreparationFailure {
  readonly phase: PreparationPhase;
  /** Repository-relative, bounded. Never an absolute path (§21.3). */
  readonly changes: readonly string[];
  /**
   * What went wrong, for a person — and **path-free by construction**.
   *
   * This string is persisted and reaches an HTTP response, so §7.2 and §21.3 apply. That
   * rules out the obvious implementation: forwarding Git's stderr or the install command's
   * output, both of which routinely name the absolute directory they ran in.
   */
  readonly detail: string;
}

export type PreparationOutcome =
  | {
      readonly ok: true;
      /** What ran, when anything did. `workspace_prepared` records both fields (C-10). */
      readonly install?: { readonly command: string; readonly exitCode: number };
    }
  | { readonly ok: false; readonly failure: PreparationFailure };

export interface PreparationDeps {
  readonly workspaces: GitWorkspaces;
  readonly processRunner: ProcessRunner;
}

export interface PreparationRequest {
  /** Absolute path of the workspace to prepare. Never persisted. */
  readonly path: string;
  /** `project.commands.install`, when the project declares one. */
  readonly install?: string;
}

export async function prepareWorkspace(
  deps: PreparationDeps,
  request: PreparationRequest,
): Promise<PreparationOutcome> {
  // §8.1, first assertion. A checkout can be born dirty — `core.autocrlf` and
  // `.gitattributes` filters both do it — and catching that here, separately from the
  // post-setup assertion, is why the two phases exist.
  const checkout = await assertClean(deps, request.path, 'checkout');
  if (checkout !== null) return { ok: false, failure: checkout };

  const install = request.install;
  if (install === undefined || install.trim().length === 0) return { ok: true };

  const ran = await runInstall(deps, install, request.path);
  if (!ran.ok) return ran;

  // §8.1, second assertion. Ignored files do not count — `node_modules/` is exactly what
  // setup is supposed to produce (§8.2).
  const setup = await assertClean(deps, request.path, 'setup');
  if (setup !== null) return { ok: false, failure: setup };

  return { ok: true, install: { command: install, exitCode: ran.exitCode } };
}

/**
 * The cleanliness authority, asked the same way both times (§8.2).
 *
 * **A status that cannot be read fails closed.** "I could not measure it" is not "it is
 * clean": treating an unreadable repository as clean would run commands in a workspace
 * nobody verified, which is precisely what this gate exists to prevent.
 */
async function assertClean(
  deps: PreparationDeps,
  path: string,
  phase: PreparationPhase,
): Promise<PreparationFailure | null> {
  const status = await deps.workspaces.status({ cwd: path });
  if (!status.ok) {
    return { phase, changes: [], detail: `the workspace could not be inspected (${status.failure.code})` };
  }
  if (status.value.clean) return null;

  return {
    phase,
    changes: status.value.entries.slice(0, MAX_REPORTED_CHANGES).map((entry) => entry.path),
    detail:
      phase === 'checkout'
        ? 'the fresh checkout was not clean'
        : 'the install command changed files that are tracked or not ignored',
  };
}

async function runInstall(
  deps: PreparationDeps,
  command: string,
  cwd: string,
): Promise<{ ok: true; exitCode: number } | { ok: false; failure: PreparationFailure }> {
  const outcome = await runCommands({ processRunner: deps.processRunner, commands: [command], cwd });

  if (outcome.passed) {
    return { ok: true, exitCode: outcome.results[0]?.exitCode ?? 0 };
  }

  // The exit status, never the output. `npm` writes the absolute path of the directory it
  // ran in on almost every failure, and this sentence is persisted. `doctor` is where the
  // output goes (§8.4), and a refused worktree keeps the real thing (§7.4).
  const exitCode = outcome.results.find((result) => result.exitCode !== 0)?.exitCode;
  return {
    ok: false,
    failure: {
      phase: 'setup',
      changes: [],
      detail:
        exitCode === undefined || exitCode === null
          ? 'the install command did not complete'
          : `the install command exited ${String(exitCode)}`,
    },
  };
}
