import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, type RunningServer } from '../../src/server/server.js';
import { registryOf } from '../../src/server/project-registry.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import type { DoctorView } from '../../src/contracts/index.js';
import { en } from '../../src/core/phrases/index.js';

/**
 * 7.5 — "can this machine work?", asked over HTTP.
 *
 * The Deck is meant to replace the terminal, and the first question of every working day
 * had no route: `doctor` computed each fact and printed it in the same breath, so the CLI
 * was the only thing that could ever ask. These tests are about the *answer being data* —
 * the sentences stay in `cli/doctor.ts` and are tested there.
 */

const PROJECT = { id: 'demo', name: 'demo', path: '/repo' };

const PROJECT_CONFIG = `project:
  name: demo
  type: node
commands:
  test: npm test
`;

/**
 * A global configuration with a stage that is served by more than it needs.
 *
 * `architecture-impact` opens no file and rides on `architect`, which `discovery` forces
 * onto a coding CLI. That is the finding the routing section exists for, and it is the one
 * the page has to be able to draw.
 */
const GLOBAL_CONFIG = `runners:
  claude:
    type: claude-code-cli
  local:
    type: openai-compatible
    baseUrl: http://127.0.0.1:8080/v1
  spare:
    type: codex-cli
roles:
  architect:
    runner: claude
    effort: high
`;

let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function serve(globalConfig = GLOBAL_CONFIG, projectConfig = PROJECT_CONFIG) {
  const fs = new InMemoryFileSystem();
  fs.seed('/repo/.agent-flow/config.yaml', projectConfig);
  fs.seed('/home/.agent-flow/config.yaml', globalConfig);

  for (const name of [
    'discovery',
    'architecture-impact',
    'sdd',
    'planning',
    'plan-review',
    'code-review',
    'verification',
    'final-review',
  ]) {
    fs.seed(
      `/install/prompts/${name}.md`,
      `---\npermissions: read-only\noutputFormat: markdown\nrequiredVars: [repositoryMap]\n---\n\n# ${name}\n`,
    );
  }
  // The two that read the repository, declared the way the shipped prompts declare it.
  for (const name of ['discovery', 'implementation']) {
    fs.seed(
      `/install/prompts/${name}.md`,
      `---\npermissions: ${name === 'implementation' ? 'write' : 'read-only'}\nworkingDirectory: true\noutputFormat: ${name === 'implementation' ? 'json' : 'markdown'}\nrequiredVars: [repositoryMap]\n---\n\n# ${name}\n`,
    );
  }

  running = await buildServer({
    fs,
    clock: new FixedClock(),
    processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: 'v20.11.0' }),
    processHost: new FakeHost(),
    registry: registryOf([PROJECT]),
    globalConfigPath: '/home/.agent-flow/config.yaml',
    version: '0.1.0',
    host: '127.0.0.1',
    port: 4782,
    promptsDir: '/install/prompts',
    pollIntervalMs: 20,
  });

  return { fs, server: running };
}

describe('GET /api/v1/doctor', () => {
  it('answers with a verdict and the sections the terminal prints', async () => {
    const { server } = await serve();

    const response = await server.app.inject('/api/v1/doctor');
    const view = response.json<DoctorView>();

    expect(response.statusCode).toBe(200);
    expect(['OK', 'DEGRADED', 'FAIL']).toContain(view.status);
    expect(view.tools.map((tool) => tool.name)).toEqual(['node', 'git']);
    expect(view.capabilities.length).toBeGreaterThan(0);
    expect(view.runners.length).toBeGreaterThan(0);
    expect(view.stageRouting.map((row) => row.stage)).toEqual(
      expect.arrayContaining(['discovery', 'architecture-impact', 'implementation']),
    );
  });

  it('carries the routing finding as a field, not as a sentence', async () => {
    // The whole reason the computation left the CLI. A finding that existed only inside a
    // rendered line would be unreachable here, and the page would have to re-derive it —
    // which is the second-opinion defect this codebase keeps paying for.
    const { server } = await serve();

    const view = (await server.app.inject('/api/v1/doctor')).json<DoctorView>();
    const planning = view.stageRouting.find((row) => row.stage === 'planning');
    const discovery = view.stageRouting.find((row) => row.stage === 'discovery');

    expect(planning).toMatchObject({ runner: 'claude', readsRepository: false, overpowered: true });
    expect(discovery).toMatchObject({ readsRepository: true, overpowered: false });
  });

  it('names a runner that is configured and routed nowhere', async () => {
    const { server } = await serve();

    const view = (await server.app.inject('/api/v1/doctor')).json<DoctorView>();

    const unrouted = view.unusedRunners.map((runner) => runner.id);
    expect(unrouted).toEqual(expect.arrayContaining(['local', 'spare']));
    // And the control: the runner every role points at is not in the list.
    expect(unrouted).not.toContain('claude');
  });

  it('says it did not read the environment, so the page can qualify auth', async () => {
    // §93: the server reads no credential. A runner authenticated by `apiKeyEnv` answers
    // 401 to a health check made without its key and is reported `not configured`, and a
    // page that repeated that as a finding would send somebody to fix credentials that
    // are already in place.
    const { server } = await serve();

    const view = (await server.app.inject('/api/v1/doctor')).json<DoctorView>();

    expect(view.readsEnvironment).toBe(false);
  });

  it('never spends quota: the deep probe is not reachable from a browser', async () => {
    // A page refresh must not cost a model call. `--deep` stays an explicit act in a
    // terminal, exactly as `/runners/health` already decided.
    const { server } = await serve();

    const view = (await server.app.inject('/api/v1/doctor?deep=true')).json<DoctorView>();

    expect(view.probes).toEqual([]);
  });

  it('fails the verdict when a role has nowhere to run, and names the runner', async () => {
    // The positive control for the verdict: an `openai-compatible` endpoint cannot open a
    // file, so a role whose prompts read the repository cannot resolve to it — and that is
    // a configuration error, not a degradation, because the stage dies on contact.
    const { server } = await serve(`runners:
  local:
    type: openai-compatible
    baseUrl: http://127.0.0.1:8080/v1
roles:
  architect:
    runner: local
    effort: high
`);

    const view = (await server.app.inject('/api/v1/doctor')).json<DoctorView>();

    expect(view.status).toBe('FAIL');
    expect(view.unresolvableRoles).toContain('architect');
    expect(
      view.capabilities.find((entry) => entry.role === 'architect'),
    ).toMatchObject({ kind: 'unresolvable', runner: 'local' });
  });

  it('does not run the install probe unless it is asked for', async () => {
    // Found by opening the page, not by a unit test: the route ran the §8.4 probe — a
    // throwaway checkout plus the project's own install — before answering, and against a
    // large repository the browser's read deadline fired first. The screen said the
    // machine could not be diagnosed, which was true of nothing except the deadline.
    const { server } = await serve();

    const view = (await server.app.inject('/api/v1/doctor')).json<DoctorView>();

    expect(view.install).toEqual({ outcome: 'skipped', reason: 'not_requested' });
  });

  it('runs it when it is asked for', async () => {
    // The positive control: same route, one query parameter, and the probe reports a real
    // outcome rather than the decision not to run. This fixture is not a repository, so
    // the honest answer is that there was no HEAD to check out — which is still the probe
    // having run and having something to say.
    const { server } = await serve();

    const view = (await server.app.inject('/api/v1/doctor?install=true')).json<DoctorView>();

    expect(view.install.reason).not.toBe('not_requested');
  });

  describe('in a project the global config does not trust (FR-027)', () => {
    const LOOSENING = `${PROJECT_CONFIG}runners:\n  claude:\n    dangerouslySkipPermissions: true\n`;
    const NOTE = '`runners.claude.dangerouslySkipPermissions`';

    it('returns the refused loosening in notes, and the view keeps its shape', async () => {
      const baseline = (await (await serve()).server.app.inject('/api/v1/doctor')).json<DoctorView>();
      await running?.close();

      const { server } = await serve(GLOBAL_CONFIG, LOOSENING);
      const view = (await server.app.inject('/api/v1/doctor')).json<DoctorView>();

      expect(view.notes.filter((note) => note.includes(NOTE) && note.includes('trust.projectConfig'))).toHaveLength(1);
      // The note rides in `notes: string[]`; no field was added to carry it.
      expect(Object.keys(view).sort()).toEqual(Object.keys(baseline).sort());
    });

    it('positive control: returns no such note once the global list trusts the project', async () => {
      const { server } = await serve(`${GLOBAL_CONFIG}trust:\n  projectConfig: [/repo]\n`, LOOSENING);

      const view = (await server.app.inject('/api/v1/doctor')).json<DoctorView>();

      expect(view.notes.some((note) => note.includes(NOTE))).toBe(false);
    });
  });

  describe("the executor's command grants (FR-003, FR-004, FR-021, FR-022)", () => {
    const EXECUTORS = `${GLOBAL_CONFIG}  executors:
    trivial: { runner: claude }
    normal: { runner: claude }
    complex: { runner: claude }
`;
    const TRUSTED = `${EXECUTORS}trust:\n  projectConfig: [/repo]\n`;
    const DECLARING = `project:
  name: demo
  type: node
commands:
  lint: npm run lint
  test: 'eslint src/**/*.ts'
validationCommands:
  typecheck-deck: npm run typecheck:deck
`;
    const GRANTLESS = 'granted no tool beyond editing files';
    const executorOf = (view: DoctorView) => view.capabilities.find((entry) => entry.role === 'executor.normal');

    it('carries the declared lines on the write role of a trusted project, and no grantless note', async () => {
      const { server } = await serve(TRUSTED, DECLARING);

      const view = (await server.app.inject('/api/v1/doctor')).json<DoctorView>();

      expect(executorOf(view)?.commandGrants?.prefixes).toEqual(
        expect.arrayContaining(['npm run lint', 'npm run typecheck:deck']),
      );
      expect(executorOf(view)?.commandGrants?.any).toBe(false);
      expect(view.notes.some((note) => note.includes(GRANTLESS))).toBe(false);
      expect(view.notes).not.toContain(en.doctor.projectCommandsNotGranted);
    });

    it('carries no grant for the same project untrusted, the trust note and the grantless note', async () => {
      const { server } = await serve(EXECUTORS, DECLARING);

      const view = (await server.app.inject('/api/v1/doctor')).json<DoctorView>();

      expect(executorOf(view)?.commandGrants?.prefixes ?? []).not.toContain('npm run lint');
      expect(view.notes).toContain(en.doctor.projectCommandsNotGranted);
      expect(view.notes.some((note) => note.includes(GRANTLESS))).toBe(true);
    });

    it('gives an untrusted project declaring only validationCommands both notes', async () => {
      const { server } = await serve(
        EXECUTORS,
        'project:\n  name: demo\n  type: node\ncommands: {}\nvalidationCommands:\n  test-deck: npm run test:deck\n',
      );

      const view = (await server.app.inject('/api/v1/doctor')).json<DoctorView>();

      expect(view.notes).toContain(en.doctor.projectCommandsNotGranted);
      expect(view.notes.some((note) => note.includes(GRANTLESS))).toBe(true);
    });

    it('names the excluded line with its id and reason', async () => {
      const { server } = await serve(TRUSTED, DECLARING);

      const view = (await server.app.inject('/api/v1/doctor')).json<DoctorView>();

      expect(view.notes).toContain(
        en.doctor.declaredCommandNotGranted('test', 'eslint src/**/*.ts', en.doctor.grantExcludedWildcard),
      );
    });
  });

  it('refuses a project it does not know, rather than guessing one', async () => {
    const { server } = await serve();

    const response = await server.app.inject('/api/v1/doctor?projectId=nowhere');

    expect(response.statusCode).toBe(404);
  });
});
