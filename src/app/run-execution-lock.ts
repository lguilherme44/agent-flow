import { z } from 'zod';
import { runPaths } from './paths.js';
import type { Clock, FileSystem, Host } from '../ports/index.js';

/**
 * Mutual exclusion for executing one run, across processes (AF-L01).
 *
 * The risk this closes: `agent-flow run` in a terminal and `POST /runs/:id/start`
 * in the local server are two processes, and until now nothing stopped them from
 * scheduling the same run at the same moment. Both would move the same task to
 * `running`, spawn the same agent, pay for it twice, and write over each other's
 * result files. The in-process guard in the server covered a double-clicked button
 * and nothing else.
 *
 * **Acquisition is one syscall.** `exists()` then `write()` is not a lock: two
 * processes both see the file absent and both write it. So the whole mechanism rests
 * on `createExclusive`, which is `open(path, 'wx')` — the kernel either creates the
 * file for this caller or fails because someone else already had it. There is no
 * window between the check and the write because there is no check.
 *
 * **Nothing is ever deleted while processes are contending, and that is the whole
 * design.** The first version of this file had a single `execution.lock` and reclaimed
 * a stale one by renaming it aside and then creating its own. Eight real processes
 * racing for one abandoned lock caught it in two runs out of five: a process that
 * judged the lock stale at T renamed whatever was at that path at T+δ, which by then
 * could be a *live* lock somebody else had just published in the gap the rename
 * itself created. Two holders, both convinced.
 *
 * Every repair for that is a conditional delete — "remove this file only if it is
 * still the one I judged" — and POSIX has no such call. So the lock stopped needing
 * one. Acquisition claims a *generation*: `execution.lock.1`, `.2`, `.3`. The current
 * holder is whoever owns the highest-numbered file, claiming is a single exclusive
 * create, and creating the file *is* publishing — there is no moment between winning
 * and being visible. A stale holder is superseded rather than removed, so contention
 * never involves destroying anything a live process might be relying on.
 *
 * Two consequences worth stating. A claimant confirms its generation is still the
 * highest before it returns a lease, so a process that wins a low generation late
 * discovers it lost and refuses rather than running. And the files below a verified
 * highest generation are tidied on the way in, which is safe precisely because their
 * owners are by definition not the holder — a straggler that recreates one is caught
 * by its own verification.
 *
 * **There is no heartbeat, deliberately.** A lock is stale when the process that
 * wrote it no longer exists, and a pid is a liveness signal that needs no
 * maintenance: nothing has to be refreshed, so nothing can fail to be refreshed. A
 * timer-based lease would add a second way to be wrong — a slow run whose heartbeat
 * missed its window would have its lock stolen while it was still executing, which
 * is the exact failure this file exists to prevent. Process death by any means,
 * including Ctrl-C and SIGKILL, is covered by liveness rather than by cleanup.
 *
 * The residual risk of pid liveness is reuse: a dead holder's number could be handed
 * to an unrelated process, and the lock would look held. That errs toward refusing a
 * legitimate run rather than toward running two, which is the direction to err in.
 *
 * **This is coordination, not workflow state.** Nothing here writes to `state.json`
 * and there is no `state.locked` — the StateStore remains the source of truth for
 * what a run *is*, and the lock only says who is allowed to move it right now. The
 * two are separable on purpose: deleting every lock file on this machine loses no
 * information about any run.
 */

/** Bumped if the file's shape ever changes, so an old lock is legible rather than fatal. */
export const LOCK_VERSION = 1;

export const LOCK_OWNERS = ['cli', 'server'] as const;
export type LockOwner = (typeof LOCK_OWNERS)[number];

/** What is being done under the lock. Diagnostic, and shown to whoever is refused. */
export const LOCK_OPERATIONS = ['run', 'revise', 'retry'] as const;
export type LockOperation = (typeof LOCK_OPERATIONS)[number];

/**
 * The lock file's contents.
 *
 * Every field is here to answer "who has this and can I do anything about it". None
 * of them is a secret: a pid, a hostname and two enums. No path, no command, no
 * environment — a lock file is read by whoever is refused, and it should carry
 * nothing that a diagnostic message could not print.
 */
export const ExecutionLockSchema = z.object({
  version: z.number().int().positive(),
  /**
   * Which claim this is. The holder is whoever owns the highest one present.
   *
   * Monotonic within a run's directory, and the reason no file has to be deleted
   * during contention: a stale holder is superseded by a higher number rather than
   * removed, so nothing destructive happens while anybody might still be relying on
   * what is there.
   */
  generation: z.number().int().positive(),
  runId: z.string().min(1),
  pid: z.number().int().positive(),
  hostname: z.string().min(1),
  owner: z.enum(LOCK_OWNERS),
  operation: z.enum(LOCK_OPERATIONS),
  createdAt: z.string().min(1),
});
export type ExecutionLock = z.infer<typeof ExecutionLockSchema>;

/** Why a lock could not be taken, with enough to diagnose it and no more. */
export interface LockRefusal {
  readonly runId: string;
  /** Absent when the file existed but could not be parsed. */
  readonly holder?: ExecutionLock;
  /**
   * Whether the holder is on this machine.
   *
   * False means no local judgement was attempted. Agent Flow is local-first and
   * this is not a distributed lock — a lock written by another host is treated as
   * held until somebody removes it deliberately, because guessing is the one option
   * that can double-execute a run.
   */
  readonly sameHost: boolean;
  /** Present only when the holder is on this machine, where the answer is knowable. */
  readonly holderAlive?: boolean;
}

export interface Lease {
  readonly lock: ExecutionLock;
  /** True when this acquisition took over a lock whose process had died. */
  readonly recoveredStale?: ExecutionLock;
  release(): Promise<void>;
}

export type AcquireResult =
  | { readonly ok: true; readonly lease: Lease }
  | { readonly ok: false; readonly refusal: LockRefusal };

export interface RunExecutionLockOptions {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly host: Host;
  readonly projectDir: string;
}

/**
 * How many rounds acquisition will make before giving up.
 *
 * A round ends early only because somebody else claimed the generation we wanted, or
 * because we won one that had already been superseded. Both are real answers rather
 * than transient failures, so a couple of rounds is enough — looping while another
 * process works would be worse than saying so.
 */
const MAX_ATTEMPTS = 4;

/** `execution.lock.7` — the generation is in the name so a scan can order them. */
const GENERATION_FILE = /^execution\.lock\.(\d+)$/;

export class RunExecutionLock {
  constructor(private readonly options: RunExecutionLockOptions) {}

  private dirOf(runId: string): string {
    return runPaths(this.options.projectDir, runId).dir;
  }

  private pathOf(runId: string, generation: number): string {
    return `${this.dirOf(runId)}/execution.lock.${String(generation)}`;
  }

  /**
   * Takes the lock for a run, or explains who has it.
   *
   * Every step is load-bearing:
   *
   *   1. Scan for generations. The highest one present is the holder.
   *   2. Read it. Unparseable is treated as held — something wrote it, and inventing
   *      a reason to override it would be the one move that can double-execute a run.
   *   3. Foreign hostname — refuse. No local pid means anything about another machine.
   *   4. Alive — refuse, and say who.
   *   5. Dead, or nothing there — claim the next generation with a single exclusive
   *      create. Winning *is* publishing; there is no gap between the two.
   *   6. Confirm nothing higher appeared. A claim that lost while we were writing it
   *      is given up here, before any work begins, rather than becoming a second
   *      holder.
   */
  async acquire(request: {
    runId: string;
    owner: LockOwner;
    operation: LockOperation;
  }): Promise<AcquireResult> {
    let lastRefusal: LockRefusal | undefined;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const generations = await this.generations(request.runId);
      const highest = generations.at(-1);

      let superseded: ExecutionLock | undefined;

      if (highest !== undefined) {
        const holder = await this.read(request.runId, highest);

        if (holder === null) {
          // Present and unreadable, or half-written. Either way it is not ours to
          // override — and a partial write becomes readable in a moment, so going
          // round is the safe response.
          lastRefusal = { runId: request.runId, sameHost: false };
          continue;
        }

        if (holder.hostname !== this.options.host.hostname) {
          return { ok: false, refusal: { runId: request.runId, holder, sameHost: false } };
        }

        if (this.options.host.isAlive(holder.pid)) {
          return {
            ok: false,
            refusal: { runId: request.runId, holder, sameHost: true, holderAlive: true },
          };
        }

        superseded = holder;
      }

      const generation = (highest ?? 0) + 1;
      const mine: ExecutionLock = {
        version: LOCK_VERSION,
        generation,
        runId: request.runId,
        pid: this.options.host.pid,
        hostname: this.options.host.hostname,
        owner: request.owner,
        operation: request.operation,
        createdAt: this.options.clock.now(),
      };

      const claimed = await this.options.fs.createExclusive(
        this.pathOf(request.runId, generation),
        `${JSON.stringify(mine, null, 2)}\n`,
      );

      // Somebody else took this generation. They are now the holder, or they will be
      // refused in their own turn; either way the next round reads the truth.
      if (!claimed) continue;

      // Published. Now make sure we are still the top: a process that computed this
      // generation earlier and got here late must discover it lost *before* it starts
      // working, not after.
      const confirmed = await this.generations(request.runId);
      if (confirmed.at(-1) !== generation) {
        await this.options.fs.remove(this.pathOf(request.runId, generation));
        continue;
      }

      // Safe to tidy: every file below a generation we have just confirmed is the
      // highest belongs to somebody who is, by definition, not the holder. A straggler
      // that recreates one is caught by the confirmation above, in its own attempt.
      for (const stale of confirmed.filter((entry) => entry < generation)) {
        await this.options.fs.remove(this.pathOf(request.runId, stale));
      }

      return {
        ok: true,
        lease: {
          lock: mine,
          ...(superseded === undefined ? {} : { recoveredStale: superseded }),
          release: async () => {
            await this.options.fs.remove(this.pathOf(request.runId, generation));
          },
        },
      };
    }

    return {
      ok: false,
      refusal: lastRefusal ?? (await this.describe(request.runId)) ?? {
        runId: request.runId,
        sameHost: true,
      },
    };
  }

  /**
   * Who holds the lock, without trying to take it. The server's pre-flight answer.
   *
   * A dead holder is reported as free, because the next acquisition will supersede it
   * and a caller told "busy" here would refuse for no reason.
   */
  async describe(runId: string): Promise<LockRefusal | undefined> {
    const highest = (await this.generations(runId)).at(-1);
    if (highest === undefined) return undefined;

    const holder = await this.read(runId, highest);
    if (holder === null) return { runId, sameHost: false };

    if (holder.hostname !== this.options.host.hostname) {
      return { runId, holder, sameHost: false };
    }

    return this.options.host.isAlive(holder.pid)
      ? { runId, holder, sameHost: true, holderAlive: true }
      : undefined;
  }

  /** Generations present, ascending. */
  private async generations(runId: string): Promise<number[]> {
    const entries = await this.options.fs.readDir(this.dirOf(runId));

    return entries
      .map((entry) => GENERATION_FILE.exec(entry)?.[1])
      .filter((match): match is string => match !== undefined)
      .map((match) => Number.parseInt(match, 10))
      .filter((value) => Number.isSafeInteger(value) && value > 0)
      .sort((a, b) => a - b);
  }

  private async read(runId: string, generation: number): Promise<ExecutionLock | null> {
    const path = this.pathOf(runId, generation);
    if (!(await this.options.fs.exists(path))) return null;

    try {
      const parsed = ExecutionLockSchema.safeParse(
        JSON.parse(await this.options.fs.readFile(path)),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
