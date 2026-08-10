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

  async createRun(feature: string): Promise<RunState> {
    const runId = await this.nextRunId();
    const paths = runPaths(this.projectDir, runId);
    const now = this.clock.now();

    await this.fs.mkdirp(paths.dir);
    await this.fs.mkdirp(paths.reviewsDir);
    await this.fs.mkdirp(paths.tasksDir);
    await this.fs.mkdirp(paths.logsDir);

    const state = RunStateSchema.parse({
      runId,
      feature,
      stage: 'discovery',
      status: 'running',
      createdAt: now,
      updatedAt: now,
    });

    await this.write(state);
    await this.setCurrentRun(runId);
    await this.appendEvent(runId, 'run_created', { feature });

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
   */
  async updateRun(
    runId: string,
    mutate: (state: RunState) => RunState,
  ): Promise<RunState> {
    const current = await this.loadRun(runId);
    const next = RunStateSchema.parse({ ...mutate(current), updatedAt: this.clock.now() });

    // Raises before the write, so a refused transition leaves the run exactly
    // as it was rather than half-applied.
    assertLegalTransitions(current, next);

    await this.write(next);
    return next;
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
