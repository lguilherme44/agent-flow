import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { buildServer, type RunningServer } from '../../src/server/server.js';
import { registryOf } from '../../src/server/project-registry.js';
import { StateStore } from '../../src/app/state-store.js';
import {
  CLIENT_HEADER,
  checkHost,
  checkWrite,
  hostnameOf,
  isAddressLiteral,
  isWriteMethod,
} from '../../src/server/request-guard.js';
import type { ActionErrorView } from '../../src/contracts/index.js';

/**
 * PRI-05 — who may talk to the local control plane.
 *
 * **This suite exists because the answer used to be "anyone".** Measured against the
 * server before the guard, from `Origin: https://evil.example`:
 *
 * ```
 * POST /api/v1/runs/:id/start   (no body)  →  202  {"status":"running"}
 * ```
 *
 * A bodyless `POST` is a CORS simple request, so no preflight protects it; the browser
 * sends it and withholds only the response. `start` spawns coding agents with write
 * permission inside the operator's repository. Every server case below is that exact
 * request, and asserts the number that must replace 202.
 */

const PROJECT_CONFIG = `project:\n  name: demo\n  type: node\ncommands:\n  test: npm test\n`;

const PLAN = {
  feature: 'f',
  tasks: [
    {
      id: 'TASK-001',
      title: 't',
      description: 'd',
      complexity: 'trivial',
      risk: 'low',
      dependencies: [],
      requirements: [],
      acceptanceCriteria: ['ok'],
      validation: ['test'],
    },
  ],
};

let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function serve(options: { allowedHosts?: readonly string[] } = {}) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const processRunner = new FakeProcessRunner().always({ exitCode: 0, stdout: '1.0.0' });

  fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);
  for (const name of [
    'discovery',
    'architecture-impact',
    'sdd',
    'planning',
    'plan-review',
    'verification',
    'final-review',
  ]) {
    fs.seed(
      `/install/prompts/${name}.md`,
      `---\npermissions: read-only\noutputFormat: markdown\nrequiredVars: [repositoryMap]\n---\n\n# ${name}\n`,
    );
  }
  fs.seed(
    '/install/prompts/implementation.md',
    '---\npermissions: write\noutputFormat: json\nrequiredVars: [task, sdd]\n---\n\n# implementation\n',
  );

  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const run = await store.createRun('x');
  await store.writeArtifact(run.runId, 'plan', JSON.stringify(PLAN, null, 2));
  await store.writeArtifact(run.runId, 'sdd', '# SDD\n');
  await store.updateRun(run.runId, (state) => ({
    ...state,
    status: 'waiting_for_approval',
    tasks: [{ id: 'TASK-001', state: 'queued', attempts: 0, infrastructureFailures: 0 }],
  }));

  running = await buildServer({
    fs,
    clock,
    processRunner,
    registry: registryOf([{ id: 'demo', name: 'demo', path: '/repo' }]),
    globalConfigPath: '/home/.agent-flow/config.yaml',
    version: '0.1.0',
    host: '127.0.0.1',
    port: 4782,
    promptsDir: '/install/prompts',
    processHost: new FakeHost(),
    pollIntervalMs: 20,
    ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
  });

  return { server: running, run, store, fs };
}

const START = (runId: string): string => `/api/v1/runs/${runId}/start?projectId=demo`;

describe('hostnameOf — the authority, without its port', () => {
  it.each([
    ['127.0.0.1:4782', '127.0.0.1'],
    ['127.0.0.1', '127.0.0.1'],
    ['localhost:4782', 'localhost'],
    ['LOCALHOST', 'localhost'],
    ['[::1]:4782', '::1'],
    ['[::1]', '::1'],
    ['[fe80::1%25eth0]:80', 'fe80::1%25eth0'],
    ['192.168.1.9:4782', '192.168.1.9'],
    ['evil.example:4782', 'evil.example'],
  ])('reads %s as %s', (header, expected) => {
    expect(hostnameOf(header)).toBe(expected);
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['a bare IPv6 literal, which is not a legal Host', '::1'],
    ['an unclosed bracket', '[::1:4782'],
    ['a non-numeric port', 'localhost:not-a-port'],
    ['a bracketed host with rubbish after it', '[::1]junk'],
    ['nothing before the port', ':4782'],
  ])('refuses to guess at %s', (_label, header) => {
    expect(hostnameOf(header)).toBeUndefined();
  });
});

describe('isAddressLiteral — because a literal cannot be rebound', () => {
  it.each(['127.0.0.1', '0.0.0.0', '192.168.1.9', '255.255.255.255', '::1', 'fe80::1', '::ffff:127.0.0.1'])(
    'treats %s as an address',
    (value) => {
      expect(isAddressLiteral(value)).toBe(true);
    },
  );

  it.each(['localhost', 'evil.example', 'attacker.local', 'my-host', '127.1', '999.1.1.1', 'v6.example'])(
    'treats %s as a name',
    (value) => {
      expect(isAddressLiteral(value)).toBe(false);
    },
  );

  it('reads the IPv4-mapped and zoned forms as addresses, not as names', () => {
    // Both are legal authorities that reach a real interface. Reading either as a name
    // fails closed — safe, and still a bug: it locks out a client that addressed this
    // server correctly.
    expect(isAddressLiteral('::ffff:127.0.0.1')).toBe(true);
    expect(isAddressLiteral('fe80::1%25eth0')).toBe(true);
    expect(isAddressLiteral('::ffff:999.1.1.1')).toBe(false);
    expect(isAddressLiteral('::ffff:evil.example')).toBe(false);
    expect(checkHost('[::ffff:127.0.0.1]:4782').ok).toBe(true);
  });

  it('rejects the short IPv4 form the kernel would still accept', () => {
    // `curl http://127.1` reaches loopback. Reading it as an address here would let a
    // name-shaped value through the branch that exists to keep names out.
    expect(isAddressLiteral('127.1')).toBe(false);
  });
});

describe('checkHost — the DNS rebinding guard', () => {
  it('admits address literals, whatever the address', () => {
    for (const header of ['127.0.0.1:4782', '[::1]:4782', '192.168.1.9:4782', '10.0.0.4']) {
      expect(checkHost(header).ok).toBe(true);
    }
  });

  it('admits localhost, which the OS resolves and an attacker cannot move', () => {
    expect(checkHost('localhost:4782').ok).toBe(true);
  });

  it('refuses a name nobody declared', () => {
    const outcome = checkHost('evil.example:4782');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.status).toBe(403);
    expect(outcome.refusal.error).toBe('host_not_allowed');
  });

  it('admits a name the operator declared, and only that one', () => {
    const policy = { allowedHosts: ['flow.internal'] };

    expect(checkHost('flow.internal:4782', policy).ok).toBe(true);
    expect(checkHost('FLOW.INTERNAL:4782', policy).ok).toBe(true);
    expect(checkHost('flow.internal.evil.example:4782', policy).ok).toBe(false);
    expect(checkHost('evil.example:4782', policy).ok).toBe(false);
  });

  it('refuses an absent or unparseable Host rather than assuming loopback', () => {
    for (const header of [undefined, '', '[::1:4782']) {
      const outcome = checkHost(header);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.refusal.status).toBe(400);
    }
  });
});

describe('checkWrite — the cross-origin guard', () => {
  const host = '127.0.0.1:4782';

  it('admits an Origin that is this server', () => {
    expect(checkWrite({ origin: 'http://127.0.0.1:4782' }, { host }).ok).toBe(true);
    expect(checkWrite({ origin: 'https://127.0.0.1:4782' }, { host }).ok).toBe(true);
    expect(checkWrite({ origin: 'HTTP://127.0.0.1:4782' }, { host }).ok).toBe(true);
  });

  it('refuses an Origin that is not', () => {
    for (const origin of [
      'https://evil.example',
      'http://127.0.0.1:4783',
      'http://localhost:4782',
      'http://127.0.0.1:4782.evil.example',
      'file://',
      'chrome-extension://abcdef',
    ]) {
      const outcome = checkWrite({ origin }, { host });
      expect(outcome.ok, `${origin} must be refused`).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.refusal.error).toBe('origin_not_allowed');
    }
  });

  it('refuses the opaque Origin a sandboxed frame sends', () => {
    // `Origin: null` is what a `sandbox`ed iframe or a `data:` document sends. Matching
    // it against the host would never succeed, but reading it as "no origin" would drop
    // through to the header branch — so it is named rather than left to fall through.
    const outcome = checkWrite({ origin: 'null', client: 'anything' }, { host });

    expect(outcome.ok).toBe(true);
    // …on the strength of the header alone, which a cross-origin simple request cannot
    // set. Without it, refused:
    expect(checkWrite({ origin: 'null' }, { host }).ok).toBe(false);
  });

  it('admits a headless client that carries the client header', () => {
    expect(checkWrite({ client: '1' }, { host }).ok).toBe(true);
    expect(checkWrite({ client: 'dashboard' }, { host }).ok).toBe(true);
  });

  it('refuses a write with neither', () => {
    const outcome = checkWrite({}, { host });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.status).toBe(403);
    expect(outcome.refusal.error).toBe('origin_missing');
    expect(outcome.refusal.action).toContain(CLIENT_HEADER);
  });

  it('refuses an empty client header, which is not a header at all', () => {
    expect(checkWrite({ client: '   ' }, { host }).ok).toBe(false);
  });

  it('refuses when there is no host to match against', () => {
    expect(checkWrite({ origin: 'http://127.0.0.1:4782' }, { host: undefined }).ok).toBe(false);
  });
});

describe('isWriteMethod', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete'])('guards %s', (method) => {
    expect(isWriteMethod(method)).toBe(true);
  });

  it.each(['GET', 'HEAD', 'OPTIONS', 'get'])('leaves %s to the host guard', (method) => {
    expect(isWriteMethod(method)).toBe(false);
  });
});

describe('the server, against the request that used to answer 202', () => {
  it('refuses the bodyless cross-origin start', async () => {
    const { server, run } = await serve();

    const response = await server.app.inject({
      method: 'POST',
      url: START(run.runId),
      headers: { host: '127.0.0.1:4782', origin: 'https://evil.example' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<ActionErrorView>().error).toBe('origin_not_allowed');
  });

  it('refuses the bodyless start with no Origin and no client header', async () => {
    const { server, run } = await serve();

    const response = await server.app.inject({
      method: 'POST',
      url: START(run.runId),
      headers: { host: '127.0.0.1:4782' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<ActionErrorView>().error).toBe('origin_missing');
  });

  it('refuses a write from a rebound name even when it is same-origin to the browser', async () => {
    const { server, run } = await serve();

    // The rebinding case in full: the page is at `http://evil.example`, DNS now answers
    // `127.0.0.1`, and the browser therefore considers this same-origin — Origin and Host
    // agree, and CORS is out of the picture. Only the host guard is left.
    const response = await server.app.inject({
      method: 'POST',
      url: START(run.runId),
      headers: { host: 'evil.example:4782', origin: 'http://evil.example:4782' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<ActionErrorView>().error).toBe('host_not_allowed');
  });

  it('refuses a *read* from a rebound name, because the paths are the payload', async () => {
    const { server } = await serve();

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { host: 'evil.example:4782' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('/repo');
  });

  it('lets the dashboard through, which is the whole point', async () => {
    const { server, run } = await serve();

    const response = await server.app.inject({
      method: 'POST',
      url: START(run.runId),
      headers: {
        host: '127.0.0.1:4782',
        origin: 'http://127.0.0.1:4782',
        'content-type': 'application/json',
        [CLIENT_HEADER]: 'dashboard',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(202);
  });

  it('lets the CLI and curl through on the client header alone', async () => {
    const { server, run } = await serve();

    const response = await server.app.inject({
      method: 'POST',
      url: START(run.runId),
      headers: { host: '127.0.0.1:4782', [CLIENT_HEADER]: '1' },
    });

    expect(response.statusCode).toBe(202);
  });

  it('honours a declared host name, and nothing near it', async () => {
    const { server, run } = await serve({ allowedHosts: ['flow.internal'] });

    const allowed = await server.app.inject({
      method: 'POST',
      url: START(run.runId),
      headers: { host: 'flow.internal:4782', origin: 'http://flow.internal:4782' },
    });
    expect(allowed.statusCode).toBe(202);

    const lookalike = await server.app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { host: 'flow.internal.evil.example' },
    });
    expect(lookalike.statusCode).toBe(403);
  });

  it('answers no preflight, so a non-simple cross-origin write never happens', async () => {
    const { server, run } = await serve();

    const response = await server.app.inject({
      method: 'OPTIONS',
      url: START(run.runId),
      headers: {
        host: '127.0.0.1:4782',
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': CLIENT_HEADER,
      },
    });

    // Whatever the status, the absence of this header is what makes the browser refuse
    // to send the real request. Asserting the header rather than the code, because the
    // code is Fastify's business and the header is the contract.
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.statusCode).not.toBe(200);
  });

  it('sends no CORS header on any answer, so nothing is readable cross-origin', async () => {
    const { server } = await serve();

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { host: '127.0.0.1:4782', origin: 'https://evil.example' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('refuses every write endpoint, not only the one that was measured', async () => {
    const { server, run } = await serve();

    for (const url of [
      `/api/v1/runs/${run.runId}/approve?projectId=demo`,
      `/api/v1/runs/${run.runId}/reject?projectId=demo`,
      `/api/v1/runs/${run.runId}/revise?projectId=demo`,
      `/api/v1/runs/${run.runId}/start?projectId=demo`,
      `/api/v1/runs/${run.runId}/tasks/TASK-001/retry?projectId=demo`,
    ]) {
      const response = await server.app.inject({
        method: 'POST',
        url,
        headers: { host: '127.0.0.1:4782', origin: 'https://evil.example' },
      });

      expect(response.statusCode, url).toBe(403);
    }
  });

  it('refuses before the handler runs, so a refusal cannot have had an effect', async () => {
    const { server, run, store } = await serve();

    const before = await store.loadRun(run.runId);

    await server.app.inject({
      method: 'POST',
      url: `/api/v1/runs/${run.runId}/reject?projectId=demo`,
      headers: { host: '127.0.0.1:4782', origin: 'https://evil.example' },
      payload: { reason: 'pwned' },
    });

    const after = await store.loadRun(run.runId);
    expect(after).toEqual(before);
  });
});
