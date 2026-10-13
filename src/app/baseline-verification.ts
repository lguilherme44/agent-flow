import { z } from 'zod';
import type { CommandResult } from '../contracts/index.js';
import type { FileSystem } from '../ports/file-system.js';
import type { ProcessRunner } from '../ports/process-runner.js';
import { runCommands, type VerificationStep } from './verification-commands.js';

/**
 * "No regression against the base" instead of "zero errors" (dogfood 09/10).
 *
 * Run 75716 stayed NOT DONE for good: lint failed on errors the base branch already had —
 * in the repository root and in old lines of the files the run touched — and nothing the run
 * could do would ever make it pass. The operator's workaround was a script comparing error
 * counts with the merge-base; this is the generic half of it, by exit code.
 *
 * **What the base says, for a step the project listed in `verification.baseline` and that
 * failed on the head.** The same command, on the run's base, in a disposable checkout that
 * went through the same preparation every worktree does (assert clean → install → assert
 * clean). Failing there too: `pre_existing`. Passing there: `regression`. Anything that kept
 * the question from being answered — no base, a checkout or an install that failed — is
 * `not_run`, and a step whose base could not be asked keeps the zero-errors rule: an
 * environment problem is never read as permission.
 *
 * **Asked once per run and base.** The base does not move under a run, so the answer is
 * written to `runs/<id>/baseline.json` keyed by base and command line, and every later review
 * reads it. The checkout and its install are the expensive part, and a second review of the
 * same run pays for neither.
 */

export type BaselineVerdict =
  | { readonly verdict: 'pre_existing' | 'regression'; readonly base: string; readonly exitCode: number }
  | { readonly verdict: 'not_run'; readonly base: string; readonly reason: string };

const CacheSchema = z.object({
  entries: z.array(
    z.object({
      base: z.string(),
      command: z.string(),
      exitCode: z.number().int(),
    }),
  ),
});
type Cache = z.infer<typeof CacheSchema>;

/**
 * The checkout and its preparation arrive as functions, because each has one owner: a
 * throwaway checkout is `read-only-workspace.ts`'s to cut and to force away, and the install
 * runs only from the modules allowed to read it out of configuration (architecture.test).
 */
export interface BaselineDeps {
  readonly fs: FileSystem;
  readonly processRunner: ProcessRunner;
  /** A clean checkout of `commit`, and the promise to take it away. */
  readonly openCheckout: (
    commit: string,
  ) => Promise<
    | {
        readonly ok: true;
        readonly cwd: string;
        readonly release: () => Promise<{ readonly removed: boolean; readonly detail?: string } | void>;
      }
    | { readonly ok: false; readonly detail: string }
  >;
  /** The checkout could not be taken away; the caller records it, as a read-only twin's is. */
  readonly onRetained?: (detail: string) => void | Promise<void>;
  /** The checkout's preparation: assert clean, install, assert clean. */
  readonly prepare: (cwd: string) => Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }>;
}

export interface BaselineRequest {
  /** The run's base commit. Empty means none was recorded: nothing can be asked. */
  readonly base: string;
  /** The failing steps the project listed, each with the command line it ran. */
  readonly steps: readonly { readonly step: VerificationStep; readonly command: string }[];
  readonly timeoutSeconds: number;
  /** The project's `commandShell`, so the base runs each line in the shell the head did. */
  readonly commandShell?: string;
  /** `runs/<id>/baseline.json`. */
  readonly cachePath: string;
}

/** Exit codes `runCommands` gives a command that timed out (124) or never started (127). */
const ENVIRONMENT_EXITS: ReadonlySet<number> = new Set([124, 127]);

export async function judgeAgainstBase(
  deps: BaselineDeps,
  request: BaselineRequest,
): Promise<Map<VerificationStep, BaselineVerdict>> {
  const verdicts = new Map<VerificationStep, BaselineVerdict>();
  const base = request.base.trim();
  if (request.steps.length === 0) return verdicts;
  if (base === '') {
    for (const { step } of request.steps) {
      verdicts.set(step, { verdict: 'not_run', base, reason: 'the run recorded no base commit' });
    }
    return verdicts;
  }

  const cache = await readCache(deps.fs, request.cachePath);
  const known = (command: string) =>
    cache.entries.find((entry) => entry.base === base && entry.command === command);

  const missing = request.steps.filter(({ command }) => known(command) === undefined);
  if (missing.length > 0) {
    const asked = await askTheBase(deps, base, missing.map(({ command }) => command), request.timeoutSeconds, request.commandShell);
    if (!asked.ok) {
      for (const { step } of missing) verdicts.set(step, { verdict: 'not_run', base, reason: asked.reason });
    } else {
      let learned = false;
      for (const result of asked.results) {
        // A timeout (124) or a command that could not start (127) is the environment
        // answering, not the base: never permission, and never kept for the rest of the run.
        if (ENVIRONMENT_EXITS.has(result.exitCode)) {
          const step = missing.find(({ command }) => command === result.command)?.step;
          if (step !== undefined) {
            verdicts.set(step, {
              verdict: 'not_run',
              base,
              reason: `the command ${result.exitCode === 124 ? 'timed out' : 'could not start'} on the base (exit ${String(result.exitCode)})`,
            });
          }
          continue;
        }
        cache.entries.push({ base, command: result.command, exitCode: result.exitCode });
        learned = true;
      }
      if (learned) await deps.fs.writeFileAtomic(request.cachePath, `${JSON.stringify(cache, null, 2)}\n`);
    }
  }

  for (const { step, command } of request.steps) {
    if (verdicts.has(step)) continue;
    const entry = known(command);
    if (entry === undefined) continue;
    verdicts.set(step, {
      verdict: entry.exitCode === 0 ? 'regression' : 'pre_existing',
      base,
      exitCode: entry.exitCode,
    });
  }
  return verdicts;
}

async function readCache(fs: FileSystem, path: string): Promise<Cache> {
  if (!(await fs.exists(path))) return { entries: [] };
  try {
    const parsed = CacheSchema.safeParse(JSON.parse(await fs.readFile(path)));
    // A cache that will not parse is a cache that is not there: the base is asked again.
    return parsed.success ? parsed.data : { entries: [] };
  } catch {
    return { entries: [] };
  }
}

/** The base, checked out, prepared, asked, and taken away — whatever happened in between. */
async function askTheBase(
  deps: BaselineDeps,
  base: string,
  commands: readonly string[],
  timeoutSeconds: number,
  commandShell: string | undefined,
): Promise<{ readonly ok: true; readonly results: readonly CommandResult[] } | { readonly ok: false; readonly reason: string }> {
  const checkout = await deps.openCheckout(base);
  if (!checkout.ok) return { ok: false, reason: `the base could not be checked out: ${checkout.detail}` };

  try {
    const prepared = await deps.prepare(checkout.cwd);
    if (!prepared.ok) return { ok: false, reason: `the base checkout could not be prepared: ${prepared.detail}` };

    const ran = await runCommands({
      processRunner: deps.processRunner,
      commands,
      cwd: checkout.cwd,
      timeoutSeconds,
      ...(commandShell === undefined ? {} : { commandShell }),
    });
    return { ok: true, results: ran.results };
  } finally {
    // Never evidence, and a command that wrote into it must not keep it on disk — and when it
    // stays anyway (a Windows EBUSY), the run says so rather than leaking in silence.
    const released = await checkout.release();
    if (released !== undefined && !released.removed) {
      await deps.onRetained?.(released.detail ?? 'the base checkout could not be removed');
    }
  }
}

/** The step's line for a prompt or a terminal, when the base answered it. */
export function describeBaseline(verdict: BaselineVerdict): string {
  const short = verdict.base.slice(0, 7);
  switch (verdict.verdict) {
    case 'pre_existing':
      return `fails on the base ${short} too (exit ${String(verdict.exitCode)}): pre-existing, not counted`;
    case 'regression':
      return `passes on the base ${short}: this run broke it`;
    case 'not_run':
      return `could not be compared with the base: ${verdict.reason}`;
  }
}
