import {
  PlanSchema,
  type ArtifactContentView,
  type ArtifactView,
  type Plan,
  type RunDetailView,
  type RunSummaryView,
  type RunState,
  type StageViewResponse,
  type Task,
  type TaskDetailView,
  type TaskSummaryView,
} from '../contracts/index.js';
import { StateStore } from '../app/state-store.js';
import { runPaths, type ArtifactName } from '../app/paths.js';
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
}

export class RunReader {
  constructor(private readonly options: RunReaderOptions) {}

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

    const summary = await this.summarise(project, state);
    const progress =
      summary.taskCount === 0
        ? 0
        : Math.round((summary.completedTasks / summary.taskCount) * 100);

    return {
      ...summary,
      ...(state.approvedAt === undefined ? {} : { approvedAt: state.approvedAt }),
      ...(state.approvedPlanHash === undefined
        ? {}
        : { approvedPlanHash: state.approvedPlanHash }),
      degradationDetail: state.degradations,
      progress,
      startedAt: state.createdAt,
      durationMs: Math.max(0, Date.parse(state.updatedAt) - Date.parse(state.createdAt)),
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

    for (const id of ids) {
      const task = planned.get(id);
      const progress = state.tasks.find((entry) => entry.id === id);
      const result = await store.readTaskResult(runId, id);

      views.push({
        id,
        title: task?.title ?? id,
        complexity: task?.complexity ?? 'normal',
        risk: task?.risk ?? 'low',
        state: progress?.state ?? 'queued',
        attempts: progress?.attempts ?? 0,
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
      });
    }

    return views;
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

    return {
      projectId: project.id,
      runId: state.runId,
      feature: state.feature,
      stage: state.stage,
      status: state.status,
      approved: state.approved,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      taskCount: plan?.tasks.length ?? state.tasks.length,
      completedTasks: state.tasks.filter((task) => task.state === 'completed').length,
      degradations: state.degradations.length,
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

  private async readTaskLog(
    project: RegisteredProject,
    runId: string,
    taskId: string,
  ): Promise<string[]> {
    const path = runPaths(project.path, runId).log(`implementation-${taskId}`);
    if (!(await this.options.fs.exists(path))) return [];

    return stripAnsi(await this.options.fs.readFile(path))
      .split('\n')
      .filter((line) => line.length > 0);
  }
}
