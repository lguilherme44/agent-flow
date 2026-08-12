import type { ProcessRunner } from '../../ports/process-runner.js';
import type { FileSystem } from '../../ports/file-system.js';
import { provisionGitHome } from './agent-flow-git-home.js';

/**
 * The one place Agent Flow spawns `git` (MVP 2 §12.3, I-7, S-8).
 *
 * Everything internal goes through here, and an architecture test asserts that no
 * other module builds `{ command: 'git' }`. That single boundary is what makes
 * the hook-isolation policy a property of the code rather than a rule somebody
 * has to remember at each call site — before this existed, `git-client.ts` and
 * `discovery-cache.ts` each spawned `git` on their own, and each would have had
 * to be found and fixed by hand.
 *
 * Three things this module is not:
 *
 *   - **It is not a second `ProcessRunner`.** It does not take an executable, it
 *     takes a Git subcommand from a closed list. A generic spawner that happened
 *     to default to `git` would be one argument away from being the thing this
 *     boundary exists to prevent.
 *   - **It does not interpret exit codes.** A non-zero exit is data here and
 *     meaning in `GitWorkspaces`, because the same code means different things
 *     per subcommand: `merge` exits 1 on a conflict, `merge-base --is-ancestor`
 *     exits 1 for "no", and `cat-file -e` exits 1 for "absent". Collapsing them
 *     into one failure type at this layer would throw the distinction away
 *     exactly once, at the bottom, where nothing can get it back.
 *   - **It never touches a shell.** argv only, no `/bin/sh`, no string command
 *     line (V-01, unchanged).
 */

/**
 * The Git subcommands MVP 2 uses, as a closed list.
 *
 * This is the defence against the configuration-override attack of §45, and the
 * mechanism is structural rather than a filter. Git accepts configuration only
 * *before* the subcommand — `git -c core.hooksPath=X status` configures, `git
 * status -c core.hooksPath=X` is an unknown option to `status`. So the safety
 * configuration is injected first, the subcommand comes from this list, and every
 * caller-supplied argument lands after it, in a position where it cannot be
 * configuration at all.
 *
 * Probed, because the attack is real and not theoretical: with two
 * `-c core.hooksPath=` flags on one command line, **the last one wins**, and a
 * wrapper that merely prefixed a safe value while accepting arbitrary argv would
 * inject a flag an attacker could simply repeat. See `test/adapters/git-command`.
 *
 * Adding a subcommand is a deliberate edit. That is the point.
 */
export const GIT_SUBCOMMANDS = [
  'version',
  'rev-parse',
  'status',
  'diff',
  'ls-files',
  'worktree',
  'write-tree',
  'commit-tree',
  'update-ref',
  'merge',
  'merge-base',
  'cat-file',
  'for-each-ref',
  'add',
] as const;

export type GitSubcommand = (typeof GIT_SUBCOMMANDS)[number];

const SUBCOMMANDS = new Set<string>(GIT_SUBCOMMANDS);

/**
 * Why a Git invocation could not produce an interpretable outcome.
 *
 * Deliberately **not** `RunnerErrorCode`. A coding runner's vocabulary is about
 * quota, authentication and model behaviour; this one is about an executable, a
 * repository and a clock. Merging them would put `quota_exceeded` in the same
 * enum as `git_unavailable` and invite a `catch` block that treats them alike.
 */
export const GIT_ERROR_CODES = [
  /** The `git` executable could not be found or started. */
  'git_unavailable',
  /** The command exceeded its timeout and was killed (§36). */
  'git_timed_out',
  /** Output hit the ceiling, so anything parsed from it is a partial truth (§37). */
  'git_output_truncated',
  /** A caller tried to smuggle a global option — configuration, or a `git -C` (§45). */
  'git_unsafe_argument',
  /** A non-zero exit the operation has no defined meaning for. */
  'git_command_failed',
  /** The command succeeded and said something this code cannot parse. */
  'git_invalid_output',
  /** The installed Git is below the supported floor (§23). */
  'git_version_unsupported',
] as const;

export type GitErrorCode = (typeof GIT_ERROR_CODES)[number];

export interface GitFailure {
  readonly code: GitErrorCode;
  /** What went wrong, in the words a caller will put in front of a person. */
  readonly message: string;
  readonly exitCode?: number | null;
  readonly stderr?: string;
}

/**
 * A refusal is a value, never an exception — the same rule `worktree-policy.ts`
 * follows, for the same reason: a missing object, a conflicted merge and a
 * repository that is not there are all expected outcomes, and a `catch` block
 * cannot tell them apart from a bug in this file.
 */
export interface GitRefusal {
  readonly ok: false;
  readonly failure: GitFailure;
}

export type GitResult<T> = { readonly ok: true; readonly value: T } | GitRefusal;

export function gitOk<T>(value: T): GitResult<T> {
  return { ok: true, value };
}

/**
 * Not generic, deliberately: a refusal carries no value, so it is assignable to
 * every `GitResult<T>` at once. Typing it as `GitResult<T>` would force every
 * call site to name a type parameter it has no information about, and the
 * `unknown` that results would then have to be cast back — a chain of ceremony
 * around the fact that a failure is a failure whatever the operation was.
 */
export function gitFailure(failure: GitFailure): GitRefusal {
  return { ok: false, failure };
}

/** What a completed `git` process reported. Exit codes are unclassified here. */
export interface GitOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /**
   * Output hit `maxOutputBytes`. Not a failure at this layer, because a
   * truncated `merge` still has a meaningful exit code — but every operation
   * that *parses* stdout must refuse rather than believe half of it (§37).
   */
  readonly truncated: boolean;
  /**
   * The full argument vector, safety configuration included.
   *
   * Exposed so a test can assert on what was actually going to run rather than
   * on what a fake was told. §26.1 rule 7 — "every internal Git invocation
   * carries the hook-isolation flag" — is checkable because of this field.
   */
  readonly argv: readonly string[];
}

/** Author and committer for the commits Agent Flow makes itself (§12.2). */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/** `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE`, so a marker is reproducible (§12.2). */
export interface GitDates {
  readonly author: string;
  readonly committer: string;
}

/**
 * Timeouts, centralised, because §36 requires every Git call to have one and a
 * per-call-site number is a number somebody eventually forgets.
 *
 * The tiers are about work, not about importance: `rev-parse` reads a ref file,
 * `worktree add` writes a full checkout of the repository to disk, and a merge on
 * a large tree is somewhere in between. No automatic retry sits behind any of
 * them — a Git command that timed out left the repository in a state worth
 * looking at, and running it again is a decision, not a default.
 */
export const GIT_TIMEOUT_SECONDS = {
  /** Ref and object reads: rev-parse, cat-file, merge-base, for-each-ref, version. */
  quick: 30,
  /** Working-tree reads: status, diff, ls-files, worktree list. */
  read: 60,
  /** Index and object writes: add, write-tree, commit-tree, update-ref. */
  write: 120,
  /** Full checkouts and merges: worktree add/remove/prune, merge. */
  checkout: 600,
} as const;

/** 4 MiB. A `status` over a large tree is the realistic worst case. */
export const GIT_DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface GitInvocation {
  readonly subcommand: GitSubcommand;
  /**
   * Arguments *after* the subcommand. Never configuration, never a global
   * option — see {@link GIT_SUBCOMMANDS} and {@link assertOperationArgs}.
   */
  readonly args?: readonly string[];
  readonly cwd: string;
  /** Injected as `-c user.name` / `-c user.email` by this module, not by callers. */
  readonly identity?: GitIdentity;
  readonly dates?: GitDates;
  readonly stdin?: string;
  readonly timeoutSeconds?: number;
  readonly maxOutputBytes?: number;
}

/**
 * Global options a caller must not be able to place in `args`.
 *
 * Belt and braces: the positional argument in {@link GitInvocation} already makes
 * these unreachable, because Git stops accepting global options at the
 * subcommand. This list is here so that a future refactor which loosens the
 * shape fails loudly instead of silently re-opening §45. Each entry is matched
 * both bare and in `--flag=value` form.
 */
const FORBIDDEN_GLOBAL_OPTIONS = [
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--upload-pack',
  '--receive-pack',
  '-C',
] as const;

/**
 * The one byte an argument may never contain.
 *
 * A NUL is where an argument ends as far as `execve` is concerned, so anything
 * after it is invisible to every check above and invisible to `git` too — the
 * two would simply disagree about what was passed. Nothing legitimate carries
 * one.
 *
 * **Other control characters, including newline, are allowed here on purpose.**
 * An earlier version of this rejected the whole C0 range, which looked prudent
 * and was wrong: §12.4 specifies a marker message with a subject, a body and
 * trailers, so a *newline inside one argument* is exactly what M2-05 has to be
 * able to pass. With no shell anywhere, a newline in an argv element is text and
 * nothing else. Where a newline would genuinely be dangerous — a ref, a
 * revision, a path — it is refused by that operand's own allowlist in
 * `git-workspaces.ts`, which is the right place for it: those are structured
 * values, and this is a byte-level check that cannot know which is which.
 *
 * `no-control-regex` exists to catch a control character that arrived by
 * accident; here it is the subject.
 */
// eslint-disable-next-line no-control-regex
const NUL_BYTE = /\u0000/;

/**
 * Identity values are held to the stricter rule.
 *
 * `-c user.name=<value>` ends at the end of the argument, so a newline cannot
 * start a second configuration entry — but it *can* land inside the author line
 * of a commit object, where the format is line-based and a stray newline
 * produces a commit whose headers say something nobody wrote.
 */
// eslint-disable-next-line no-control-regex
const IDENTITY_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Rejects anything in `args` that could be configuration rather than operands.
 *
 * `-c` is matched by prefix rather than by equality because Git accepts the value
 * attached (`-ccore.hooksPath=x`), and an equality check would let exactly the
 * attack of §45 through the door it was written to close. No operation in
 * {@link GIT_SUBCOMMANDS} takes a legitimate argument starting with `-c`.
 */
export function assertOperationArgs(args: readonly string[]): GitFailure | null {
  for (const arg of args) {
    if (NUL_BYTE.test(arg)) {
      return {
        code: 'git_unsafe_argument',
        message: 'a Git argument contains a NUL byte, which would truncate it',
      };
    }
    if (arg.startsWith('-c')) {
      return {
        code: 'git_unsafe_argument',
        message: `"${arg}" would set Git configuration; internal safety configuration is not overridable`,
      };
    }
    const name = arg.split('=', 1)[0] ?? arg;
    if ((FORBIDDEN_GLOBAL_OPTIONS as readonly string[]).includes(name)) {
      return {
        code: 'git_unsafe_argument',
        message: `"${arg}" is a Git global option and cannot be passed as an operation argument`,
      };
    }
  }
  return null;
}

function assertIdentity(identity: GitIdentity): GitFailure | null {
  for (const [field, value] of [
    ['user.name', identity.name],
    ['user.email', identity.email],
  ] as const) {
    if (value.length === 0 || IDENTITY_CONTROL_CHARACTERS.test(value)) {
      return {
        code: 'git_unsafe_argument',
        message: `${field} must be non-empty and free of control characters`,
      };
    }
  }
  return null;
}

export interface GitCommandDeps {
  readonly processRunner: ProcessRunner;
  /**
   * Absolute path to the Agent Flow-owned empty directory `core.hooksPath`
   * points at (§12.3). Resolved by {@link provisionGitHome} from the `Host`
   * port's home directory — never from `process.env.HOME`, and never from
   * anything a model, a plan, a run artifact or an HTTP request supplied (§22).
   */
  readonly noHooksDir: string;
}

export class GitCommand {
  private readonly processRunner: ProcessRunner;
  private readonly noHooksDir: string;

  constructor(deps: GitCommandDeps) {
    this.processRunner = deps.processRunner;
    this.noHooksDir = deps.noHooksDir;
  }

  /** The directory every invocation points `core.hooksPath` at. */
  get hooksPath(): string {
    return this.noHooksDir;
  }

  async run(invocation: GitInvocation): Promise<GitResult<GitOutcome>> {
    const args = invocation.args ?? [];

    if (!SUBCOMMANDS.has(invocation.subcommand)) {
      return gitFailure({
        code: 'git_unsafe_argument',
        message: `"${invocation.subcommand}" is not a Git subcommand this tool issues`,
      });
    }

    const unsafe = assertOperationArgs(args);
    if (unsafe !== null) return gitFailure(unsafe);

    if (invocation.identity !== undefined) {
      const badIdentity = assertIdentity(invocation.identity);
      if (badIdentity !== null) return gitFailure(badIdentity);
    }

    const argv = [
      ...this.safetyConfig(),
      ...identityConfig(invocation.identity),
      invocation.subcommand,
      ...args,
    ];

    const result = await this.processRunner.run({
      command: 'git',
      args: argv,
      cwd: invocation.cwd,
      env: environmentFor(invocation.dates),
      unsetEnv: GIT_HOSTILE_ENVIRONMENT,
      timeoutSeconds: invocation.timeoutSeconds ?? GIT_TIMEOUT_SECONDS.read,
      maxOutputBytes: invocation.maxOutputBytes ?? GIT_DEFAULT_MAX_OUTPUT_BYTES,
      ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
    });

    if (result.spawnFailed) {
      return gitFailure({
        code: 'git_unavailable',
        message: `git could not be started: ${result.stderr.trim()}`,
        stderr: result.stderr,
      });
    }

    if (result.timedOut) {
      return gitFailure({
        code: 'git_timed_out',
        message:
          `git ${invocation.subcommand} exceeded its ` +
          `${String(invocation.timeoutSeconds ?? GIT_TIMEOUT_SECONDS.read)}s timeout`,
        stderr: result.stderr,
      });
    }

    return gitOk({
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      truncated: result.truncated,
      argv: ['git', ...argv],
    });
  }

  /**
   * The configuration every internal invocation carries, and which no caller can
   * reach past.
   *
   * `core.hooksPath` is the one MVP 2 turns on (I-7). `--no-verify` was
   * considered and rejected as the mechanism (§12.3, §30.1): it is not a weaker
   * form of the same thing, it is a *different and smaller* set. Probed on Git
   * 2.52.0 — a `reference-transaction` hook fires for a plain `git update-ref`
   * and does not fire under this flag, and `--no-verify` does not exist for
   * `update-ref` at all. The same holds for the `post-checkout` hook that
   * `git worktree add` runs.
   *
   * `core.quotePath=false` is the other half, and it is a parsing decision rather
   * than a security one: with the default, `status --porcelain` and
   * `ls-files` return non-ASCII paths C-quoted, so every consumer would need a
   * de-quoting step, and the one that forgot would act on a path that does not
   * exist. Turning it off means a path in stdout is the path on disk.
   *
   * Both are placed *before* the subcommand, which is the only position Git reads
   * configuration in — so they are not "first and hopefully not overridden", they
   * are in a region no caller-supplied argument can enter.
   */
  private safetyConfig(): string[] {
    return ['-c', `core.hooksPath=${this.noHooksDir}`, '-c', 'core.quotePath=false'];
  }
}

function identityConfig(identity: GitIdentity | undefined): string[] {
  if (identity === undefined) return [];
  return ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`];
}

/**
 * Inherited variables that would let the environment decide what a Git command
 * operates on, removed from every internal invocation.
 *
 * **`cwd` is not enough, and that is the whole point.** `GIT_DIR` in the
 * environment relocates the repository regardless of where the process is
 * standing, so an Agent Flow `update-ref`, `merge` or `worktree remove` issued
 * with a perfectly correct `cwd` would act on somebody else's repository. Agent
 * Flow is started from a user's shell, and a shell that has these exported is
 * ordinary rather than exotic: every Git hook runs with `GIT_DIR` and
 * `GIT_INDEX_FILE` set, and so does anything launched from `git rebase --exec`,
 * a `filter-branch`, or a wrapper script that exports them for convenience.
 *
 * Each entry, and what it would have redirected:
 *
 * | Variable | What an inherited value does |
 * |---|---|
 * | `GIT_DIR` | Names the repository directory outright — every read and every ref write lands there. |
 * | `GIT_WORK_TREE` | Names the working tree, so `status`, `add -A` and `worktree` act on a different checkout. |
 * | `GIT_COMMON_DIR` | Relocates the shared refs and object store of a worktree setup. |
 * | `GIT_INDEX_FILE` | Redirects the index — `add -A` stages into it and `write-tree` records *it*, so the validated tree would be a tree nobody validated. |
 * | `GIT_OBJECT_DIRECTORY` | Moves where new objects are written and looked up. |
 * | `GIT_ALTERNATE_OBJECT_DIRECTORIES` | Adds object stores to the lookup path, so `cat-file -e` can answer "exists" about an object this repository does not have — which is exactly the question recovery asks before trusting a tree. |
 * | `GIT_NAMESPACE` | Rewrites every ref access under a namespace, so a ref that looks written is written elsewhere. |
 * | `GIT_CEILING_DIRECTORIES` | Stops repository discovery walking up, turning a valid `cwd` into "not a git repository". |
 * | `GIT_EXEC_PATH` | Names the directory Git loads its own subcommand programs from — the environment form of `--exec-path`, which the argument denylist already refuses. Probed: with it pointing at a directory holding an executable `git-sentinel`, `git sentinel` runs it. Leaving the variable inherited while refusing the flag would have been an asymmetry an attacker only has to notice once. |
 * | `GIT_CONFIG_COUNT`, `GIT_CONFIG_PARAMETERS` | Inject configuration. A command-line `-c` outranks both (probed), so this is defence in depth rather than the primary mechanism — the closed subcommand list is that. |
 * | `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | **Outrank `-c user.name` / `-c user.email`, which is the opposite of what the wrapper assumed.** Probed: the same tree, parent, message, identity flags and dates produce `author Agent Flow <agent-flow@local>` with a clean environment and `author Evil <evil@example.com>` with these set — two different commit ids. |
 * | `GIT_AUTHOR_DATE`, `GIT_COMMITTER_DATE` | Removed for the same reason and then set again by {@link environmentFor} when a caller supplies them. Removal comes first, so an inherited value cannot survive into an invocation that names no dates. |
 *
 * Deliberately **not** removed: `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM`
 * point at the user's own configuration files, which Agent Flow has no business
 * disabling — §12.3 isolates hooks and nothing else. `GIT_SSH*`, `GIT_ASKPASS`
 * and credential helpers stay too: MVP 2 touches no remote, and stripping a
 * user's transport setup would be a change with no threat behind it.
 */
export const GIT_HOSTILE_ENVIRONMENT = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_EXEC_PATH',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  // Identity and dates. These do not redirect *which* repository is acted on —
  // they decide what a commit Agent Flow makes actually says, and therefore what
  // its id is. §12.2 requires a marker to be a deterministic function of the
  // persisted artifact, so that re-running `commit-tree` after a crash yields the
  // same SHA and `update-ref` becomes idempotent for free (§17.4). An inherited
  // `GIT_AUTHOR_NAME` breaks exactly that: the marker becomes a function of the
  // shell Agent Flow was started from.
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_DATE',
] as const;

/**
 * Environment overrides for one invocation.
 *
 * Only additions live here; the removals are {@link GIT_HOSTILE_ENVIRONMENT},
 * applied through `unsetEnv` because there is no value that reads as "unset"
 * for the variables that matter (probed: `GIT_DIR=` fails with
 * `not a git repository: ''`).
 *
 * `GIT_TERMINAL_PROMPT=0` so a repository with a credential-requiring remote
 * cannot turn an orchestrated command into a process waiting on a terminal
 * nobody is watching.
 *
 * The dates are set here and removed by {@link GIT_HOSTILE_ENVIRONMENT}, in that
 * order — `unsetEnv` is applied before `env`, so a caller that supplies dates
 * gets them and one that does not gets neither theirs nor the shell's.
 */
function environmentFor(dates: GitDates | undefined): Record<string, string> {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
  };

  if (dates !== undefined) {
    env['GIT_AUTHOR_DATE'] = dates.author;
    env['GIT_COMMITTER_DATE'] = dates.committer;
  }

  return env;
}

export interface CreateGitCommandDeps {
  readonly processRunner: ProcessRunner;
  readonly fs: FileSystem;
  /** From the `Host` port. Never `process.env.HOME` (§7.1). */
  readonly homeDir: string;
}

/**
 * Builds a `GitCommand` with its hooks directory provisioned.
 *
 * Async because the directory has to exist before it can be canonicalised, and
 * canonical is what the containment checks in `GitWorkspaces` compare against.
 * `mkdirp` is idempotent, so calling this per command is cheap and correct.
 */
export async function createGitCommand(deps: CreateGitCommandDeps): Promise<GitCommand> {
  const home = await provisionGitHome(deps.fs, deps.homeDir);
  return new GitCommand({ processRunner: deps.processRunner, noHooksDir: home.noHooks });
}
