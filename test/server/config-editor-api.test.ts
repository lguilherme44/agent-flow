import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, type RunningServer } from '../../src/server/server.js';
import { registryOf } from '../../src/server/project-registry.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import type { ConfigEditorView } from '../../src/contracts/index.js';

const WRITE_HEADERS = { 'x-agent-flow-client': 'test' } as const;
const PROJECT = { id: 'demo', name: 'demo', path: '/repo' };

let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function serve() {
  const fs = new InMemoryFileSystem();
  fs.seed('/repo/.agent-flow/config.yaml', 'project:\n  name: demo\n  type: node\n');
  running = await buildServer({
    fs,
    clock: new FixedClock(),
    processRunner: new FakeProcessRunner(),
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

describe('configuration editor HTTP API', () => {
  it('describes registered targets and never resolves environment secrets or unknown values', async () => {
    const { fs, server } = await serve();
    process.env['AF_EDITOR_TEST_TOKEN'] = 'resolved-secret-value';
    fs.seed(
      '/home/.agent-flow/config.yaml',
      'forge:\n  github:\n    tokenEnv: AF_EDITOR_TEST_TOKEN\nprivateBlob: top-secret-unknown\n',
    );

    const response = await server.app.inject('/api/v1/config/editor?scope=global');
    const raw = response.body;
    const view = response.json<ConfigEditorView>();

    expect(response.statusCode).toBe(200);
    expect(view.fields.find((field) => field.path.join('.') === 'forge.github.tokenEnv')).toMatchObject({
      explicitValue: 'AF_EDITOR_TEST_TOKEN',
      effectiveValue: 'AF_EDITOR_TEST_TOKEN',
    });
    const timeout = view.fields.find((field) => field.path.join('.') === 'roles.architect.timeoutSeconds');
    expect(timeout).toMatchObject({ effectiveValue: 900, origin: 'default', valueType: 'integer' });
    expect(Object.hasOwn(timeout ?? {}, 'explicitValue')).toBe(false);
    expect(view.dynamicFields.map((field) => field.path.join('.'))).toEqual(expect.arrayContaining([
      'runners.*.type', 'teams.*.members.*.runner', 'roles.architect.stages.*.runner',
      'fallback.roles.*.runner', 'quality.gates.*.category',
    ]));
    expect(raw).not.toContain('resolved-secret-value');
    expect(raw).not.toContain('top-secret-unknown');
    expect(view.unknownKeys).toContain('privateBlob');
    delete process.env['AF_EDITOR_TEST_TOKEN'];
  });

  it('rejects malformed and unknown project targets without touching project files', async () => {
    const { fs, server } = await serve();
    const before = await fs.readFile('/repo/.agent-flow/config.yaml');

    const malformed = await server.app.inject('/api/v1/config/editor?scope=project&projectId=..%2Fetc');
    const missing = await server.app.inject('/api/v1/config/editor?scope=project&projectId=nowhere');

    expect(malformed.statusCode).toBe(400);
    expect(missing.statusCode).toBe(404);
    expect(await fs.readFile('/repo/.agent-flow/config.yaml')).toBe(before);
  });

  it('applies a valid scoped operation and leaves the legacy config endpoint compatible', async () => {
    const { fs, server } = await serve();
    const view = (
      await server.app.inject('/api/v1/config/editor?scope=project&projectId=demo')
    ).json<ConfigEditorView>();

    const response = await server.app.inject({
      method: 'PATCH',
      url: '/api/v1/config/editor?scope=project&projectId=demo',
      headers: WRITE_HEADERS,
      payload: {
        expectedRevision: view.revision,
        operations: [{ kind: 'set', path: ['retry', 'maxAttempts'], value: 4 }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(await fs.readFile('/repo/.agent-flow/config.yaml')).toContain('maxAttempts: 4');
    expect((await server.app.inject('/api/v1/config?projectId=demo')).statusCode).toBe(200);
  });

  it('returns 422 diagnostics and keeps the source byte-identical for an invalid candidate', async () => {
    const { fs, server } = await serve();
    const before = await fs.readFile('/repo/.agent-flow/config.yaml');
    const view = (
      await server.app.inject('/api/v1/config/editor?scope=project&projectId=demo')
    ).json<ConfigEditorView>();

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/config/editor/validate?scope=project&projectId=demo',
      headers: WRITE_HEADERS,
      payload: { operations: [{ kind: 'set', path: ['ui', 'workspaceDepth'], value: 4 }] },
    });
    const apply = await server.app.inject({
      method: 'PATCH',
      url: '/api/v1/config/editor?scope=project&projectId=demo',
      headers: WRITE_HEADERS,
      payload: {
        expectedRevision: view.revision,
        operations: [{ kind: 'set', path: ['ui', 'workspaceDepth'], value: 4 }],
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ diagnostics: Array<{ code: string }> }>().diagnostics[0]?.code).toBe('global_only');
    expect(apply.statusCode).toBe(422);
    expect(await fs.readFile('/repo/.agent-flow/config.yaml')).toBe(before);
  });

  it('returns 409 with a fresh view instead of overwriting a stale revision', async () => {
    const { fs, server } = await serve();
    const stale = (
      await server.app.inject('/api/v1/config/editor?scope=global')
    ).json<ConfigEditorView>();
    fs.seed('/home/.agent-flow/config.yaml', 'git:\n  useWorktrees: true\n');

    const response = await server.app.inject({
      method: 'PATCH',
      url: '/api/v1/config/editor?scope=global',
      headers: WRITE_HEADERS,
      payload: {
        expectedRevision: stale.revision,
        operations: [{ kind: 'set', path: ['git', 'useWorktrees'], value: false }],
      },
    });
    const conflict = response.json<{ error: string; view: ConfigEditorView }>();

    expect(response.statusCode).toBe(409);
    expect(conflict.error).toBe('revision_conflict');
    expect(conflict.view.revision).not.toBe(stale.revision);
    expect(conflict.view.fields.find((field) => field.path.join('.') === 'git.useWorktrees')?.explicitValue).toBe(true);
    expect(await fs.readFile('/home/.agent-flow/config.yaml')).toContain('useWorktrees: true');
  });

  it('enforces Host and Origin before configuration reads and writes', async () => {
    const { server } = await serve();

    const hostileHost = await server.app.inject({
      method: 'GET',
      url: '/api/v1/config/editor?scope=global',
      headers: { host: 'attacker.example' },
    });
    const hostileOrigin = await server.app.inject({
      method: 'POST',
      url: '/api/v1/config/editor/validate?scope=global',
      headers: { host: '127.0.0.1:4782', origin: 'http://attacker.example' },
      payload: { operations: [{ kind: 'set', path: ['retry', 'maxAttempts'], value: 4 }] },
    });

    expect(hostileHost.statusCode).toBe(403);
    expect(hostileOrigin.statusCode).toBe(403);
  });

  it('maps atomic filesystem failures to a safe 500 response', async () => {
    const { fs, server } = await serve();
    const view = (
      await server.app.inject('/api/v1/config/editor?scope=global')
    ).json<ConfigEditorView>();
    fs.failWrite = () => new Error('disk path /private/operator and stack secret');

    const response = await server.app.inject({
      method: 'PATCH',
      url: '/api/v1/config/editor?scope=global',
      headers: WRITE_HEADERS,
      payload: {
        expectedRevision: view.revision,
        operations: [{ kind: 'set', path: ['retry', 'maxAttempts'], value: 4 }],
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json<{ error: string }>().error).toBe('config_io_error');
    expect(response.body).not.toMatch(/private|stack secret/i);
  });
});
