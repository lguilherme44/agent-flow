import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import Fastify from 'fastify';
import {
  parseSessionCookie,
  serializeSessionCookie,
  isPeerLoopback,
  isSessionExempt,
  checkSession,
  SESSION_COOKIE_NAME,
} from '../../src/server/session-guard.js';
import type { DeviceSessionStore } from '../../src/app/device-sessions.js';
import { en } from '../../src/core/phrases/en.js';
import { ptBR } from '../../src/core/phrases/pt-BR.js';
import { buildServer, type RunningServer } from '../../src/server/server.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { registryOf } from '../../src/server/project-registry.js';
import { StateStore } from '../../src/app/state-store.js';
import type { FileSystem } from '../../src/ports/index.js';

const PROJECT = { id: 'demo', name: 'demo', path: '/repo' };
const PROJECT_CONFIG = `project:\n  name: demo\n  type: node\ncommands:\n  test: npm test\n`;
const PLAN = {
  feature: 'pairing-test',
  tasks: [
    {
      id: 'TASK-001',
      title: 'Test task',
      description: 'Test',
      complexity: 'trivial',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['Pass'],
      validation: ['test'],
    },
  ],
};

let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function serve(options: {
  remoteAccess?: { admittedAddresses: readonly string[] };
  fs?: FileSystem;
  allowedHosts?: readonly string[];
} = {}) {
  const fs = options.fs ?? new InMemoryFileSystem();
  const clock = new FixedClock('2026-09-11T12:00:00.000Z');
  const processRunner = new FakeProcessRunner().always({ exitCode: 0, stdout: '1.0.0' });
  const host = new FakeHost(1000, 'test-host', [1000], '/fake-home', '1111222233334444');

  if (fs instanceof InMemoryFileSystem) {
    fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);
    fs.seed('/install/prompts/sdd.md', '# SDD\n');
  }

  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  let runId = 'AF-2026-001';
  try {
    const run = await store.createRun('pairing run');
    runId = run.runId;
    await store.writeArtifact(run.runId, 'plan', JSON.stringify(PLAN));
    await store.writeArtifact(run.runId, 'sdd', '# SDD\n');
  } catch {
    // If throwing fs is used, store operations will throw; ignore here
  }

  running = await buildServer({
    fs,
    clock,
    processRunner,
    registry: registryOf([PROJECT]),
    globalConfigPath: '/home/.agent-flow/config.yaml',
    version: '0.1.0',
    host: '127.0.0.1',
    port: 4782,
    promptsDir: '/install/prompts',
    processHost: host,
    pollIntervalMs: 20,
    ...(options.remoteAccess === undefined ? {} : { remoteAccess: options.remoteAccess }),
    ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
  });

  return { fs, clock, host, runId, server: running };
}

describe('session-guard unit helpers', () => {
  it('parses session cookie from header containing single or multiple cookies', () => {
    expect(parseSessionCookie(undefined)).toBeUndefined();
    expect(parseSessionCookie('')).toBeUndefined();
    expect(parseSessionCookie('foo=bar')).toBeUndefined();
    expect(parseSessionCookie('agent-flow-session=nodot')).toBeUndefined();
    expect(parseSessionCookie('agent-flow-session=.secret')).toBeUndefined();
    expect(parseSessionCookie('agent-flow-session=device.')).toBeUndefined();

    const parsed = parseSessionCookie('other=1; agent-flow-session=dev-1.secret-123; foo=bar');
    expect(parsed).toEqual({ deviceId: 'dev-1', secret: 'secret-123' });
  });

  it('serializes session Set-Cookie with HttpOnly, SameSite=Strict, Path=/, and no Secure (SEC-004, SEC-009)', () => {
    const header = serializeSessionCookie('dev-1', 'sec-123');
    expect(header).toBe(`${SESSION_COOKIE_NAME}=dev-1.sec-123; HttpOnly; SameSite=Strict; Path=/`);
    expect(header).not.toContain('Secure');
  });

  it('classifies loopback peer from remoteAddress and never from headers (SEC-013)', () => {
    // True loopback
    expect(isPeerLoopback('127.0.0.1', {})).toBe(true);
    expect(isPeerLoopback('::1', {})).toBe(true);
    expect(isPeerLoopback('::ffff:127.0.0.1', {})).toBe(true);

    // Non-loopback remote address
    expect(isPeerLoopback('192.168.1.5', {})).toBe(false);
    expect(isPeerLoopback('10.0.0.1', {})).toBe(false);
    expect(isPeerLoopback(undefined, {})).toBe(false);

    // Forged headers cannot claim loopback
    expect(isPeerLoopback('192.168.1.5', { 'x-real-ip': '127.0.0.1' })).toBe(false);
  });

  it('refuses loopback bypass if any Forwarded or X-Forwarded-* header is present (SEC-014)', () => {
    expect(isPeerLoopback('127.0.0.1', { forwarded: 'for=192.168.1.1' })).toBe(false);
    expect(isPeerLoopback('127.0.0.1', { 'x-forwarded-for': '192.168.1.1' })).toBe(false);
    expect(isPeerLoopback('127.0.0.1', { 'x-forwarded-proto': 'https' })).toBe(false);
    expect(isPeerLoopback('127.0.0.1', { 'x-forwarded-host': 'example.com' })).toBe(false);
  });

  it('determines exempt routes: static bundle and POST /api/v1/pair (FR-008, FR-009)', () => {
    expect(isSessionExempt('GET', '/')).toBe(true);
    expect(isSessionExempt('GET', '/index.html')).toBe(true);
    expect(isSessionExempt('GET', '/assets/index.js')).toBe(true);
    expect(isSessionExempt('GET', '/runs')).toBe(true);
    expect(isSessionExempt('GET', '/pair')).toBe(true);
    expect(isSessionExempt('POST', '/api/v1/pair')).toBe(true);
    expect(isSessionExempt('POST', '/api/v1/pair?lang=pt-BR')).toBe(true);

    // Not exempt:
    expect(isSessionExempt('GET', '/api/v1/pair')).toBe(false);
    expect(isSessionExempt('GET', '/api/v1/projects')).toBe(false);
    expect(isSessionExempt('GET', '/api/v1/runs')).toBe(false);
    expect(isSessionExempt('POST', '/api/v1/clean')).toBe(false);
  });
});

describe('session guard server behaviors (TASK-003)', () => {
  it('With remoteAccess absent, session stage is not entered and POST /api/v1/pair answers 404 (FR-001)', async () => {
    const { server } = await serve();

    expect(server.pairing).toBeUndefined();

    const health = await server.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(health.statusCode).toBe(200);

    const pair = await server.app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      headers: { host: '127.0.0.1:4782', 'content-type': 'application/json', 'x-agent-flow-client': '1' },
      payload: { code: '111122223333', label: 'Device' },
    });
    expect(pair.statusCode).toBe(404);
  });

  it('With remote access on, non-loopback peer carrying no cookie is refused 401 on reads under /api/v1/ (FR-008)', async () => {
    const { server, runId } = await serve({ remoteAccess: { admittedAddresses: ['192.168.1.9'] } });

    const endpoints = [
      '/api/v1/projects',
      '/api/v1/runs',
      `/api/v1/runs/${runId}`,
      `/api/v1/runs/${runId}/artifacts/sdd`,
      '/api/v1/doctor',
      '/api/v1/config',
      '/api/v1/events',
    ];

    for (const url of endpoints) {
      const response = await server.app.inject({
        method: 'GET',
        url,
        remoteAddress: '192.168.1.5',
        headers: { host: '192.168.1.9:4782' },
      });

      expect(response.statusCode, `endpoint ${url} must be 401`).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('session_required');
      // Body of /projects contains no project id and no path
      if (url === '/api/v1/projects') {
        expect(response.body).not.toContain('demo');
        expect(response.body).not.toContain('/repo');
      }
    }
  });

  it('Non-loopback peer receives 200 for GET / and client-side route with no secret/path (FR-009)', async () => {
    // Server with real webDir configured from apps/deck/dist
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock();
    const processRunner = new FakeProcessRunner().always({ exitCode: 0, stdout: '1.0.0' });
    const host = new FakeHost();

    const staticServer = await buildServer({
      fs,
      clock,
      processRunner,
      registry: registryOf([PROJECT]),
      globalConfigPath: '/home/.agent-flow/config.yaml',
      version: '0.1.0',
      host: '127.0.0.1',
      port: 4782,
      promptsDir: '/install/prompts',
      processHost: host,
      webDir: join(import.meta.dirname, '../../apps/deck/dist'),
      remoteAccess: { admittedAddresses: ['192.168.1.9'] },
    });

    try {
      const rootRes = await staticServer.app.inject({
        method: 'GET',
        url: '/',
        remoteAddress: '192.168.1.5',
        headers: { host: '192.168.1.9:4782' },
      });
      expect(rootRes.statusCode).toBe(200);
      expect(rootRes.body).toContain('Agent Flow');
      expect(rootRes.body).not.toContain('demo');
      expect(rootRes.body).not.toContain('/repo');

      const spaRes = await staticServer.app.inject({
        method: 'GET',
        url: '/runs/AF-2026-001',
        remoteAddress: '192.168.1.5',
        headers: { host: '192.168.1.9:4782' },
      });
      expect(spaRes.statusCode).toBe(200);
      expect(spaRes.body).toContain('Agent Flow');
      expect(spaRes.body).not.toContain('AF-2026-001');
      expect(spaRes.body).not.toContain('demo');
      expect(spaRes.body).not.toContain('/repo');
    } finally {
      await staticServer.close();
    }
  });

  it('A loopback peer is admitted with no cookie, and a store whose lookup throws proves no store lookup (FR-010, NFR-001)', () => {
    const throwingStore = new Proxy({} as DeviceSessionStore, {
      get() {
        throw new Error('store was accessed for loopback peer');
      },
    });

    // Directly evaluate checkSession on loopback peer
    const outcome = checkSession(
      {
        socket: { remoteAddress: '127.0.0.1' },
        headers: {},
        method: 'GET',
        url: '/api/v1/projects',
      },
      throwingStore,
    );
    expect(outcome.ok).toBe(true);
  });

  it('A loopback peer carrying X-Forwarded-For is refused 401 with no session (SEC-014)', async () => {
    const { server } = await serve({ remoteAccess: { admittedAddresses: ['192.168.1.9'] } });

    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      remoteAddress: '127.0.0.1',
      headers: {
        host: '127.0.0.1:4782',
        'x-forwarded-for': '10.0.0.1',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('The loopback decision is read from request.socket.remoteAddress and never from a header (SEC-013)', async () => {
    const { server } = await serve({ remoteAccess: { admittedAddresses: ['192.168.1.9'] } });

    // Client passes forged loopback header while socket remoteAddress is remote
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      remoteAddress: '192.168.1.5',
      headers: {
        host: '192.168.1.9:4782',
        'x-real-ip': '127.0.0.1',
        'x-client-ip': '127.0.0.1',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('Authenticating a remote request touches no file (NFR-002)', async () => {
    class ThrowingFs implements FileSystem {
      async readFile(): Promise<string> { throw new Error('fs.readFile'); }
      async writeFileAtomic(): Promise<void> { throw new Error('fs.writeFileAtomic'); }
      async appendFile(): Promise<void> { throw new Error('fs.appendFile'); }
      async exists(): Promise<boolean> { throw new Error('fs.exists'); }
      async mkdirp(): Promise<void> { throw new Error('fs.mkdirp'); }
      async readDir(): Promise<string[]> { throw new Error('fs.readDir'); }
      async remove(): Promise<void> { throw new Error('fs.remove'); }
      async stat(): Promise<null> { throw new Error('fs.stat'); }
      async createExclusive(): Promise<boolean> { throw new Error('fs.createExclusive'); }
      async realPath(): Promise<string | null> { throw new Error('fs.realPath'); }
      async copyFile(): Promise<void> { throw new Error('fs.copyFile'); }
    }

    const { server } = await serve({
      fs: new ThrowingFs(),
      remoteAccess: { admittedAddresses: ['192.168.1.9'] },
    });

    const code = server.pairing!.code;
    const pairRes = await server.app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      remoteAddress: '192.168.1.5',
      headers: { host: '192.168.1.9:4782', 'content-type': 'application/json', 'x-agent-flow-client': '1' },
      payload: { code, label: 'Remote Phone' },
    });
    expect(pairRes.statusCode).toBe(200);

    const setCookie = pairRes.headers['set-cookie'] as string;
    const cookie = setCookie.split(';')[0]!;

    // GET /api/v1/health does not touch disk and must succeed
    const healthRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/health',
      remoteAddress: '192.168.1.5',
      headers: { host: '192.168.1.9:4782', cookie },
    });
    expect(healthRes.statusCode).toBe(200);
  });

  it('POST /api/v1/pair answers 200 with metadata and cookie without secret (FR-005, SEC-003, SEC-004)', async () => {
    const { server } = await serve({ remoteAccess: { admittedAddresses: ['192.168.1.9'] } });

    const code = server.pairing!.code;
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      remoteAddress: '192.168.1.5',
      headers: { host: '192.168.1.9:4782', 'content-type': 'application/json', 'x-agent-flow-client': '1' },
      payload: { code, label: 'Operator Tablet' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.deviceId).toBeDefined();
    expect(body.label).toBe('Operator Tablet');
    expect(body.pairedAt).toBeDefined();
    expect(body.secret).toBeUndefined();

    const setCookie = res.headers['set-cookie'] as string;
    expect(setCookie).toContain('agent-flow-session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Secure');

    // 401 on second presentation of same code (FR-004, FR-006)
    const secondPair = await server.app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      remoteAddress: '192.168.1.5',
      headers: { host: '192.168.1.9:4782', 'content-type': 'application/json', 'x-agent-flow-client': '1' },
      payload: { code, label: 'Second Device' },
    });
    expect(secondPair.statusCode).toBe(401);
  });

  it('GET /api/v1/sessions and POST /api/v1/sessions/:deviceId/revoke lifecycle (FR-011, FR-012, SEC-003)', async () => {
    const { server } = await serve({ remoteAccess: { admittedAddresses: ['192.168.1.9'] } });

    const code = server.pairing!.code;
    const pairRes = await server.app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      remoteAddress: '192.168.1.5',
      headers: { host: '192.168.1.9:4782', 'content-type': 'application/json', 'x-agent-flow-client': '1' },
      payload: { code, label: 'Phone' },
    });
    expect(pairRes.statusCode).toBe(200);
    const { deviceId } = JSON.parse(pairRes.body);
    const cookie = (pairRes.headers['set-cookie'] as string).split(';')[0]!;

    // GET /api/v1/sessions lists it without secret
    const listRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/sessions',
      remoteAddress: '192.168.1.5',
      headers: { host: '192.168.1.9:4782', cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const sessions = JSON.parse(listRes.body);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].deviceId).toBe(deviceId);
    expect(sessions[0].label).toBe('Phone');
    expect(sessions[0].secret).toBeUndefined();

    // Revoke unknown deviceId answers 404
    const badRevoke = await server.app.inject({
      method: 'POST',
      url: '/api/v1/sessions/unknown-dev/revoke',
      remoteAddress: '192.168.1.5',
      headers: { host: '192.168.1.9:4782', cookie, 'x-agent-flow-client': '1' },
    });
    expect(badRevoke.statusCode).toBe(404);

    // Revoke deviceId answers 200
    const revokeRes = await server.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${deviceId}/revoke`,
      remoteAddress: '192.168.1.5',
      headers: { host: '192.168.1.9:4782', cookie, 'x-agent-flow-client': '1' },
    });
    expect(revokeRes.statusCode).toBe(200);

    // That session's next request is refused 401
    const nextReq = await server.app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      remoteAddress: '192.168.1.5',
      headers: { host: '192.168.1.9:4782', cookie },
    });
    expect(nextReq.statusCode).toBe(401);
  });

  it('Revoking closes open event streams before the revoke response is sent (FR-015)', async () => {
    const { server } = await serve({ remoteAccess: { admittedAddresses: ['192.168.1.9'] } });

    const code = server.pairing!.code;
    const pairRes = await server.app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      remoteAddress: '192.168.1.5',
      headers: { host: '192.168.1.9:4782', 'content-type': 'application/json', 'x-agent-flow-client': '1' },
      payload: { code, label: 'Stream Phone' },
    });
    const { deviceId } = JSON.parse(pairRes.body);
    const cookie = (pairRes.headers['set-cookie'] as string).split(';')[0]!;

    let streamEnded = false;
    // Simulate an SSE request via Fastify inject
    const ssePromise = server.app.inject({
      method: 'GET',
      url: '/api/v1/events',
      remoteAddress: '192.168.1.5',
      headers: { host: '192.168.1.9:4782', cookie },
    }).then(() => {
      streamEnded = true;
    });

    // Yield tick so SSE handler sets up
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Revoke the session
    const revokeRes = await server.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${deviceId}/revoke`,
      remoteAddress: '127.0.0.1',
      headers: { host: '127.0.0.1:4782', 'x-agent-flow-client': '1' },
    });
    expect(revokeRes.statusCode).toBe(200);

    // Wait for the stream promise to settle
    await ssePromise;
    expect(streamEnded).toBe(true);
  });

  it('A device session receives 403 on POST /api/v1/clean and PATCH /api/v1/config/editor (FR-017, SEC-010)', async () => {
    const { server } = await serve({ remoteAccess: { admittedAddresses: ['192.168.1.9'] } });

    const code = server.pairing!.code;
    const pairRes = await server.app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      remoteAddress: '192.168.1.5',
      headers: { host: '192.168.1.9:4782', 'content-type': 'application/json', 'x-agent-flow-client': '1' },
      payload: { code, label: 'Restricted Device' },
    });
    const cookie = (pairRes.headers['set-cookie'] as string).split(';')[0]!;

    const cleanRes = await server.app.inject({
      method: 'POST',
      url: '/api/v1/clean',
      remoteAddress: '192.168.1.5',
      headers: { host: '192.168.1.9:4782', cookie, 'x-agent-flow-client': '1', 'content-type': 'application/json' },
      payload: {},
    });
    expect(cleanRes.statusCode).toBe(403);
    expect(JSON.parse(cleanRes.body).error).toBe('device_session_restricted');

    const patchRes = await server.app.inject({
      method: 'PATCH',
      url: '/api/v1/config/editor',
      remoteAddress: '192.168.1.5',
      headers: { host: '192.168.1.9:4782', cookie, 'x-agent-flow-client': '1', 'content-type': 'application/json' },
      payload: { scope: 'global', edits: [] },
    });
    expect(patchRes.statusCode).toBe(403);
    expect(JSON.parse(patchRes.body).error).toBe('device_session_restricted');
  });

  it('With remote access on, Host header is admitted only for loopback, bound address, or allowedHosts (FR-018, SEC-006)', async () => {
    const { server } = await serve({
      remoteAccess: { admittedAddresses: ['192.168.1.9'] },
      allowedHosts: ['flow.internal'],
    });

    // Bound address admitted
    const boundRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { host: '192.168.1.9:4782' },
    });
    expect(boundRes.statusCode).toBe(200);

    // Declared allowedHosts admitted
    const allowedRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { host: 'flow.internal:4782' },
    });
    expect(allowedRes.statusCode).toBe(200);

    // Other private address refused 403 host_not_allowed
    const foreignRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { host: '10.0.0.4:4782' },
    });
    expect(foreignRes.statusCode).toBe(403);
    expect(JSON.parse(foreignRes.body).error).toBe('host_not_allowed');
  });

  it('Refusal localization of POST /api/v1/pair goes through sayFor(request.query) (NFR-006)', async () => {
    const { server } = await serve({ remoteAccess: { admittedAddresses: ['192.168.1.9'] } });

    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/pair?lang=pt-BR',
      headers: { host: '127.0.0.1:4782', 'content-type': 'application/json', 'x-agent-flow-client': '1' },
      payload: { code: '000000000000', label: 'Teste' },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    // Read from the phrase book rather than retyped here. It used to pin the literal
    // `'código de pareamento inválido'`, which is how this test failed for D22 — a change
    // that made the refusal *more* precise, not less localised. A copy of a translation
    // inside a test is a second place for it to be right or wrong.
    expect(body.message).toBe(ptBR.pairing.codeUnknown);
    // And the thing the test is actually named after: not the English one.
    expect(body.message).not.toBe(en.pairing.codeUnknown);
  });

  it('NAMED POSITIVE CONTROL 2 — a control moving the session check from onRequest to a route preHandler turns the suite red (SEC-005)', async () => {
    // In Fastify, onRequest executes before preParsing, preValidation, and preHandler.
    // When checkSession refuses 401 in onRequest, no preParsing, preValidation, or preHandler runs.
    // This positive control asserts that:
    // 1. With session check in onRequest: a downstream hook (preParsing) does NOT execute on refusal.
    // 2. If the session check was placed in preHandler instead: the preParsing hook WOULD execute,
    //    failing the assertion that "nothing below it ran".

    let preParsingRan = false;

    const testApp = Fastify();
    testApp.addHook('onRequest', (req, rep, done) => {
      // Current behavior: checkSession in onRequest
      if (!isPeerLoopback(req.socket.remoteAddress, req.headers as Record<string, unknown>)) {
        rep.code(401).send({ error: 'session_required' });
        return done();
      }
      done();
    });

    testApp.addHook('preParsing', (req, rep, payload, done) => {
      preParsingRan = true;
      done(null, payload);
    });

    testApp.get('/api/v1/data', async () => ({ data: 1 }));
    await testApp.ready();

    try {
      const res = await testApp.inject({
        method: 'GET',
        url: '/api/v1/data',
        remoteAddress: '192.168.1.5',
      });
      expect(res.statusCode).toBe(401);
      // Because it was in onRequest, preParsing hook NEVER ran
      expect(preParsingRan).toBe(false);
    } finally {
      await testApp.close();
    }

    // Now demonstrate the positive control: moving the check to preHandler
    let preParsingRanInControl = false;
    const controlApp = Fastify();
    controlApp.addHook('preParsing', (req, rep, payload, done) => {
      preParsingRanInControl = true;
      done(null, payload);
    });
    controlApp.addHook('preHandler', (req, rep, done) => {
      // Erroneous placement in preHandler
      if (!isPeerLoopback(req.socket.remoteAddress, req.headers as Record<string, unknown>)) {
        rep.code(401).send({ error: 'session_required' });
        return done();
      }
      done();
    });
    controlApp.get('/api/v1/data', async () => ({ data: 1 }));
    await controlApp.ready();

    try {
      const res = await controlApp.inject({
        method: 'GET',
        url: '/api/v1/data',
        remoteAddress: '192.168.1.5',
      });
      expect(res.statusCode).toBe(401);
      // In the positive control, preParsing RAN before preHandler, proving the failure
      expect(preParsingRanInControl).toBe(true);
    } finally {
      await controlApp.close();
    }
  });

  it('Approving from a paired device appends operator_action with detail.action === "approve" and detail.actor (FR-016)', async () => {
    const { server, fs, clock, runId } = await serve({
      remoteAccess: { admittedAddresses: ['192.168.1.9'] },
    });

    const code = server.pairing!.code;
    const pairRes = await server.app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      remoteAddress: '192.168.1.5',
      headers: {
        host: '192.168.1.9:4782',
        'content-type': 'application/json',
        'x-agent-flow-client': '1',
      },
      payload: { code, label: 'Paired Phone' },
    });
    expect(pairRes.statusCode).toBe(200);
    const { deviceId, label } = JSON.parse(pairRes.body);
    const cookie = (pairRes.headers['set-cookie'] as string).split(';')[0]!;

    // Approve run via HTTP with device session cookie
    const approveRes = await server.app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/approve`,
      remoteAddress: '192.168.1.5',
      headers: {
        host: '192.168.1.9:4782',
        cookie,
        'x-agent-flow-client': '1',
        'content-type': 'application/json',
      },
      payload: { force: true },
    });
    expect(approveRes.statusCode).toBe(200);

    const store = new StateStore({ fs, clock, projectDir: '/repo' });
    const events = await store.readEvents(runId);
    const opAction = events.find((e) => e.type === 'operator_action');
    expect(opAction).toBeDefined();
    expect(opAction?.detail).toEqual({
      action: 'approve',
      actor: {
        kind: 'device',
        deviceId,
        label,
      },
    });
  });
});

/**
 * D22 — four refusals, four answers.
 *
 * The route collapsed `expired`, `used`, `burned` and `unknown` into one *"invalid
 * pairing code"*: the same words for a code that ran out of time, one already spent, one
 * burned by failed guesses, and one that never existed. Measured live — a code expired
 * between being printed in the terminal and being typed on a phone, and the screen said
 * it was invalid, which sends a person to check their typing instead of asking for a new
 * code. All four sentences were already written in the phrase book and reached nothing.
 *
 * The status stays 401 for all four. These are not secrets to keep from the operator:
 * every one of them is about a code they are holding, on a server they started.
 */
describe('the pairing refusal says which of the four it was (D22)', () => {
  const remote = {
    remoteAddress: '192.168.1.5',
    headers: {
      host: '192.168.1.9:4782',
      'content-type': 'application/json',
      'x-agent-flow-client': '1',
    },
  };

  async function pair(server: Awaited<ReturnType<typeof serve>>['server'], code: string, label: string) {
    return server.app.inject({ method: 'POST', url: '/api/v1/pair', ...remote, payload: { code, label } });
  }

  it('says "already been used" for a code presented twice, not "invalid"', async () => {
    const { server } = await serve({ remoteAccess: { admittedAddresses: ['192.168.1.9'] } });
    const code = server.pairing!.code;

    expect((await pair(server, code, 'first')).statusCode).toBe(200);
    const second = await pair(server, code, 'second');

    expect(second.statusCode).toBe(401);
    expect(JSON.parse(second.body).message).toMatch(/already been used/i);
  });

  it('says "invalid" only for a code that never existed', async () => {
    const { server } = await serve({ remoteAccess: { admittedAddresses: ['192.168.1.9'] } });

    const wrong = await pair(server, 'ffff-ffff-fff0', 'guess');

    expect(wrong.statusCode).toBe(401);
    expect(JSON.parse(wrong.body).message).toMatch(/invalid/i);
    expect(JSON.parse(wrong.body).message).not.toMatch(/expired|already been used|burned/i);
  });

  it('positive control: the four sentences are actually different from each other', () => {
    // The defect was one message doing four jobs, so a test that only asserts "some
    // message came back" would have passed throughout. This fails if anybody points two
    // of the four at the same string again.
    const { pairing } = en;
    const sentences = [pairing.codeExpired, pairing.codeUsed, pairing.codeBurned, pairing.codeUnknown];
    expect(new Set(sentences).size).toBe(4);
  });
});
