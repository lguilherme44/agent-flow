import Fastify, { type FastifyInstance } from 'fastify';
import {
  ArtifactParamsSchema,
  EventsQuerySchema,
  ProjectQuerySchema,
  RunParamsSchema,
  TaskParamsSchema,
  type HealthResponse,
  type ProjectView,
  type RunSummaryView,
  type RunnerHealthView,
  type RunnerView,
  type ServerEvent,
} from '../contracts/index.js';
import { StateStore } from '../app/state-store.js';
import { loadConfig } from '../config/loader.js';
import { buildRegistry } from '../adapters/runners/registry.js';
import { referencedRunners } from '../core/health.js';
import { collectTelemetry } from '../app/telemetry.js';
import { summariseTelemetry } from '../core/telemetry.js';
import type { Clock, FileSystem, ProcessRunner } from '../ports/index.js';
import { RunReader } from './run-reader.js';
import { createEventBus, RunWatcher, type EventBus } from './event-bridge.js';
import type { ProjectRegistry, RegisteredProject } from './project-registry.js';

/**
 * The local control plane (§59, §86).
 *
 * Read-only, and structurally so: there is no route here that writes anything.
 * Approving a plan or starting a run stays with the CLI until the write API is
 * designed, because every one of those actions is a state transition the
 * StateStore owns, and an HTTP handler that performed one itself would be the
 * parallel state machine §60 forbids.
 *
 * Three rules this file exists to keep:
 *
 *   - **No path ever arrives from the client.** Endpoints name a project by id
 *     and the registry resolves it. There is no request that can address a
 *     directory the operator did not register.
 *   - **Nothing reads a credential.** Runner health reports whether auth is
 *     configured, which is what the adapters already report to `doctor`; no
 *     handler opens an auth file, and none returns environment variables.
 *   - **The browser never talks to a runner.** The only live calls this process
 *     makes are `healthCheck`, which spawns a CLI with `--version`.
 */

export interface ServerOptions {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly processRunner: ProcessRunner;
  readonly registry: ProjectRegistry;
  readonly globalConfigPath: string;
  readonly version: string;
  readonly host: string;
  readonly port: number;
  /** Where the built dashboard lives. Omitted when only the API is wanted. */
  readonly webDir?: string;
  readonly pollIntervalMs?: number;
}

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly bus: EventBus;
  readonly watcher: RunWatcher;
  close(): Promise<void>;
}

export async function buildServer(options: ServerOptions): Promise<RunningServer> {
  const app = Fastify({ logger: false });
  const bus = createEventBus();
  const reader = new RunReader({ fs: options.fs, clock: options.clock });

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
      const store = new StateStore({
        fs: options.fs,
        clock: options.clock,
        projectDir: project.path,
      });

      let currentRunId: string | null = null;
      let status: ProjectView['status'] = null;

      try {
        currentRunId = await store.currentRunId();
        if (currentRunId !== null) status = (await store.loadRun(currentRunId)).status;
      } catch {
        // A project whose current run is unreadable is still a project.
        status = null;
      }

      const stack = await stackOf(options, project);

      views.push({
        id: project.id,
        name: project.name,
        path: project.path,
        ...(stack === undefined ? {} : { stack }),
        currentRunId,
        status,
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

  app.get('/api/v1/runs/:runId/tasks/:taskId', async (request, reply) => {
    const params = TaskParamsSchema.safeParse(request.params);
    if (!params.success) return badRequest(reply, 'invalid run or task id');

    const project = projectOf(request.query);
    if (project === undefined) return notFound(reply, 'no such project');

    const detail = await reader.taskDetail(project, params.data.runId, params.data.taskId);
    return detail === null ? notFound(reply, 'no such task') : detail;
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

    const entries = await collectTelemetry(store, state);
    return { entries, summary: summariseTelemetry(entries) };
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
      reasoningLevels: [...(capabilities[id]?.supportedReasoningLevels ?? [])],
      structuredOutput: capabilities[id]?.structuredOutputStrategy ?? 'prompted',
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
