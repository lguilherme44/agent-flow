import {
  RunEventSchema,
  RunStateSchema,
  TaskResultSchema,
  formatValidationError,
  type Degradation,
  type RunEvent,
  type RunState,
  type TaskResult,
} from '../contracts/index.js';
import type { Clock, FileSystem } from '../ports/index.js';
import { agentFlowPaths, artifactPath, runPaths, type ArtifactName } from './paths.js';
import { serializeStateWrite } from './state-write-queue.js';
import { transition } from '../core/task-state.js';

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateError';
  }
}

export interface StateStoreOptions {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly projectDir: string;
}

/** A degradation before it has been timestamped. */
export type DegradationInput = Omit<Degradation, 'detectedAt'>;

/**
 * Persistence for runs.
 *
 * `state.json` is the source of truth and is always written atomically — a run
 * interrupted halfway through a write must still be resumable, since closing the
 * terminal is a normal thing to do during a ten-minute stage.
 *
 * `events.jsonl` is an append-only audit trail beside it, not a second source of
 * truth. Full event sourcing would give the same auditability at a cost the MVP
 * has no use for; replaying a log to answer "what stage am I on" is work that a
 * single JSON file already does.
 */
/**
 * The three fields a run is born with and never rewrites (I-13, §6.1).
 *
 * `integrationHead` is deliberately **not** here: it is the one mutable Git fact
 * a run persists, advanced by each merge in the same write that completes a task
 * (§14.3).
 */
export const FROZEN_IDENTITY_FIELDS = ['planningBase', 'gitRunKey', 'isolationMode'] as const;

export type FrozenIdentityField = (typeof FROZEN_IDENTITY_FIELDS)[number];

/**
 * Supplies the identity fields once the run id exists.
 *
 * A function rather than a value because `gitRunKey` is derived from the run id,
 * and the id is allocated inside `createRun`. Deliberately synchronous: it
 * composes strings the application layer already decided, and a store that
 * awaited a caller here would be a store that could be made to do I/O.
 *
 * Omitting it produces a run with none of the three fields — the *legacy* shape
 * (§25.2), which is what every test that does not care about Git gets. The one
 * production caller always supplies it.
 */
export type RunIdentityFor = (runId: string) => Partial<Pick<RunState, FrozenIdentityField>>;

function frozenIdentityOf(state: RunState): Partial<Pick<RunState, FrozenIdentityField>> {
  const frozen: Record<string, unknown> = {};
  for (const field of FROZEN_IDENTITY_FIELDS) {
    if (state[field] !== undefined) frozen[field] = state[field];
  }
  return frozen as Partial<Pick<RunState, FrozenIdentityField>>;
}

/**
 * Refuses a patch that would move the run's Git identity.
 *
 * The invariant this protects is not a tidiness rule. `isolationMode` decides
 * which tree the work is built in; `planningBase` is the commit the plan was
 * written against; `gitRunKey` is the namespace the run's refs live under. A
 * write that changed any of them would make the run's own history describe
 * something that did not happen — and unlike a bad transition, nothing later
 * would notice.
 *
 * A *legacy* run gaining a field is refused by the same rule, and that is the
 * point of §25.2: there is no path from absent to `'worktree'`, and the absence
 * of the path is the guarantee rather than a check that happens to refuse.
 */
export function assertIdentityUnchanged(current: RunState, next: RunState): void {
  for (const field of FROZEN_IDENTITY_FIELDS) {
    if (current[field] === next[field]) continue;

    throw new StateError(
      `Run ${current.runId}: ${field} is captured when the run is created and cannot be changed ` +
        `(${String(current[field] ?? 'absent')} → ${String(next[field] ?? 'absent')}). ` +
        'Start a new run to execute in a different mode.',
    );
  }
}

export class StateStore {
  private readonly fs: FileSystem;
  private readonly clock: Clock;
  private readonly projectDir: string;

  constructor(options: StateStoreOptions) {
    this.fs = options.fs;
    this.clock = options.clock;
    this.projectDir = options.projectDir;
  }

  /** The current instant, from the injected clock. */
  now(): string {
    return this.clock.now();
  }

  async createRun(feature: string, identityFor?: RunIdentityFor): Promise<RunState> {
    const runId = await this.nextRunId();
    const paths = runPaths(this.projectDir, runId);
    const now = this.clock.now();

    await this.fs.mkdirp(paths.dir);
    await this.fs.mkdirp(paths.reviewsDir);
    await this.fs.mkdirp(paths.tasksDir);
    await this.fs.mkdirp(paths.logsDir);

    // Opaque, schema-validated strings decided by the application layer. This
    // store executes no Git, reads no configuration and generates no randomness
    // (I-1) — it is handed three values and writes them once, together, in the
    // same write that creates the run. `identityFor` takes the run id because
    // `gitRunKey` is derived from it and only this method knows it yet.
    const identity = identityFor?.(runId) ?? {};

    const state = RunStateSchema.parse({
      runId,
      feature,
      stage: 'discovery',
      status: 'running',
      ...identity,
      createdAt: now,
      updatedAt: now,
    });

    await this.write(state);
    await this.setCurrentRun(runId);
    await this.appendEvent(runId, 'run_created', { feature });

    // Appendix B, `at createRun`. The three frozen fields are already in
    // `state.json`, so this event adds no fact — it adds the *moment*. R-11 is a
    // failure nobody can see afterwards from state alone: a run that executed
    // under a mode it was not planned under looks, at rest, exactly like one that
    // did not. The audit trail is where "this run was born `worktree`, against
    // this base" becomes something a person can point at, and a run that never
    // said it is a run whose mode has no recorded origin.
    //
    // Emitted only for a run that has the fields. A legacy run (§25.2) and every
    // test that does not care about Git carry none of them, and an event with
    // three empty values would assert an identity that was never assigned.
    if (
      state.gitRunKey !== undefined &&
      state.planningBase !== undefined &&
      state.isolationMode !== undefined
    ) {
      await this.appendEvent(runId, 'run_git_identity_assigned', {
        gitRunKey: state.gitRunKey,
        planningBase: state.planningBase,
        isolationMode: state.isolationMode,
      });
    }

    return state;
  }

  async loadRun(runId: string): Promise<RunState> {
    const path = runPaths(this.projectDir, runId).state;
    if (!(await this.fs.exists(path))) {
      throw new StateError(`Run ${runId} not found (looked in ${path}).`);
    }

    const raw = await this.fs.readFile(path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StateError(`Run ${runId} has unreadable state: ${path} is not valid JSON.`);
    }

    const result = RunStateSchema.safeParse(parsed);
    if (!result.success) {
      throw new StateError(formatValidationError(result.error, path));
    }
    return result.data;
  }

  /**
   * Read-modify-write. The mutator is a pure function of the current state, so
   * a caller cannot accidentally persist something it did not read first.
   *
   * Also the one gate every task state change passes through, which is why the
   * §22 machine is enforced here rather than at each caller. It was enforced
   * nowhere: `core/task-state.ts` described the transitions, was fully tested,
   * and no production path called it — so the policy held only for as long as
   * every writer happened to agree with it. Checking here needs no cooperation
   * from callers and cannot be forgotten by a new one.
   *
   * **Serialised per state file, for exactly the same reason (M2-00.1).** The
   * load and the write are two steps, and two callers interleaving them lose an
   * update: both read one snapshot, both write their own conclusion, and the
   * second erases the first. The §22 guard cannot see it — `running → completed`
   * observed twice is two legal transitions and one task that never finished.
   * Only the batch size of the scheduler keeps that from happening today, which
   * makes it a fact about a caller rather than a property of this class. The
   * queue closes it here, where a new caller inherits it without knowing.
   *
   * The mutator therefore runs *inside* the queue, and it must not call back into
   * `updateRun` for the same run — see `state-write-queue.ts` on reentrancy.
   */
  async updateRun(
    runId: string,
    mutate: (state: RunState) => RunState,
  ): Promise<RunState> {
    return serializeStateWrite(runPaths(this.projectDir, runId).state, async () => {
      const current = await this.loadRun(runId);
      // Once. A callback is allowed to be expensive and is not required to be
      // free of side effects, so calling it twice to compare would be both.
      const mutated = mutate(current);

      // Raises before the write, so an attempt to move the run's Git identity
      // leaves the run exactly as it was rather than half-applied.
      assertIdentityUnchanged(current, mutated);

      const next = RunStateSchema.parse({
        ...mutated,
        // Belt and braces: even if the guard above were ever loosened, the
        // persisted identity is what gets written (I-13).
        ...frozenIdentityOf(current),
        updatedAt: this.clock.now(),
      });

      // Raises before the write, so a refused transition leaves the run exactly
      // as it was rather than half-applied. Raising in here also releases the
      // queue: a refusal blocks the next writer for no longer than a success.
      assertLegalTransitions(current, next);

      await this.write(next);
      return next;
    });
  }

  async currentRunId(): Promise<string | null> {
    const path = agentFlowPaths(this.projectDir).currentRun;
    if (!(await this.fs.exists(path))) return null;
    const value = (await this.fs.readFile(path)).trim();
    return value.length > 0 ? value : null;
  }

  async loadCurrentRun(): Promise<RunState | null> {
    const runId = await this.currentRunId();
    return runId === null ? null : this.loadRun(runId);
  }

  async setCurrentRun(runId: string): Promise<void> {
    const paths = agentFlowPaths(this.projectDir);
    await this.fs.mkdirp(paths.root);
    await this.fs.writeFileAtomic(paths.currentRun, `${runId}\n`);
  }

  /** Newest first — what `status` and `clean` both want. */
  async listRunIds(): Promise<string[]> {
    const runsDir = agentFlowPaths(this.projectDir).runsDir;
    if (!(await this.fs.exists(runsDir))) return [];
    const entries = await this.fs.readDir(runsDir);
    return entries.filter((entry) => /^AF-\d{4}-\d{3}$/.test(entry)).sort().reverse();
  }

  /**
   * Appends one line to the audit trail.
   *
   * **Deliberately not serialised, unlike `updateRun` (M2-00.1).** The two look
   * alike and are not: this reads nothing, so there is no snapshot to go stale and
   * no update to lose. What is left is whether two appends can interleave *within*
   * a line, and they cannot — the port's contract is one append of one small line,
   * which `O_APPEND` places at the end of the file in a single write.
   *
   * Serialising it anyway would buy a tidier event order and nothing else, and the
   * order it would buy is arguably the wrong one: once tasks really do run at the
   * same time, the order two of their events were written in *is* information. A
   * queue that reordered them into something neater would be the audit trail
   * describing a sequence that did not happen.
   */
  async appendEvent(
    runId: string,
    type: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    const event = RunEventSchema.parse({ at: this.clock.now(), type, detail });
    await this.fs.appendFile(runPaths(this.projectDir, runId).events, `${JSON.stringify(event)}\n`);
  }

  async readEvents(runId: string): Promise<RunEvent[]> {
    const path = runPaths(this.projectDir, runId).events;
    if (!(await this.fs.exists(path))) return [];

    const raw = await this.fs.readFile(path);
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => RunEventSchema.parse(JSON.parse(line)));
  }

  /**
   * Read-model variant of `readEvents`: one malformed legacy audit line creates
   * a visible data gap, not the loss of every otherwise valid projection.
   * Workflow authority continues to use the strict method above.
   */
  async readEventsBestEffort(runId: string): Promise<RunEvent[]> {
    const path = runPaths(this.projectDir, runId).events;
    if (!(await this.fs.exists(path))) return [];

    const events: RunEvent[] = [];
    const raw = await this.fs.readFile(path);
    for (const line of raw.split('\n')) {
      const candidate = line.trim();
      if (candidate.length === 0) continue;
      try {
        const parsed = RunEventSchema.safeParse(JSON.parse(candidate));
        if (parsed.success) events.push(parsed.data);
      } catch {
        // Invalid historical audit entries are absent from this read model only.
      }
    }
    return events;
  }

  /**
   * Records a lost capability on the run itself (R-16).
   *
   * The risk introduced by tolerating a broken runner is that DEGRADED quietly
   * becomes the normal state and nobody notices that reviews stopped being
   * cross-provider. A warning printed once scrolls away; this does not.
   *
   * Deduplicated by kind and reason, so a per-task detection does not bury the
   * state file under identical entries.
   */
  async recordDegradation(runId: string, degradation: DegradationInput): Promise<RunState> {
    const detectedAt = this.clock.now();
    const entry: Degradation = { ...degradation, detectedAt };

    const updated = await this.updateRun(runId, (state) => {
      const seen = state.degradations.some(
        (existing) => existing.kind === entry.kind && existing.reason === entry.reason,
      );
      return seen ? state : { ...state, degradations: [...state.degradations, entry] };
    });

    await this.appendEvent(runId, 'degradation_detected', {
      kind: entry.kind,
      reason: entry.reason,
      impact: entry.impact,
    });

    return updated;
  }

  /**
   * The persisted outcome of one task, or null when it has not run.
   *
   * Task results live outside `state.json` because they are large and immutable
   * once written; reading them still belongs here, so nothing else has to know
   * the layout on disk.
   */
  async readTaskResult(runId: string, taskId: string): Promise<TaskResult | null> {
    const path = runPaths(this.projectDir, runId).taskResult(taskId);
    if (!(await this.fs.exists(path))) return null;

    const result = TaskResultSchema.safeParse(JSON.parse(await this.fs.readFile(path)));
    return result.success ? result.data : null;
  }

  async writeArtifact(runId: string, artifact: ArtifactName, content: string): Promise<void> {
    const path = artifactPath(this.projectDir, runId, artifact);
    await this.fs.mkdirp(path.slice(0, path.lastIndexOf('/')));
    await this.fs.writeFileAtomic(path, content);
  }

  async readArtifact(runId: string, artifact: ArtifactName): Promise<string | null> {
    const path = artifactPath(this.projectDir, runId, artifact);
    return (await this.fs.exists(path)) ? this.fs.readFile(path) : null;
  }

  private async write(state: RunState): Promise<void> {
    const path = runPaths(this.projectDir, state.runId).state;
    await this.fs.writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
  }

  /**
   * `AF-<year>-<sequence>`, where the sequence continues from what is already on
   * disk. Derived from the directory rather than kept in a counter file: one
   * less thing that can disagree with reality.
   */
  private async nextRunId(): Promise<string> {
    const year = this.clock.now().slice(0, 4);
    const prefix = `AF-${year}-`;

    const existing = (await this.listRunIds())
      .filter((id) => id.startsWith(prefix))
      .map((id) => Number.parseInt(id.slice(prefix.length), 10))
      .filter((n) => Number.isFinite(n));

    const next = (existing.length > 0 ? Math.max(...existing) : 0) + 1;
    return `${prefix}${String(next).padStart(3, '0')}`;
  }
}

/**
 * Rejects any task whose state moved somewhere §22 does not allow.
 *
 * Tasks absent from the previous state are new and have no transition to judge;
 * tasks whose state is unchanged are not transitions at all. Everything else is
 * checked, including writes that touch several tasks at once — the scheduler
 * persists the whole map after each batch.
 */
function assertLegalTransitions(current: RunState, next: RunState): void {
  const before = new Map(current.tasks.map((task) => [task.id, task.state]));

  for (const task of next.tasks) {
    const from = before.get(task.id);
    if (from === undefined || from === task.state) continue;
    transition(from, task.state);
  }
}
