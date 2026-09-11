import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { buildServer, type RunningServer } from '../../src/server/server.js';
import { registryOf } from '../../src/server/project-registry.js';
import { StateStore } from '../../src/app/state-store.js';
import { LOCALES } from '../../src/contracts/index.js';

/**
 * **`?lang` must not be able to break a route**, and this is the test that was missing.
 *
 * The language is part of a read's *address*: the Deck's `url()` appends `lang` to every
 * request, because a cache key that ignored it would serve a Portuguese reader the English
 * answer it fetched a moment ago. That made one transport key universal — and a query
 * schema declared `.strict()` refuses an unexpected key by design, which is §93 enforced
 * by the shape rather than by a reader's discipline.
 *
 * The two facts collided in production. `ConfigEditorQuerySchema` was strict, the Deck
 * sent `lang`, and the Crew screen said "the configuration could not be read" against a
 * configuration that loads fine — a 400 on a request that was perfectly well formed. The
 * earlier locale test could not see it: it asked four endpoints it had chosen, and the one
 * that broke was not among them.
 *
 * So this asks *every* route the Deck reads, in every locale the contract names, and it
 * asserts the boring thing: adding `lang` changes the language and nothing else. A new
 * strict schema that forgets `lang` fails here rather than on somebody's screen.
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
    port: 4784,
    promptsDir: '/install/prompts',
    processHost: new FakeHost(),
    pollIntervalMs: 20,
  });

  return { run, server: running };
}

/**
 * Every read the Deck issues, as `api.ts` spells them.
 *
 * Derived by reading that file rather than by imagination, because a list somebody
 * remembered is a list that goes stale — and the route that broke was the one nobody
 * remembered. `{run}` is substituted with the seeded run, and each entry carries its own
 * query: `/config/editor` refuses `projectId` on the global scope by design, so a builder
 * that appended one everywhere would be testing its own mistake.
 */
const READS = [
  '/workspace?projectId=demo',
  '/projects',
  '/projects/candidates',
  '/runs?projectId=demo',
  '/agents?projectId=demo',
  '/config?projectId=demo',
  '/config/editor?scope=global',
  '/config/editor?scope=project&projectId=demo',
  '/doctor?projectId=demo',
  '/analytics?projectId=demo',
  '/prompts',
  '/runners/health?projectId=demo',
  '/runs/{run}?projectId=demo',
  '/runs/{run}/stages?projectId=demo',
  '/runs/{run}/tasks?projectId=demo',
  '/runs/{run}/tasks/TASK-001?projectId=demo',
  '/runs/{run}/dag?projectId=demo',
  '/runs/{run}/control?projectId=demo',
  '/runs/{run}/events?projectId=demo',
  '/runs/{run}/artifacts?projectId=demo',
  '/runs/{run}/approval?projectId=demo',
  '/runs/{run}/review?projectId=demo',
  '/runs/{run}/team?projectId=demo',
  '/runs/{run}/collaboration?projectId=demo',
  '/runs/{run}/delivery?projectId=demo',
  '/runs/{run}/telemetry?projectId=demo',
  '/runs/{run}/quality?projectId=demo',
  '/sessions',
];

describe('every read the Deck issues survives being asked in a language', () => {
  for (const locale of LOCALES) {
    it(`answers all of them with lang=${locale}`, async () => {
      const { server, run } = await serve();

      const refused: string[] = [];
      for (const template of READS) {
        const path = template.replace('{run}', run.runId);
        const url = `/api/v1${path}${path.includes('?') ? '&' : '?'}lang=${locale}`;
        const response = await server.app.inject({ method: 'GET', url });

        // 200 or a considered 404 — a fixture without a forge record legitimately has no
        // delivery. What must never happen is 400: that is the shape saying the request
        // was malformed, and adding a language does not malform a request.
        if (response.statusCode >= 400 && response.statusCode !== 404) {
          refused.push(`${path} → ${String(response.statusCode)} ${response.body.slice(0, 120)}`);
        }
      }

      expect(refused).toEqual([]);
    });
  }

  it('positive control: an unknown key is still refused where the shape is strict', async () => {
    const { server } = await serve();

    // The rule the fix must not have deleted. `.strict()` on the config-editor query is
    // §93 in the shape: a request has no field for a path, and one that invents a key gets
    // a refusal rather than having it quietly ignored. If this passes, `lang` was added by
    // loosening the schema instead of by declaring the key — and the next `path=` gets in.
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/v1/config/editor?scope=global&path=/etc/passwd',
    });

    expect(response.statusCode).toBe(400);
  });

  it('positive control: an unknown language is refused rather than guessed', async () => {
    const { server } = await serve();

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/v1/config/editor?scope=global&lang=klingon',
    });

    // `lang` is declared, so it is also *validated*. A route that accepted anything here
    // would be one where `lang` had been added as a hole rather than as a field.
    expect(response.statusCode).toBe(400);
  });
});
