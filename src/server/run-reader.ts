import {
  PlanSchema,
  type ArtifactContentView,
  type ArtifactView,
  type Plan,
  type RunDagView,
  type RunDetailView,
  type RunRefView,
  type RunStatus,
  type RunSummaryView,
  type RunState,
  type StageViewResponse,
  type Task,
  type TaskDetailView,
  type TaskState,
  type TaskSummaryView,
} from '../contracts/index.js';
import type { IsolationDetailView, IntegrationConflictView } from '../contracts/index.js';
import { StateStore } from '../app/state-store.js';
import { loadConfig } from '../config/loader.js';
import { resolveTaskConcurrency } from '../core/concurrency.js';
import { integrationRef, MAX_SUPPORTED_ATTEMPT } from '../core/worktree-policy.js';
import { describeIsolation } from '../app/run-git-identity.js';
import { attemptLogName, runPaths, type ArtifactName } from '../app/paths.js';
import { describeRunGraph, effectiveTaskStates, type GraphTask } from '../app/run-graph.js';
import { buildStageTimeline } from '../core/stage-timeline.js';
import { stripAnsi } from './ansi.js';
import type { Clock, FileSystem } from '../ports/index.js';
import type { RegisteredProject } from './project-registry.js';

/**
 * Reads a project's runs and renders them for the browser.
 *
 * Every answer comes out of the same `StateStore` the CLI writes to. Nothing
 * here caches, recomputes or corrects anything: if the dashboard and `status`
 * ever disagreed, one of them would be a second source of truth, and this is the
 * one that would be wrong.
 *
 * Nothing here reads a credential, a runner auth file or an environment
 * variable. The only files it opens live under the project's `.agent-flow/`.
 */

/** How much artifact text the API will hand over in one response. */
export const MAX_ARTIFACT_BYTES = 512 * 1024;

/** Statuses a run does not leave on its own. What "last run" means (§81). */
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  'completed',
  'failed',
  'plan_rejected',
]);

const ARTIFACT_LABELS: Record<ArtifactName, string> = {
  request: 'Request',
  architectureImpact: 'Architecture Impact',
  sdd: 'SDD',
  plan: 'Plan',
  planReview: 'Plan Review',
  verification: 'Verification',
  finalReview: 'Final Review',
};

const ARTIFACT_ORDER: ArtifactName[] = [
  'sdd',
  'plan',
  'architectureImpact',
  'planReview',
  'verification',
  'finalReview',
  'request',
];

export interface RunReaderOptions {
  readonly fs: FileSystem;
  readonly clock: Clock;
  /**
   * Where the global configuration lives, for the one number §21.2 needs from it:
   * `parallelism.maxTasks`.
   *
   * Optional so every caller predating M2-10 keeps working. Without it the run's
   * mode and its integration branch are still reported — those come from the run —
   * and the requested concurrency is read as 1, which is the honest answer when the
   * configuration cannot be located rather than a guess about what it says.
   */
  readonly globalConfigPath?: string;
}

export class RunReader {
  constructor(private readonly options: RunReaderOptions) {}

  /**
   * The project's effective configuration, or `undefined` when it cannot be read.
   *
   * A read model that cannot resolve a fact **omits it rather than inventing one**
   * (§21.2 failure semantics), so a project whose configuration will not load still
   * renders its runs — it just does not claim to know what parallelism was asked for.
   */
  private async configOf(project: RegisteredProject) {
    const globalConfigPath = this.options.globalConfigPath;
    if (globalConfigPath === undefined) return undefined;

    try {
      return await loadConfig({
        fs: this.options.fs,
        globalConfigPath,
        projectDir: project.path,
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Whether this attempt is validated and still unmerged (§21.2).
   *
   * Read from the attempt artifact rather than guessed from the task's state,
   * because that is the only place the answer exists: `validationJudgement ===
   * 'satisfied'` with no `result.json` yet means the marker is built and the merge
   * has not happened. **This is a projection and never a decision** — the Integrator
   * asks Git, and this only renders what the artifact already claims (I-5).
   */
  private async awaitingIntegration(
    project: RegisteredProject,
    runId: string,
    taskId: string,
    attempt: number,
  ): Promise<boolean> {
    if (attempt < 1) return false;

    const paths = runPaths(project.path, runId);
    if (await this.options.fs.exists(paths.taskResult(taskId))) return false;

    const path = paths.taskAttempt(taskId, attempt);
    if (!(await this.options.fs.exists(path))) return false;

    try {
      const raw = JSON.parse(await this.options.fs.readFile(path)) as {
        validationJudgement?: unknown;
      };
      return raw.validationJudgement === 'satisfied';
    } catch {
      // An artifact that will not parse is not evidence of anything (§17.1), so the
      // fact is omitted rather than invented.
      return false;
    }
  }

  private storeFor(project: RegisteredProject): StateStore {
    return new StateStore({
      fs: this.options.fs,
      clock: this.options.clock,
      projectDir: project.path,
    });
  }

  async listRuns(project: RegisteredProject): Promise<RunSummaryView[]> {
    const store = this.storeFor(project);
    const ids = await store.listRunIds();

    const summaries: RunSummaryView[] = [];
    for (const runId of ids) {
      // A run directory that will not parse is skipped rather than fatal: one
      // corrupt run must not take the whole list down with it.
      try {
        const state = await store.loadRun(runId);
        summaries.push(await this.summarise(project, state));
      } catch {
        continue;
      }
    }

    return summaries;
  }

  async runDetail(
    project: RegisteredProject,
    runId: string,
  ): Promise<RunDetailView | null> {
    const state = await this.loadState(project, runId);
    if (state === null) return null;

    return {
      ...(await this.summarise(project, state)),
      ...(state.approvedAt === undefined ? {} : { approvedAt: state.approvedAt }),
      ...(state.approvedPlanHash === undefined
        ? {}
        : { approvedPlanHash: state.approvedPlanHash }),
      degradationDetail: state.degradations,
      startedAt: state.createdAt,
      isolation: await this.isolationOf(project, state),
      integrationConflicts: await this.conflictsOf(project, state.runId),
    };
  }

  /**
   * What an isolated run is doing, for somebody who has to debug it (§21.2, M2-10).
   *
   * **Every value is resolved from run state or derived from it — nothing here
   * takes an identifier from a caller** (I-8). The branch name in particular is a
   * pure function of `gitRunKey` (§5.3): persisting it as well would be a second
   * copy of one fact that a bug could make disagree with the first.
   *
   * The configuration is read for `parallelism.maxTasks` and for nothing else. It
   * is emphatically **not** asked whether this run is isolated: that was captured
   * at creation and is immutable (I-13), and asking again is the defect §6.2 exists
   * to describe.
   */
  private async isolationOf(
    project: RegisteredProject,
    state: RunState,
  ): Promise<IsolationDetailView> {
    const config = await this.configOf(project);
    const requested = config?.global.parallelism.maxTasks ?? 1;
    // **The resolver, called exactly as the scheduler calls it — with the run's own
    // mode** (M2-11, §4.4).
    //
    // Until M2-11 this deliberately passed one argument, because the scheduler did:
    // a page reading `effective: 4` beside a run executing one task at a time
    // would have been describing a run that does not exist. The two moved together,
    // in one commit, for exactly that reason — and an architecture test now holds
    // them together, so a future edit cannot teach one of them about isolation
    // without the other.
    //
    // The mode is `state.isolationMode`, read from the run. Not the configuration
    // (I-13): a run created sequential reports one however `git.useWorktrees` reads
    // now, which is the question §6.4 exists to answer out loud.
    const decision = resolveTaskConcurrency(requested, state.isolationMode ?? 'none');

    const branch =
      state.gitRunKey === undefined ? undefined : integrationRef(state.gitRunKey);

    return {
      // `legacy` is the absent case, projected. A run that predates the question
      // did not answer `none` to it (§25.2).
      mode: state.isolationMode ?? 'legacy',
      parallelism: {
        requested: decision.requested,
        effective: decision.effective,
        clamped: decision.clamped,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      },
      ...(branch?.ok === true ? { integrationBranch: branch.value } : {}),
      ...(state.integrationHead === undefined ? {} : { integrationHead: state.integrationHead }),
      ...(state.planningBase === undefined ? {} : { planningBase: state.planningBase }),
      // I-3 as a number: in worktree mode `completed` means integrated, so this is
      // how many tasks have their work on the branch rather than how many agents
      // finished.
      tasksIntegrated: state.tasks.filter((task) => task.state === 'completed').length,
      ...(config === undefined
        ? {}
        : (() => {
            const report = describeIsolation(state, config);
            return report.note === undefined ? {} : { note: report.note };
          })()),
    };
  }

  /**
   * The conflicts §15 recorded, read from the audit trail.
   *
   * **This is a projection, not a decision.** `events.jsonl` is the audit trail and
   * never a second source of truth (I-1) — reading it to *render* what happened is
   * exactly what it is for, and no scheduling or integration answer is taken from
   * it. The paths are repository-relative, which is why they may be shown at all.
   */
  private async conflictsOf(
    project: RegisteredProject,
    runId: string,
  ): Promise<IntegrationConflictView[]> {
    const store = this.storeFor(project);

    let events;
    try {
      events = await store.readEvents(runId);
    } catch {
      // A trail that will not parse omits the facts rather than inventing them, and
      // never takes the run's page down with it (§21.2 failure semantics).
      return [];
    }

    const conflicts: IntegrationConflictView[] = [];
    for (const event of events) {
      if (event.type !== 'integration_conflict') continue;
      const detail = event.detail;
      const task = typeof detail['task'] === 'string' ? detail['task'] : undefined;
      const attempt = typeof detail['attempt'] === 'number' ? detail['attempt'] : undefined;
      if (task === undefined || attempt === undefined) continue;

      const paths = Array.isArray(detail['paths'])
        ? detail['paths'].filter((path): path is string => typeof path === 'string')
        : [];
      const previously = detail['previouslyIntegrated'];

      conflicts.push({
        task,
        attempt,
        paths,
        ...(typeof previously === 'string' ? { previouslyIntegrated: previously } : {}),
      });
    }

    return conflicts;
  }

  /**
   * What the Projects page needs about one project (§81).
   *
   * Deliberately not `listRuns`: that reads every run's state and plan, and the
   * projects list would then cost O(projects × runs) before anything appears on
   * screen. Run ids sort newest-first, so this walks from the top and stops as
   * soon as it has the current run and the last finished one — usually two reads
   * regardless of how much history a project has.
   */
  async projectOverview(project: RegisteredProject): Promise<{
    currentRunId: string | null;
    status: RunStatus | null;
    lastRun?: RunRefView;
    runCount: number;
  }> {
    const store = this.storeFor(project);

    let currentRunId: string | null = null;
    try {
      currentRunId = await store.currentRunId();
    } catch {
      // A project whose pointer is unreadable is still a project.
    }

    const ids = await store.listRunIds();
    let status: RunStatus | null = null;
    let lastRun: RunRefView | undefined;

    for (const runId of ids) {
      if (status !== null && lastRun !== undefined) break;

      const state = await this.loadState(project, runId);
      if (state === null) continue;

      if (runId === currentRunId) status = state.status;
      if (lastRun === undefined && TERMINAL_STATUSES.has(state.status)) {
        lastRun = {
          runId: state.runId,
          feature: state.feature,
          status: state.status,
          stage: state.stage,
          updatedAt: state.updatedAt,
        };
      }
    }

    return {
      currentRunId,
      status,
      ...(lastRun === undefined ? {} : { lastRun }),
      runCount: ids.length,
    };
  }

  async stages(project: RegisteredProject, runId: string): Promise<StageViewResponse[] | null> {
    const state = await this.loadState(project, runId);
    if (state === null) return null;

    const events = await this.storeFor(project).readEvents(runId);
    return buildStageTimeline(events, state);
  }

  async tasks(project: RegisteredProject, runId: string): Promise<TaskSummaryView[] | null> {
    const state = await this.loadState(project, runId);
    if (state === null) return null;

    const store = this.storeFor(project);
    const plan = await this.loadPlan(store, runId);
    const planned = new Map((plan?.tasks ?? []).map((task) => [task.id, task]));

    const views: TaskSummaryView[] = [];

    // Driven by the plan, then by anything the run knows about that the plan
    // does not. A task can exist in state without being in the plan only if the
    // plan was replaced under it, which is worth seeing rather than hiding.
    const ids = [...new Set([...planned.keys(), ...state.tasks.map((task) => task.id)])];

    // `ready` and `blocked` are conditions over the graph, not records — §22 is
    // explicit that neither is persisted. Derived through the same function the
    // DAG view uses, so the table and the graph cannot describe one task two ways.
    const effective = effectiveTaskStates(graphTasks(ids, planned), storedStates(state));

    const isolated = state.isolationMode === 'worktree';

    for (const id of ids) {
      const task = planned.get(id);
      const progress = state.tasks.find((entry) => entry.id === id);
      const result = await store.readTaskResult(runId, id);

      views.push({
        id,
        title: task?.title ?? id,
        complexity: task?.complexity ?? 'normal',
        risk: task?.risk ?? 'low',
        state: effective[id] ?? progress?.state ?? 'queued',
        attempts: progress?.attempts ?? 0,
        // Provenance is pinned to the persisted `blocked` record: `effective`
        // derives blocked over the graph, and the graph cannot tell a task its
        // own agent blocked from one an upstream failure held back.
        ...(progress?.blockReason === undefined
          ? {}
          : { blockReason: progress.blockReason as 'agent' | 'dependency' }),
        requirements: [...(task?.requirements ?? [])],
        dependencies: [...(task?.dependencies ?? [])],
        ...(task?.correctiveFor === undefined
          ? {}
          : {
              correctiveFor: {
                stage: task.correctiveFor.stage,
                findingType: task.correctiveFor.findingType,
              },
            }),
        ...(result === null
          ? {}
          : {
              runner: result.runner,
              ...(result.model === undefined ? {} : { model: result.model }),
              reasoning: result.reasoning,
              durationMs: Math.max(
                0,
                Date.parse(result.finishedAt) - Date.parse(result.startedAt),
              ),
              validationPassed: result.validation.passed,
            }),
        // §21.2, derived rather than stored. A live workspace is `running` in an
        // isolated run; a boolean on disk saying one exists would be a second copy
        // of a fact the task's state already carries, and the two could disagree
        // after a crash.
        ...(isolated && progress?.state === 'running' ? { workspaceActive: true } : {}),
        // The state `TaskState` has no name for, and the one a person watching a
        // parallel run most needs: the attempt is validated and its marker is not
        // on the branch yet, so `completed` would be a lie until it is (I-3).
        ...(isolated && (await this.awaitingIntegration(project, runId, id, progress?.attempts ?? 0))
          ? { awaitingIntegration: true }
          : {}),
        // Ref names and object ids, never a path (§21.3, §26.1 rule 4).
        ...(result?.integration === undefined
          ? {}
          : {
              integration: {
                attempt: result.integration.attempt,
                branch: result.integration.branch,
                marker: result.integration.marker,
                mergeCommit: result.integration.mergeCommit,
                validatedTree: result.integration.validatedTree,
                integratedAt: result.integration.integratedAt,
              },
            }),
      });
    }

    return views;
  }

  /**
   * The plan's dependency graph (§92).
   *
   * Structure only, and derived rather than stored: the plan's `dependencies` are
   * the truth, and the ranking comes from the same `core/dag` the scheduler runs
   * on — through the application service, so this file holds no graph logic of its
   * own. A second serialisation of "what may run" is precisely what §60 forbids.
   */
  async dag(project: RegisteredProject, runId: string): Promise<RunDagView | null> {
    const state = await this.loadState(project, runId);
    if (state === null) return null;

    const plan = await this.loadPlan(this.storeFor(project), runId);
    const planned = new Map((plan?.tasks ?? []).map((task) => [task.id, task]));
    const ids = [...new Set([...planned.keys(), ...state.tasks.map((task) => task.id)])];

    const graph = describeRunGraph(graphTasks(ids, planned));

    return {
      runId,
      projectId: project.id,
      nodes: graph.nodes.map((node) => ({ taskId: node.taskId, depth: node.depth })),
      edges: graph.edges.map((edge) => ({ from: edge.from, to: edge.to })),
      unresolved: graph.unresolved.map((entry) => ({
        taskId: entry.taskId,
        dependsOn: entry.dependsOn,
      })),
      ...(graph.invalid === undefined
        ? {}
        : {
            invalid: {
              kind: graph.invalid.kind,
              message: graph.invalid.message,
              ...(graph.invalid.cycle === undefined ? {} : { cycle: [...graph.invalid.cycle] }),
            },
          }),
    };
  }

  async taskDetail(
    project: RegisteredProject,
    runId: string,
    taskId: string,
  ): Promise<TaskDetailView | null> {
    const summaries = await this.tasks(project, runId);
    if (summaries === null) return null;

    const summary = summaries.find((entry) => entry.id === taskId);
    if (summary === undefined) return null;

    const store = this.storeFor(project);
    const plan = await this.loadPlan(store, runId);
    const task: Task | undefined = plan?.tasks.find((entry) => entry.id === taskId);
    const result = await store.readTaskResult(runId, taskId);

    return {
      ...summary,
      description: task?.description ?? '',
      acceptanceCriteria: [...(task?.acceptanceCriteria ?? [])],
      validation: [...(task?.validation ?? [])],
      validationExpectation: task?.validationExpectation ?? 'pass',
      files: [...(task?.files.likely ?? [])],
      filesChanged: [...(result?.filesChanged ?? [])],
      notes: [...(result?.notes ?? [])],
      ...(result === null
        ? {}
        : {
            startedAt: result.startedAt,
            finishedAt: result.finishedAt,
            reasoningClamped: result.reasoningClamped,
            ...(result.fallback === undefined ? {} : { fallback: result.fallback }),
            ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
          }),
      commands: (result?.validation.commands ?? []).map((command) => ({
        command: command.command,
        exitCode: command.exitCode,
        durationMs: command.durationMs,
        stdout: stripAnsi(command.stdout),
        stderr: stripAnsi(command.stderr),
      })),
      log: await this.readTaskLog(project, runId, taskId),
      attemptLogs: await this.readAttemptLogs(project, runId, taskId),
    };
  }

  async artifacts(project: RegisteredProject, runId: string): Promise<ArtifactView[] | null> {
    const state = await this.loadState(project, runId);
    if (state === null) return null;

    const paths = runPaths(project.path, runId);
    const views: ArtifactView[] = [];

    for (const name of ARTIFACT_ORDER) {
      const stat = await this.options.fs.stat(paths[name]);
      views.push({
        name,
        label: ARTIFACT_LABELS[name],
        available: stat !== null && !stat.isDirectory,
        ...(stat === null
          ? {}
          : { sizeBytes: stat.size, updatedAt: new Date(stat.mtimeMs).toISOString() }),
      });
    }

    return views;
  }

  async artifactContent(
    project: RegisteredProject,
    runId: string,
    name: ArtifactName,
  ): Promise<ArtifactContentView | null> {
    const all = await this.artifacts(project, runId);
    if (all === null) return null;

    const view = all.find((entry) => entry.name === name);
    if (view === undefined || !view.available) return null;

    const raw = await this.storeFor(project).readArtifact(runId, name);
    if (raw === null) return null;

    // Bounded. An SDD is a few hundred lines, but nothing stops a run from
    // producing something enormous, and a browser tab is not a reason to read a
    // megabyte into memory and ship it.
    const truncated = Buffer.byteLength(raw, 'utf8') > MAX_ARTIFACT_BYTES;

    return {
      ...view,
      content: truncated ? raw.slice(0, MAX_ARTIFACT_BYTES) : raw,
      truncated,
    };
  }

  private async summarise(
    project: RegisteredProject,
    state: RunState,
  ): Promise<RunSummaryView> {
    const plan = await this.loadPlan(this.storeFor(project), state.runId);

    const taskCount = plan?.tasks.length ?? state.tasks.length;
    const completedTasks = state.tasks.filter((task) => task.state === 'completed').length;

    return {
      projectId: project.id,
      runId: state.runId,
      feature: state.feature,
      stage: state.stage,
      status: state.status,
      approved: state.approved,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      taskCount,
      completedTasks,
      degradations: state.degradations.length,
      progress: taskCount === 0 ? 0 : Math.round((completedTasks / taskCount) * 100),
      // Last activity minus creation. Not wall-clock elapsed: a run nobody has
      // touched since yesterday took the time it took, and reporting "18h" for
      // an abandoned run would say something about the clock, not about the run.
      durationMs: Math.max(0, Date.parse(state.updatedAt) - Date.parse(state.createdAt)),
      ...(state.workflow === undefined ? {} : { workflow: state.workflow }),
      ...(state.revisionCount === undefined ? {} : { revisionCount: state.revisionCount }),
    };
  }

  private async loadState(
    project: RegisteredProject,
    runId: string,
  ): Promise<RunState | null> {
    try {
      return await this.storeFor(project).loadRun(runId);
    } catch {
      return null;
    }
  }

  private async loadPlan(store: StateStore, runId: string): Promise<Plan | null> {
    const raw = await store.readArtifact(runId, 'plan');
    if (raw === null) return null;

    const parsed = PlanSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }

  /**
   * Every log this task left behind, per attempt (C-07).
   *
   * The defect this replaces: `paths.ts` writes `implementation-<TASK>-attempt-<n>.log` in
   * worktree mode and this reader asked for `implementation-<TASK>.log`, so every isolated
   * run returned `[]` for every task. An operator wanting to see what an attempt did
   * opened a terminal — which is the behaviour AR-02 exists to remove.
   *
   * Both spellings are read. The unsuffixed name is what a sequential run writes and has
   * always written; fixing the isolated path must not break the one that worked.
   *
   * Probed rather than counted. The attempt counter lives on run state and a *failed*
   * attempt's log exists whether or not that counter moved (AD-37 splits the two), so
   * asking the filesystem is the answer that cannot disagree with what is on disk. Bounded
   * by `MAX_SUPPORTED_ATTEMPT`, and it stops at the first gap.
   */
  private async readAttemptLogs(
    project: RegisteredProject,
    runId: string,
    taskId: string,
  ): Promise<{ attempt: number; lines: string[] }[]> {
    const paths = runPaths(project.path, runId);
    const logs: { attempt: number; lines: string[] }[] = [];

    for (let attempt = 1; attempt <= MAX_SUPPORTED_ATTEMPT; attempt += 1) {
      const path = paths.log(attemptLogName(taskId, attempt));
      if (!(await this.options.fs.exists(path))) break;
      logs.push({ attempt, lines: linesOf(await this.options.fs.readFile(path)) });
    }

    return logs;
  }

  private async readTaskLog(
    project: RegisteredProject,
    runId: string,
    taskId: string,
  ): Promise<string[]> {
    // The newest attempt, so the one flat field still answers "what happened" without a
    // caller having to know that attempts exist.
    const attempts = await this.readAttemptLogs(project, runId, taskId);
    const newest = attempts.at(-1);
    if (newest !== undefined) return newest.lines;

    const path = runPaths(project.path, runId).log(`implementation-${taskId}`);
    if (!(await this.options.fs.exists(path))) return [];

    return linesOf(await this.options.fs.readFile(path));
  }
}

function linesOf(raw: string): string[] {
  return stripAnsi(raw)
    .split('\n')
    .filter((line) => line.length > 0);
}

/**
 * The graph's view of the run's tasks: an id and what it waits for.
 *
 * A task the run knows about but the plan does not gets no dependencies — the
 * plan is where dependencies are declared, and a task that outlived its plan has
 * nowhere to declare them.
 */
function graphTasks(ids: readonly string[], planned: ReadonlyMap<string, Task>): GraphTask[] {
  return ids.map((id) => ({ id, dependencies: planned.get(id)?.dependencies ?? [] }));
}

function storedStates(state: RunState): Record<string, TaskState> {
  const states: Record<string, TaskState> = {};
  for (const task of state.tasks) states[task.id] = task.state;
  return states;
}
