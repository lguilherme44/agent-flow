import { readFileSync, writeFileSync } from 'node:fs';
import { runPaths } from '../../src/app/paths.js';
import { WorktreeRecovery } from '../../src/app/worktree-recovery.js';
import type { TaskState } from '../../src/contracts/index.js';
import type { WorktreeRun } from './worktree-run.js';

/**
 * The tools for testing a crash, without a production hook to crash on.
 *
 * §26.5 asks for "a deterministic injected fault hook in the test build, not a
 * sleep", and the hook is the one the architecture already provides: every
 * collaborator arrives as an injected port, so wrapping one in a `Proxy` puts a
 * fault at an exact call with nothing added to `src/`. A production flag that
 * only tests set would be a branch shipped to users so that a test could be
 * written, and the first time it was read by mistake it would be a crash nobody
 * asked for.
 */

/**
 * The real collaborator with some methods replaced.
 *
 * A spread would not do: these are class instances, and `{ ...instance }` copies
 * own properties and leaves every prototype method behind — a fake that silently
 * loses `revParse` proves nothing about the code that calls it.
 */
export function delegating<T extends object>(
  target: T,
  overrides: Partial<Record<keyof T, unknown>>,
): T {
  return new Proxy(target, {
    get(subject, property, receiver) {
      if (property in overrides) return overrides[property as keyof T];
      const value = Reflect.get(subject, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(subject) : value;
    },
  });
}

/** What a killed process leaves: the error is distinctive so a test can catch it. */
export class CrashInjected extends Error {
  constructor(readonly at: string) {
    super(`the process was killed after ${at}`);
    this.name = 'CrashInjected';
  }
}

/**
 * Runs the real method and then throws, so the durable effect lands and nothing
 * after it does.
 *
 * This is the shape a crash actually has, and it is the one a test must produce:
 * the interesting windows are all "the world changed and the record of it did
 * not". A fake that threw *instead of* acting would be testing a failure, not a
 * crash.
 */
export function killAfter<T extends object, K extends keyof T>(
  target: T,
  method: K,
  label: string,
): T {
  const real = target[method] as unknown as (...args: unknown[]) => Promise<unknown>;
  return delegating(target, {
    [method]: async (...args: unknown[]) => {
      // Awaited, and its answer discarded: the point is that the durable effect
      // lands and nothing downstream of it runs.
      await real.call(target, ...args);
      throw new CrashInjected(label);
    },
  } as Partial<Record<keyof T, unknown>>);
}

/** Runs nothing and throws, for the window *before* an operation lands. */
export function killBefore<T extends object, K extends keyof T>(
  target: T,
  method: K,
  label: string,
): T {
  return delegating(target, {
    [method]: async () => {
      throw new CrashInjected(label);
    },
  } as Partial<Record<keyof T, unknown>>);
}

/**
 * Rewrites `state.json` directly, bypassing `updateRun`.
 *
 * Deliberate, and the reason is the §22 machine: `completed → running` is a
 * transition the store refuses, which is exactly why the windows this produces
 * are *crashes* rather than states a caller can reach. Writing the file is the
 * only honest way to stand where a dead process stood.
 */
export function forceState(
  run: WorktreeRun,
  tasks: readonly { id: string; state: TaskState; attempts: number }[],
  patch: Readonly<Record<string, unknown>> = {},
): void {
  const path = runPaths(run.repo.dir, run.runId).state;
  const current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, `${JSON.stringify({ ...current, ...patch, tasks }, null, 2)}\n`);
}

/** A real `WorktreeRecovery` over the run's real Integrator and real Git. */
export function recoveryFor(
  run: WorktreeRun,
  overrides: {
    readonly workspaces?: WorktreeRun['repo']['workspaces'];
    readonly integrator?: WorktreeRun['integrator'];
  } = {},
): WorktreeRecovery {
  return new WorktreeRecovery({
    workspaces: overrides.workspaces ?? run.repo.workspaces,
    fs: run.fs,
    host: run.host,
    projectDir: run.repo.dir,
    store: run.store,
    clock: run.clock,
    integrator: overrides.integrator ?? run.integrator,
  });
}
