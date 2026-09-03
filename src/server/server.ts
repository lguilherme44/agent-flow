import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  AnalyticsQuerySchema,
  ApproveRequestSchema,
  ArtifactParamsSchema,
  EventsQuerySchema,
  JobParamsSchema,
  ProjectQuerySchema,
  PromptParamsSchema,
  RejectRequestSchema,
  RetryRequestSchema,
  ReviseRequestSchema,
  RunParamsSchema,
  StartRequestSchema,
  TaskParamsSchema,
  type ActionErrorView,
  type ActionJobView,
  type ActionResultView,
  type AnalyticsView,
  type ApprovalGateView,
  type ConfigView,
  type HealthResponse,
  type ProjectView,
  type PromptView,
  type RoleRouteView,
  type RunSummaryView,
  type WorkspaceView,
  type RunnerHealthView,
  type RunnerView,
  type ServerEvent,
  type TelemetryEntry,
} from '../contracts/index.js';
import { StateStore } from '../app/state-store.js';
import { PromptLoader } from '../app/prompt-loader.js';
import { describeRoleRoutes } from '../app/role-routes.js';
import { RunExecutionLock, type LockRefusal } from '../app/run-execution-lock.js';
import {
  approve,
  cancel,
  describeApprovalGate,
  pause,
  resume,
  reject,
  retryTask,
  revise,
  start,
  type ActionError,
  type ActionErrorCode,
  type RunActionDeps,
} from '../app/run-actions.js';
import { loadConfig } from '../config/loader.js';
import { buildRegistry } from '../adapters/runners/registry.js';
import { referencedRunners } from '../core/health.js';
import { capabilitiesOf } from '../core/role.js';
import { collectTelemetry } from '../app/telemetry.js';
import { summariseTelemetry } from '../core/telemetry.js';
import type { Clock, FileSystem, Host, ProcessRunner } from '../ports/index.js';
import { RunReader } from './run-reader.js';
import { CollaborationReader } from './collaboration-reader.js';
import { ControlReader } from './control-reader.js';
import { PromptReader } from './prompt-reader.js';
import { AnalyticsReader, DEFAULT_ANALYTICS_RUNS } from './analytics-reader.js';
import { ConfigReader } from './config-reader.js';
import { ActionJobs, type ActionJob, type JobResult } from './action-jobs.js';
import { createEventBus, RunWatcher, type EventBus } from './event-bridge.js';
import type { ProjectRegistry, RegisteredProject } from './project-registry.js';
import { ContextTelemetryReader } from './context-telemetry-reader.js';
import {
  CLIENT_HEADER,
  checkHost,
  checkWrite,
  isWriteMethod,
} from './request-guard.js';

/**
 * The local control plane (§59, §86).
 *
 * It writes now, and the shape of *how* is the important part: every write handler
 * calls a use case in `app/run-actions.ts`, which is the same use case the CLI
 * calls. Not a shared helper — the same function. An HTTP handler that decided a
 * gate, computed a hash or touched `state.json` itself would be the parallel state
 * machine §60 forbids, and the browser and the terminal would drift apart in
 * silence rather than loudly.
 *
 * Four rules this file exists to keep:
 *
 *   - **No path ever arrives from the client.** Endpoints name a project by id
 *     and the registry resolves it. There is no request that can address a
 *     directory the operator did not register — and no write body carries a path,
 *     a command or a runner executable either.
 *   - **No trusted hash arrives from the client.** `approve` takes no plan hash.
 *     The use case reads the plan on disk and hashes it, so there is no call that
 *     opens the gate for a plan the person did not see (§90).
 *   - **Nothing reads a credential.** Runner health reports whether auth is
 *     configured, which is what the adapters already report to `doctor`; no
 *     handler opens an auth file, and none returns environment variables.
 *   - **The browser never talks to a runner.** Runners are spawned by the use
 *     cases, inside a job, exactly as the CLI spawns them.
 */

export interface ServerOptions {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly processRunner: ProcessRunner;
  /**
   * This process, for the run execution lock (AF-L01).
   *
   * Named apart from `host` below, which is a network interface. One is who we are,
   * the other is where we listen, and calling both `host` would have them read as
   * the same thing.
   */
  readonly processHost: Host;
  readonly registry: ProjectRegistry;
  readonly globalConfigPath: string;
  readonly version: string;
  readonly host: string;
  readonly port: number;
  /**
   * Where the shipped prompts live.
   *
   * Passed in rather than resolved here: the resolution depends on how agent-flow
   * was installed, which the CLI already works out, and a server that discovered
   * it independently would be a second answer to the same question.
   */
  readonly promptsDir: string;
  /** Where the built dashboard lives. Omitted when only the API is wanted. */
  readonly webDir?: string;
  readonly pollIntervalMs?: number;
  /**
   * Host names this server answers to beyond address literals and `localhost` (§93).
   *
   * Passed in rather than read here, for the reason every other setting is: the CLI
   * already loads the configuration, and a server that loaded it again would be a
   * second answer to the same question.
   */
  readonly allowedHosts?: readonly string[];
}

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly bus: EventBus;
  readonly watcher: RunWatcher;
  close(): Promise<void>;
}

export async function buildServer(options: ServerOptions): Promise<RunningServer> {
  const app = Fastify({ logger: false });

  /**
   * Who may talk to this server, decided before any handler runs (PRI-05).
   *
   * `onRequest` is the earliest hook Fastify offers — ahead of body parsing, ahead of
   * routing — which is what makes this a boundary rather than a check. A refusal here
   * cannot have had a side effect, because nothing below it has run.
   *
   * The rules and the attack they answer live in `request-guard.ts`. What belongs here
   * is only the wiring: the host guard on everything, the origin guard on writes, and
   * the request's own validated `Host` as the identity a write's `Origin` must match.
   */
  app.addHook('onRequest', (request, reply, done) => {
    const host = request.headers.host;

    const hostOutcome = checkHost(host, {
      ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
    });
    if (!hostOutcome.ok) return refuseGuard(reply, hostOutcome.refusal, done);

    if (!isWriteMethod(request.method)) return done();

    const clientHeader = request.headers[CLIENT_HEADER];
    const writeOutcome = checkWrite(
      {
        ...(typeof request.headers.origin === 'string' ? { origin: request.headers.origin } : {}),
        ...(typeof clientHeader === 'string' ? { client: clientHeader } : {}),
      },
      { host },
    );
    if (!writeOutcome.ok) return refuseGuard(reply, writeOutcome.refusal, done);

    return done();
  });
  const bus = createEventBus();
  const reader = new RunReader({
    fs: options.fs,
    clock: options.clock,
    // §21.2 needs `parallelism.maxTasks` to report what a run asked for beside what
    // it got. The run's *mode* is never read from here — that is captured at
    // creation and immutable (I-13).
    globalConfigPath: options.globalConfigPath,
  });
  // M4-07. Its own reader rather than a method on `RunReader`, for the reason
  // `AnalyticsReader` is its own: it opens different files, answers a different question,
  // and folding it in would make the class every run page depends on grow a second job.
  const collaboration = new CollaborationReader({
    fs: options.fs,
    globalConfigPath: options.globalConfigPath,
  });
  // M8-07. Composes the two above and reimplements neither: every part of a snapshot comes
  // from the same method that serves that part's own endpoint. It exists because eight
  // correct queries read at eight instants can paint a board showing a task `running`
  // beside an item saying it failed.
  const control = new ControlReader({ runs: reader, collaboration, clock: options.clock });
  const prompts = new PromptReader({ fs: options.fs, promptsDir: options.promptsDir });
  const analytics = new AnalyticsReader({ fs: options.fs, clock: options.clock });
  const jobs = new ActionJobs({
    clock: options.clock,
    // Down the same stream everything else uses. A job that the workflow refused
    // never touched `state.json`, so the run watcher cannot see it — publishing here
    // is what keeps polling out of the dashboard.
    onChange: (job) => {
      bus.publish({
        type: job.status === 'running' ? 'job.started' : 'job.finished',
        projectId: job.projectId,
        runId: job.runId,
        timestamp: job.finishedAt ?? job.startedAt,
        payload: { jobId: job.id, kind: job.kind, status: job.status },
      });
    },
  });
  const configReader = new ConfigReader({
    fs: options.fs,
    globalConfigPath: options.globalConfigPath,
  });

  const watcher = new RunWatcher({
    fs: options.fs,
    clock: options.clock,
    registry: options.registry,
    bus,
    ...(options.pollIntervalMs === undefined ? {} : { intervalMs: options.pollIntervalMs }),
  });

  /**
   * Resolves the project a request is about.
   *
   * Without `projectId` the answer is the primary project — the directory
   * `agent-flow ui` was started in — which is what a single-project dashboard
   * wants and what makes every route usable without the browser knowing ids.
   */
  const projectOf = (raw: unknown): RegisteredProject | undefined => {
    const query = ProjectQuerySchema.safeParse(raw ?? {});
    if (!query.success) return undefined;

    return query.data.projectId === undefined
      ? options.registry.primary()
      : options.registry.get(query.data.projectId);
  };

  app.get('/api/v1/health', (): HealthResponse => {
    return {
      status: 'ok',
      version: options.version,
      projects: options.registry.all().length,
      host: options.host,
      port: options.port,
    };
  });

  app.get('/api/v1/projects', async (): Promise<ProjectView[]> => {
    const views: ProjectView[] = [];

    for (const project of options.registry.all()) {
      const overview = await reader.projectOverview(project);
      const stack = await stackOf(options, project);

      views.push({
        id: project.id,
        name: project.name,
        path: project.path,
        ...(stack === undefined ? {} : { stack }),
        ...overview,
      });
    }

    return views;
  });

  app.get('/api/v1/runs', async (request, reply): Promise<RunSummaryView[] | undefined> => {
    const query = ProjectQuerySchema.safeParse(request.query ?? {});
    if (!query.success) return badRequest(reply, 'invalid projectId');

    // With no project named, every registered project is listed. That is the
    // workspace view of §65, and it is the same read either way.
    const projects =
      query.data.projectId === undefined
        ? options.registry.all()
        : [options.registry.get(query.data.projectId)].filter(
            (project): project is RegisteredProject => project !== undefined,
          );

    if (projects.length === 0) return notFound(reply, 'no such project');

    const runs: RunSummaryView[] = [];
    for (const project of projects) runs.push(...(await reader.listRuns(project)));

    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

  app.get('/api/v1/runs/:runId', async (request, reply) => {
    const scope = resolveRun(request, reply, projectOf);
    if (scope === undefined) return undefined;

    const detail = await reader.runDetail(scope.project, scope.runId);
    return detail === null ? notFound(reply, 'no such run') : detail;
  });

  app.get('/api/v1/runs/:runId/stages', async (request, reply) => {
    const scope = resolveRun(request, reply, projectOf);
    if (scope === undefined) return undefined;

    const stages = await reader.stages(scope.project, scope.runId);
    return stages === null ? notFound(reply, 'no such run') : stages;
  });

  app.get('/api/v1/runs/:runId/tasks', async (request, reply) => {
    const scope = resolveRun(request, reply, projectOf);
    if (scope === undefined) return undefined;

    const tasks = await reader.tasks(scope.project, scope.runId);
    return tasks === null ? notFound(reply, 'no such run') : tasks;
  });

  /**
   * The dependency graph, as structure (§92).
   *
   * Separate from `/tasks` on purpose rather than folded into it. This response
   * changes when the plan changes; `/tasks` changes every few seconds. A browser
   * holding them as one query would re-lay-out a five-hundred-node graph each time
   * a task ticked over.
   */
  app.get('/api/v1/runs/:runId/dag', async (request, reply) => {
    const scope = resolveRun(request, reply, projectOf);
    if (scope === undefined) return undefined;

    const dag = await reader.dag(scope.project, scope.runId);
    return dag === null ? notFound(reply, 'no such run') : dag;
  });

  app.get('/api/v1/runs/:runId/tasks/:taskId', async (request, reply) => {
    const params = TaskParamsSchema.safeParse(request.params);
    if (!params.success) return badRequest(reply, 'invalid run or task id');

    const project = projectOf(request.query);
    if (project === undefined) return notFound(reply, 'no such project');

    const detail = await reader.taskDetail(project, params.data.runId, params.data.taskId);
    return detail === null ? notFound(reply, 'no such task') : detail;
  });

  /**
   * What the agents on this run said to each other, and what they wrote down (M4-07).
   *
   * One response rather than four, because a thread's status and an entry's status are
   * folds over logs that have to be read at one instant — four calls would let a repaint
   * show a thread as open beside the entry that closed it.
   *
   * A run that predates M4, or one whose agents never spoke, answers with empty lists and
   * `enabled` from configuration. Empty is not an error, and the two facts are separate
   * on purpose: "off" invites the operator to turn it on and "on, and quiet" does not.
   */
  app.get('/api/v1/runs/:runId/collaboration', async (request, reply) => {
    const scope = resolveRun(request, reply, projectOf);
    if (scope === undefined) return undefined;

    const view = await collaboration.collaboration(scope.project, scope.runId);
    return view === null ? notFound(reply, 'no such run') : view;
  });

  /**
   * The run's team: who is configured, who holds what, and why each task went where.
   *
   * **The browser renders this and computes none of it** (M5-ACC-15, I-33). A candidate
   * ranking is the assignment policy's output, folded out of the audit log by
   * `core/team/view.ts` — the same function the CLI folds with. A dashboard that ranked
   * its own candidates would be a second assignment authority whose first disagreement
   * with the run puts a decision nobody made on screen.
   */
  app.get('/api/v1/runs/:runId/team', async (request, reply) => {
    const scope = resolveRun(request, reply, projectOf);
    if (scope === undefined) return undefined;

    const view = await collaboration.team(scope.project, scope.runId);
    return view === null ? notFound(reply, 'no such run') : view;
  });

  /**
   * The run's reviews: what was found, what is open, and whether it is still true.
   *
   * **The browser renders this and derives none of it** (§59, I-44). Review status,
   * a finding's blocking status, a gate's verdict and a review's freshness are all
   * answered by `core/review/view.ts` — the same fold `af status` prints. Freshness in
   * particular used to be computed in the dashboard, from fields it happened to have;
   * identity against the integrated tree is the only thing that answers it, and only the
   * projection knows both halves.
   */
  app.get('/api/v1/runs/:runId/review', async (request, reply) => {
    const scope = resolveRun(request, reply, projectOf);
    if (scope === undefined) return undefined;

    const view = await collaboration.review(scope.project, scope.runId);
    return view === null ? notFound(reply, 'no such run') : view;
  });

  /**
   * Where this run was delivered, if anywhere.
   *
   * Read-only and credential-free: the projection folds a file this machine already wrote,
   * so the dashboard can show "nothing is configured" without the server ever holding a
   * token. Every *write* to a forge stays behind the CLI, which is where an operator is.
   */
  app.get('/api/v1/runs/:runId/delivery', async (request, reply) => {
    const scope = resolveRun(request, reply, projectOf);
    if (scope === undefined) return undefined;

    const view = await collaboration.delivery(scope.project, scope.runId);
    return view === null ? notFound(reply, 'no such run') : view;
  });

  /**
   * The whole control plane for one run, read at one instant (M8 §7).
   *
   * Everything above still exists and still serves the detail panels, which open one at a
   * time and are not on the critical path of a first paint. This is the read the board and
   * the attention queue share, and sharing it is the point: a hundred cards must not be a
   * hundred requests, and two halves of one screen must not describe two moments.
   */
  app.get('/api/v1/runs/:runId/control', async (request, reply) => {
    const scope = resolveRun(request, reply, projectOf);
    if (scope === undefined) return undefined;

    const snapshot = await control.snapshot(scope.project, scope.runId);
    return snapshot === null ? notFound(reply, 'no such run') : snapshot;
  });

  /**
   * Every project, at the density a list of fifty of them can afford (M8 §37).
   *
   * Deliberately not `/projects` with more fields. That one answers "what is registered";
   * this answers "which of these wants me", and the two have different costs — only a
   * project with an active run pays for an attention count here.
   */
  app.get('/api/v1/workspace', async (): Promise<WorkspaceView> => {
    return control.workspace(options.registry.all());
  });

  app.get('/api/v1/runs/:runId/artifacts', async (request, reply) => {
    const scope = resolveRun(request, reply, projectOf);
    if (scope === undefined) return undefined;

    const artifacts = await reader.artifacts(scope.project, scope.runId);
    return artifacts === null ? notFound(reply, 'no such run') : artifacts;
  });

  // Beyond the endpoint list, and deliberately. The Artifacts card has to show
  // an SDD; returning every artifact's full text from the list route would make
  // the common call heavy to serve one uncommon need.
  app.get('/api/v1/runs/:runId/artifacts/:artifact', async (request, reply) => {
    const params = ArtifactParamsSchema.safeParse(request.params);
    if (!params.success) return badRequest(reply, 'unknown artifact');

    const project = projectOf(request.query);
    if (project === undefined) return notFound(reply, 'no such project');

    const content = await reader.artifactContent(
      project,
      params.data.runId,
      params.data.artifact,
    );
    return content === null ? notFound(reply, 'no such artifact') : content;
  });

  app.get('/api/v1/runs/:runId/telemetry', async (request, reply) => {
    const scope = resolveRun(request, reply, projectOf);
    if (scope === undefined) return undefined;

    const store = new StateStore({
      fs: options.fs,
      clock: options.clock,
      projectDir: scope.project.path,
    });

    let state;
    try {
      state = await store.loadRun(scope.runId);
    } catch {
      return notFound(reply, 'no such run');
    }

    const entries: TelemetryEntry[] = await collectTelemetry(store, state);
    const context = await new ContextTelemetryReader({
      fs: options.fs,
      projectDir: scope.project.path,
    }).read(scope.runId);
    return {
      entries,
      summary: summariseTelemetry(entries),
      ...(context === undefined ? {} : { context }),
    };
  });

  app.get('/api/v1/runners', async (request, reply): Promise<RunnerView[] | undefined> => {
    const project = projectOf(request.query);
    if (project === undefined) return notFound(reply, 'no such project');

    const config = await loadConfig({
      fs: options.fs,
      globalConfigPath: options.globalConfigPath,
      projectDir: project.path,
    });
    const registry = buildRegistry(config.global, {
      processRunner: options.processRunner,
      fs: options.fs,
    });
    const capabilities = registry.capabilities();

    return registry.ids().map((id) => ({
      id,
      // The adapter type, which is what independence is judged on. Never a
      // command line, a config path or anything holding a credential.
      provider: registry.providerOf(id) ?? 'unknown',
      // Resolved with no model: this endpoint describes the *runner*, on a page about
      // configuration, and there is no role in hand whose model would narrow it. AD-30's
      // per-pair answer belongs where a role is being resolved.
      reasoningLevels: [...(capabilitiesOf(capabilities, id)?.supportedReasoningLevels ?? [])],
      structuredOutput: capabilitiesOf(capabilities, id)?.structuredOutputStrategy ?? 'prompted',
    }));
  });

  app.get(
    '/api/v1/runners/health',
    async (request, reply): Promise<RunnerHealthView[] | undefined> => {
      const project = projectOf(request.query);
      if (project === undefined) return notFound(reply, 'no such project');

      const config = await loadConfig({
        fs: options.fs,
        globalConfigPath: options.globalConfigPath,
        projectDir: project.path,
      });
      const registry = buildRegistry(config.global, {
        processRunner: options.processRunner,
        fs: options.fs,
      });

      // The shallow check only. A live probe spends quota, and a dashboard that
      // polls would spend it repeatedly without anyone asking — `doctor --deep`
      // stays an explicit, one-off act.
      const health = await registry.health();

      return referencedRunners(config.global).map((id) => {
        const reported = health[id];
        return reported === undefined
          ? { id, installed: false, executable: false, auth: 'not_configured' }
          : {
              id,
              installed: reported.installed,
              executable: reported.executable,
              auth: reported.auth,
              ...(reported.version === undefined ? {} : { version: reported.version }),
              ...(reported.detail === undefined ? {} : { detail: reported.detail }),
            };
      });
    },
  );

  /**
   * What each logical role would run (§82).
   *
   * Resolution only — nothing here contacts a runner. The page joins this with
   * `/runners` and `/runners/health`, both of which it already holds, rather than
   * this route re-reporting a provider and a health check per role: nine roles
   * pointing at two runners would mean nine copies of two answers.
   */
  app.get('/api/v1/agents', async (request, reply): Promise<RoleRouteView[] | undefined> => {
    const project = projectOf(request.query);
    if (project === undefined) return notFound(reply, 'no such project');

    const config = await loadConfig({
      fs: options.fs,
      globalConfigPath: options.globalConfigPath,
      projectDir: project.path,
    });
    const registry = buildRegistry(config.global, {
      processRunner: options.processRunner,
      fs: options.fs,
    });

    const routes = await describeRoleRoutes({
      config: config.global,
      capabilities: registry.capabilities(),
      promptLoader: new PromptLoader({ fs: options.fs, promptsDir: options.promptsDir }),
    });

    return routes.map((route) => ({
      role: route.role,
      prompts: [...route.prompts],
      requiresReadOnly: route.requirements.readOnly === true,
      requiresNativeStructuredOutput: route.requirements.nativeStructuredOutput === true,
      configured: route.configured,
      ...(route.resolved === undefined ? {} : { resolved: route.resolved }),
      ...(route.error === undefined ? {} : { error: route.error }),
      ...(route.fallback === undefined ? {} : { fallback: route.fallback }),
      ...(route.fallbackAbsent === undefined ? {} : { fallbackAbsent: route.fallbackAbsent }),
    }));
  });

  /**
   * The effective configuration (§85).
   *
   * Read-only. `PATCH /config` is listed in §86 and is not implemented: writing a
   * merged value back means deciding which of three layers it belongs in, and a
   * settings page that guessed would move a project's override into the global file
   * — silently changing every other project on the machine.
   */
  app.get('/api/v1/config', async (request, reply): Promise<ConfigView | undefined> => {
    const project = projectOf(request.query);
    if (project === undefined) return notFound(reply, 'no such project');

    return configReader.describe(project);
  });

  app.get('/api/v1/prompts', async (): Promise<PromptView[]> => prompts.list());

  app.get('/api/v1/prompts/:prompt', async (request, reply) => {
    const params = PromptParamsSchema.safeParse(request.params);
    if (!params.success) return badRequest(reply, 'unknown prompt');

    const content = await prompts.read(params.data.prompt);
    return content === null ? notFound(reply, 'no such prompt') : content;
  });

  app.get('/api/v1/analytics', async (request, reply): Promise<AnalyticsView | undefined> => {
    const query = AnalyticsQuerySchema.safeParse(request.query ?? {});
    if (!query.success) return badRequest(reply, 'invalid analytics scope');

    // The same scoping rule as `/runs`: no project named means the workspace.
    const scoped =
      query.data.projectId === undefined
        ? options.registry.all()
        : [options.registry.get(query.data.projectId)].filter(
            (project): project is RegisteredProject => project !== undefined,
          );

    if (scoped.length === 0) return notFound(reply, 'no such project');

    return analytics.aggregate(scoped, query.data.limit ?? DEFAULT_ANALYTICS_RUNS);
  });

  // -------------------------------------------------------------------------
  // Write API (§86, UI-27)
  // -------------------------------------------------------------------------
  //
  // Every handler below is a translator and nothing else. It validates the shape
  // that arrived, resolves the project through the registry, calls the use case in
  // `app/run-actions.ts` — the same one the CLI calls — and turns the outcome into
  // a status code. No handler reads a plan, computes a hash, decides a gate or
  // touches `state.json`: doing any of that here would be the parallel state
  // machine §60 forbids, and the browser and the terminal would start enforcing the
  // workflow separately.
  //
  // `pause`, `resume` and `cancel` are absent. §86 lists them and the core has no
  // semantics for any of the three: `RUN_STATUSES` has no paused or cancelled, and
  // the scheduler has no way to be interrupted between tasks. An endpoint that set
  // a status field to satisfy the list would be a button that lies.

  /** How a use case's refusal becomes a status code. */
  const statusOf = (code: ActionErrorCode): number => {
    switch (code) {
      case 'no_such_run':
      case 'no_such_task':
        return 404;
      case 'invalid_input':
        return 400;
      // Everything else is a refusal about the run's *state*, not about the
      // request: the request was well formed and the workflow said no.
      default:
        return 409;
    }
  };

  const rejectAction = (reply: FastifyReply, error: ActionError): ActionErrorView => {
    reply.code(statusOf(error.code));
    return errorView(error);
  };

  /** The ports a use case needs, for one project. Never a client-supplied path. */
  const depsFor = (project: RegisteredProject): RunActionDeps => ({
    fs: options.fs,
    clock: options.clock,
    processRunner: options.processRunner,
    host: options.processHost,
    projectDir: project.path,
    globalConfigPath: options.globalConfigPath,
    promptsDir: options.promptsDir,
    // Written into the execution lock, so a CLI refused by this server can see that
    // the server is what has the run.
    owner: 'server',
  });

  /** The lock, for the pre-flight read. Acquisition belongs to the use cases. */
  const lockFor = (project: RegisteredProject): RunExecutionLock =>
    new RunExecutionLock({
      fs: options.fs,
      clock: options.clock,
      host: options.processHost,
      projectDir: project.path,
    });

  app.get('/api/v1/runs/:runId/approval', async (request, reply) => {
    const scope = resolveRun(request, reply, projectOf);
    if (scope === undefined) return undefined;

    const outcome = await describeApprovalGate(depsFor(scope.project), scope.runId);
    if (!outcome.ok) return rejectAction(reply, outcome.error);

    const gate = outcome.value;
    const view: ApprovalGateView = {
      ...gate,
      warnings: [...gate.warnings],
      ...(gate.review === undefined
        ? {}
        : { review: { ...gate.review, findings: [...gate.review.findings] } }),
      degradations: [...gate.degradations],
    };
    return view;
  });

  app.post('/api/v1/runs/:runId/approve', async (request, reply) => {
    const scope = resolveRun(request, reply, projectOf);
    if (scope === undefined) return undefined;

    const body = ApproveRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return badRequest(reply, 'invalid approve request');

    // No hash crosses this boundary. The use case reads the plan on disk and
    // hashes it, so there is no version of this call that approves a plan the
    // person did not see (§90).
    const outcome = await approve(depsFor(scope.project), scope.runId, {
      force: body.data.force,
    });

    if (!outcome.ok) return rejectAction(reply, outcome.error);
    return actionResult(scope.runId, outcome.warnings, {
      planHash: outcome.value.planHash,
      taskCount: outcome.value.taskCount,
      forced: outcome.value.forced,
    });
  });

  app.post('/api/v1/runs/:runId/reject', async (request, reply) => {
    const scope = resolveRun(request, reply, projectOf);
    if (scope === undefined) return undefined;

    const body = RejectRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return badRequest(reply, 'invalid reject request');

    const outcome = await reject(depsFor(scope.project), scope.runId, body.data.reason);
    if (!outcome.ok) return rejectAction(reply, outcome.error);
    return actionResult(scope.runId, outcome.warnings);
  });

  app.post('/api/v1/runs/:runId/tasks/:taskId/retry', async (request, reply) => {
    const params = TaskParamsSchema.safeParse(request.params);
    if (!params.success) return badRequest(reply, 'invalid run or task id');

    const project = projectOf(request.query);
    if (project === undefined) return notFound(reply, 'no such project');

    const body = RetryRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return badRequest(reply, 'invalid retry request');

    const outcome = await retryTask(depsFor(project), params.data.runId, params.data.taskId, {
      force: body.data.force,
    });

    if (!outcome.ok) return rejectAction(reply, outcome.error);
    return actionResult(params.data.runId, outcome.warnings, {
      taskId: outcome.value.taskId,
      attempts: outcome.value.attempts,
      forced: outcome.value.forced,
    });
  });

  /**
   * Starting a run and revising a plan are jobs, not requests.
   *
   * Both spawn runner processes and take minutes. The handler answers 202 with a
   * job id and the work proceeds; progress arrives through the stream the run
   * watcher already feeds, because `state.json` changing is what progress *is*.
   */
  const startJob = async (
    reply: FastifyReply,
    project: RegisteredProject,
    kind: 'start' | 'revise',
    runId: string,
    work: () => Promise<JobResult>,
  ): Promise<ActionJobView | ActionErrorView> => {
    // Asked before the job starts, so a run another process is executing is refused
    // with a conflict rather than accepted and then failed. Not a second
    // implementation of the guard — it reads the same lock the use case will take,
    // and the authoritative acquisition still happens in there. Racing this check
    // only costs a job that reports `run_busy`, which is the honest outcome anyway.
    const held = await lockFor(project).describe(runId);
    if (held !== undefined) {
      reply.code(409);
      return runBusy(held);
    }

    const outcome = jobs.start({ kind, projectId: project.id, runId, work });

    if ('busy' in outcome) {
      reply.code(409);
      return {
        error: 'run_busy',
        message: `${runId} is already ${
          outcome.busy.kind === 'start' ? 'running' : 're-planning'
        } in this server.`,
        action: 'Wait for it to finish, or watch it on the run page.',
        detail: { jobId: outcome.busy.id, kind: outcome.busy.kind },
      };
    }

    reply.code(202);
    return jobView(outcome.started);
  };

  /**
   * Lifecycle, from the browser (PRI-14, PRI-15).
   *
   * Ordinary handlers rather than jobs, and the difference from `start` is the point:
   * these three do not spawn anything. `pause` and `cancel` write an intent and return —
   * whatever is executing the run, in this server or in somebody's terminal, observes it.
   * `resume` does start work, so it goes through the job machinery like `start` does.
   *
   * None of them takes the execution lease. That is what makes them the commands they
   * are: a pause that had to wait for the run to finish would be a no-op with extra steps.
   */
  app.post('/api/v1/runs/:runId/pause', async (request, reply) => {
    const scope = resolveRun(request, reply, projectOf);
    if (scope === undefined) return undefined;

    const outcome = await pause(depsFor(scope.project), scope.runId);
    if (!outcome.ok) return rejectAction(reply, outcome.error);

    return actionResult(scope.runId, outcome.warnings, {
      pauseRequestedAt: outcome.value.pauseRequestedAt,
      alreadyPaused: outcome.value.alreadyPaused,
      executing: outcome.value.executing,
    });
  });

  app.post('/api/v1/runs/:runId/cancel', async (request, reply) => {
    const scope = resolveRun(request, reply, projectOf);
    if (scope === undefined) return undefined;

    const outcome = await cancel(depsFor(scope.project), scope.runId);
    if (!outcome.ok) return rejectAction(reply, outcome.error);

    return actionResult(scope.runId, outcome.warnings, {
      cancelledAt: outcome.value.cancelledAt,
      alreadyCancelled: outcome.value.alreadyCancelled,
      interrupted: [...outcome.value.interrupted],
      executing: outcome.value.executing,
    });
  });

  app.post('/api/v1/runs/:runId/resume', async (request, reply) => {
    const scope = resolveRun(request, reply, projectOf);
    if (scope === undefined) return undefined;

    const deps = depsFor(scope.project);
    const runId = scope.runId;

    // A job, because resuming executes the plan — minutes of work and spawned runners.
    // The refusals `resume` owns (not paused, cancelled, still executing) come back
    // through the job, exactly as `start`'s gates do.
    return await startJob(reply, scope.project, 'start', runId, async () => {
      const outcome = await resume(deps, runId);
      if (!outcome.ok) return { error: outcome.error };

      const scheduled = outcome.value.outcome;
      return {
        summary: scheduled.planComplete
          ? 'Every task completed.'
          : `Stopped: ${scheduled.haltedBy ?? 'not all tasks completed'}.`,
      };
    });
  });

  app.post('/api/v1/runs/:runId/start', async (request, reply) => {
    const scope = resolveRun(request, reply, projectOf);
    if (scope === undefined) return undefined;

    const body = StartRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return badRequest(reply, 'invalid start request');

    const deps = depsFor(scope.project);
    const runId = scope.runId;
    const taskId = body.data.taskId;

    // The gates are checked *inside* the use case, so a refusal has to come back
    // through the job rather than through the response. Checked eagerly here as
    // well would mean two implementations of the same gate, one of which could
    // fall behind — so the 202 says "asked", not "will succeed", and the job says
    // which.
    return await startJob(reply, scope.project, 'start', runId, async () => {
      const outcome = await start(deps, runId, taskId === undefined ? {} : { taskId });
      if (!outcome.ok) return { error: outcome.error };

      const scheduled = outcome.value.outcome;
      return {
        summary: scheduled.planComplete
          ? 'Every task completed.'
          : scheduled.complete
            ? 'The requested work completed; the plan has not.'
            : `Stopped: ${scheduled.haltedBy ?? 'not all tasks completed'}.`,
      };
    });
  });

  app.post('/api/v1/runs/:runId/revise', async (request, reply) => {
    const scope = resolveRun(request, reply, projectOf);
    if (scope === undefined) return undefined;

    const body = ReviseRequestSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return badRequest(reply, 'a revision needs an instruction saying what should change');
    }

    const deps = depsFor(scope.project);
    const runId = scope.runId;
    const instruction = body.data.instruction;

    return await startJob(reply, scope.project, 'revise', runId, async () => {
      const outcome = await revise(deps, runId, instruction);
      if (!outcome.ok) return { error: outcome.error };

      return {
        summary: `Re-planned into ${String(outcome.value.taskCount)} tasks${
          outcome.value.reviewVerdict === undefined
            ? ''
            : `; review ${outcome.value.reviewVerdict}`
        }.`,
      };
    });
  });

  app.get('/api/v1/jobs/:jobId', (request, reply) => {
    const params = JobParamsSchema.safeParse(request.params);
    if (!params.success) return badRequest(reply, 'invalid job id');

    const job = jobs.get(params.data.jobId);
    return job === undefined ? notFound(reply, 'no such job') : jobView(job);
  });

  app.get('/api/v1/runs/:runId/job', async (request, reply) => {
    const scope = resolveRun(request, reply, projectOf);
    if (scope === undefined) return undefined;

    // Null rather than 404: "nothing is running" is the normal answer, and a page
    // that polled a 404 to learn it would log an error every time it asked.
    const active = jobs.activeFor(scope.project.id, scope.runId);
    return active === undefined ? null : jobView(active);
  });

  app.get('/api/v1/events', (request, reply) => {
    const query = EventsQuerySchema.safeParse(request.query ?? {});
    if (!query.success) return badRequest(reply, 'invalid filter');

    const { projectId, runId } = query.data;

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // The dashboard is served from the same origin; nothing here needs to be
      // readable from another one.
      'x-accel-buffering': 'no',
    });

    const send = (event: ServerEvent): void => {
      if (projectId !== undefined && event.projectId !== projectId) return;
      if (runId !== undefined && event.runId !== runId) return;
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // An immediate comment so a client knows the stream is open before anything
    // has happened, and so an intermediary does not hold the response waiting
    // for a first byte.
    reply.raw.write(': connected\n\n');

    const unsubscribe = bus.subscribe(send);

    // Keeps the connection from being reaped while a run is idle. A comment
    // line is ignored by EventSource, so it costs the client nothing.
    const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    keepAlive.unref?.();

    request.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });

    return reply;
  });

  if (options.webDir !== undefined) {
    const staticPlugin = (await import('@fastify/static')).default;
    await app.register(staticPlugin, { root: options.webDir, wildcard: false });

    // Client-side routing: anything that is not an API call and not a real file
    // is the dashboard's own route, and the shell has to be served for it.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not_found', message: 'no such endpoint' });
      }
      return reply.sendFile('index.html');
    });
  }

  await app.ready();
  await watcher.prime();
  watcher.start();

  return {
    app,
    bus,
    watcher,
    close: async () => {
      watcher.stop();
      await app.close();
    },
  };
}

function resolveRun(
  request: { params: unknown; query: unknown },
  reply: { code(status: number): { send(body: unknown): unknown } },
  projectOf: (raw: unknown) => RegisteredProject | undefined,
): { project: RegisteredProject; runId: string } | undefined {
  const params = RunParamsSchema.safeParse(request.params);
  if (!params.success) {
    badRequest(reply, 'invalid run id');
    return undefined;
  }

  const project = projectOf(request.query);
  if (project === undefined) {
    notFound(reply, 'no such project');
    return undefined;
  }

  return { project, runId: params.data.runId };
}

async function stackOf(
  options: ServerOptions,
  project: RegisteredProject,
): Promise<string | undefined> {
  try {
    const config = await loadConfig({
      fs: options.fs,
      globalConfigPath: options.globalConfigPath,
      projectDir: project.path,
    });
    return config.project?.project.type;
  } catch {
    // A project with a broken config still belongs in the list; hiding it would
    // make the one project that needs attention the one that disappears.
    return undefined;
  }
}

/**
 * A job as the browser sees it.
 *
 * The error is re-shaped rather than passed through: the wire form leads with a
 * `code` under the name `error`, because a client branching on the outcome should
 * find the machine-readable part first and the prose second.
 */
function jobView(job: ActionJob): ActionJobView {
  return {
    id: job.id,
    kind: job.kind,
    projectId: job.projectId,
    runId: job.runId,
    startedAt: job.startedAt,
    status: job.status,
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    ...(job.summary === undefined ? {} : { summary: job.summary }),
    ...(job.error === undefined ? {} : { error: errorView(job.error) }),
  };
}

/**
 * A run another process is executing, as the browser sees it.
 *
 * The same words the use case would have produced, from the same refusal shape — so
 * the pre-flight 409 and the job's own refusal cannot describe the situation
 * differently.
 */
function runBusy(held: LockRefusal): ActionErrorView {
  const holder = held.holder;

  return {
    error: 'run_busy',
    message:
      holder === undefined
        ? `${held.runId} is locked by another process.`
        : `${held.runId} is already being ${
            holder.operation === 'run' ? 'executed' : holder.operation === 'revise' ? 're-planned' : 'modified by a retry'
          } by the ${holder.owner}${held.sameHost ? ` (pid ${String(holder.pid)})` : ` on ${holder.hostname}`}.`,
    action: held.sameHost
      ? 'Wait for the active execution to finish.'
      : 'The lock was written by another machine, which this server will not judge.',
    ...(holder === undefined
      ? {}
      : {
          detail: {
            holder: {
              owner: holder.owner,
              operation: holder.operation,
              pid: holder.pid,
              hostname: holder.hostname,
              createdAt: holder.createdAt,
            },
            sameHost: held.sameHost,
          },
        }),
  };
}

function errorView(error: ActionError): ActionErrorView {
  return {
    error: error.code,
    message: error.message,
    ...(error.action === undefined ? {} : { action: error.action }),
    ...(error.forcible === undefined ? {} : { forcible: error.forcible }),
    ...(error.detail === undefined ? {} : { detail: error.detail }),
  };
}

function actionResult(
  runId: string,
  warnings: readonly string[],
  detail?: Record<string, unknown>,
): ActionResultView {
  return {
    runId,
    warnings: [...warnings],
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * Answers a guard refusal and stops the request there.
 *
 * The body is the same `{ error, message, action }` shape every other refusal uses, so
 * the dashboard's existing error rendering shows it without a special case — and a
 * person who hits it by pointing `curl` at the API reads what to do rather than a bare
 * 403.
 *
 * `done()` is called with no argument after `send`, which is how an `onRequest` hook
 * short-circuits in Fastify: passing the error instead would route it through the error
 * handler and replace this body with a generic one.
 */
function refuseGuard(
  reply: FastifyReply,
  refusal: { status: number; error: string; message: string; action: string },
  done: () => void,
): void {
  void reply.code(refusal.status).send({
    error: refusal.error,
    message: refusal.message,
    action: refusal.action,
  });
  done();
}

function badRequest(
  reply: { code(status: number): { send(body: unknown): unknown } },
  message: string,
): undefined {
  reply.code(400).send({ error: 'bad_request', message });
  return undefined;
}

function notFound(
  reply: { code(status: number): { send(body: unknown): unknown } },
  message: string,
): undefined {
  reply.code(404).send({ error: 'not_found', message });
  return undefined;
}
