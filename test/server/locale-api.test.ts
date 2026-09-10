import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { buildServer, type RunningServer } from '../../src/server/server.js';
import { registryOf } from '../../src/server/project-registry.js';
import { StateStore } from '../../src/app/state-store.js';
import { en, ptBR } from '../../src/core/phrases/index.js';
import type { ConfigView, ControlSnapshotView, DeliveryView } from '../../src/contracts/index.js';

/**
 * `?lang` reaches the sentence, and the sentence is the whole screen (§93.1).
 *
 * **Why an HTTP test rather than a unit test on the book.** The book being complete is a
 * build error, so it cannot be what breaks. What breaks is a *route* that forgot to pass
 * the locale on — a handler composing a reader that composes a fold, with one link in
 * that chain still defaulting to English. That is invisible to every test below the wire
 * and obvious in one request, which is why these ask the server.
 *
 * The four asked here are the four kinds: a **fold** over run state (`/control`), a
 * **projection** over a record (`/delivery`), a **catalogue** the server writes
 * (`/config`), and a **refusal** (a run id that names nothing). A fifth kind exists and is deliberately
 * absent — anything a model wrote — because no book can translate it.
 */

const PROJECT = { id: 'demo', name: 'demo', path: '/repo' };

const PROJECT_CONFIG = `project:
  name: demo
  type: node
commands:
  test: npm test
`;

const PLAN = {
  feature: 'weekly-recurrence',
  tasks: [
    {
      id: 'TASK-001',
      title: 'Add recurrence types',
      description: 'Domain types.',
      complexity: 'trivial',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['Types compile.'],
      validation: ['test'],
    },
    {
      id: 'TASK-002',
      title: 'Use the types',
      description: 'Wire them in.',
      complexity: 'normal',
      risk: 'low',
      dependencies: ['TASK-001'],
      requirements: ['FR-002'],
      acceptanceCriteria: ['It compiles.'],
      validation: ['test'],
    },
  ],
};

let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function serve() {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();

  fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);

  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const run = await store.createRun('weekly recurrence');
  await store.writeArtifact(run.runId, 'plan', JSON.stringify(PLAN, null, 2));

  await store.updateRun(run.runId, (state) => ({
    ...state,
    stage: 'implementation',
    status: 'running',
    approved: true,
    tasks: [
      { id: 'TASK-001', state: 'completed' as never, attempts: 1, infrastructureFailures: 0 },
      { id: 'TASK-002', state: 'queued' as never, attempts: 0, infrastructureFailures: 0 },
    ],
  }));

  running = await buildServer({
    fs,
    clock,
    processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: '1.0.0' }),
    registry: registryOf([PROJECT]),
    globalConfigPath: '/home/.agent-flow/config.yaml',
    version: '0.1.0',
    host: '127.0.0.1',
    port: 4783,
    promptsDir: '/install/prompts',
    processHost: new FakeHost(),
    pollIntervalMs: 20,
  });

  return { run, server: running };
}

const get = async <T>(server: RunningServer, url: string): Promise<T> => {
  const response = await server.app.inject({ method: 'GET', url });
  return response.json<T>();
};

describe('§93.1 — the reader chooses the language, and gets all of it', () => {
  it('writes a board card’s reason in the language the request names', async () => {
    const { server, run } = await serve();

    const english = await get<ControlSnapshotView>(server, `/api/v1/runs/${run.runId}/control`);
    const portuguese = await get<ControlSnapshotView>(
      server,
      `/api/v1/runs/${run.runId}/control?lang=pt-BR`,
    );

    const reasonOf = (snapshot: ControlSnapshotView, taskId: string): string =>
      snapshot.cards.find((card) => card.task.id === taskId)?.reason.text ?? '';

    expect(reasonOf(english, 'TASK-001')).toBe(en.board.completed);
    expect(reasonOf(portuguese, 'TASK-001')).toBe(ptBR.board.completed);

    expect(reasonOf(portuguese, 'TASK-002')).toBe(ptBR.board.readyToStart);

    // The sentence that carries an identifier, because that is where a translation goes
    // wrong quietly: the words move and `TASK-004` must not.
    expect(ptBR.board.heldBackBy('TASK-004')).toContain('TASK-004');
  });

  it('defaults to English when a request names no language', async () => {
    const { server, run } = await serve();

    const snapshot = await get<ControlSnapshotView>(server, `/api/v1/runs/${run.runId}/control`);

    // §93.1's floor: `agent-flow` in a terminal, and any client that has not asked, keeps
    // getting the sentences its scripts and its issues were written against.
    expect(snapshot.cards.map((card) => card.reason.text)).toEqual([
      en.board.completed,
      en.board.readyToStart,
    ]);
  });

  it('translates a delivery projection', async () => {
    const { server, run } = await serve();

    const english = await get<DeliveryView>(server, `/api/v1/runs/${run.runId}/delivery`);
    const portuguese = await get<DeliveryView>(
      server,
      `/api/v1/runs/${run.runId}/delivery?lang=pt-BR`,
    );

    expect(english.detail).toBe(en.delivery.noForgeConfigured);
    expect(portuguese.detail).toBe(ptBR.delivery.noForgeConfigured);
  });

  it('translates the settings catalogue the server writes', async () => {
    const { server } = await serve();

    const english = await get<ConfigView>(server, '/api/v1/config');
    const portuguese = await get<ConfigView>(server, '/api/v1/config?lang=pt-BR');

    const titleOf = (view: ConfigView, id: string): string | undefined =>
      view.sections.find((section) => section.id === id)?.title;

    expect(titleOf(english, 'execution')).toBe(en.config.execution);
    expect(titleOf(portuguese, 'execution')).toBe(ptBR.config.execution);

    // The keys are not prose and never move: a person edits `parallelism.maxTasks` in a
    // file, and a translated key names nothing.
    const keysOf = (view: ConfigView): string[] =>
      view.sections.flatMap((section) => section.settings.map((setting) => setting.key));
    expect(keysOf(portuguese)).toEqual(keysOf(english));
  });

  it('translates a refusal, which is the half that used to stay English', async () => {
    const { server } = await serve();

    const english = await server.app.inject({ method: 'GET', url: '/api/v1/runs/AF-2026-999' });
    const portuguese = await server.app.inject({
      method: 'GET',
      url: '/api/v1/runs/AF-2026-999?lang=pt-BR',
    });

    expect(english.statusCode).toBe(404);
    expect(portuguese.statusCode).toBe(404);
    expect(english.json<{ message: string }>().message).toBe(en.server.noSuchRun);
    expect(portuguese.json<{ message: string }>().message).toBe(ptBR.server.noSuchRun);
  });
});
