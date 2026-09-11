import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, type RunningServer } from '../../src/server/server.js';
import { registryOf } from '../../src/server/project-registry.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import type { DoctorView } from '../../src/contracts/index.js';

const PROJECT = { id: 'demo', name: 'demo', path: '/repo' };

const PROJECT_CONFIG = `project:
  name: demo
  type: node
commands: {}
`;

const GLOBAL_CONFIG = `runners:
  claude:
    type: claude-code-cli
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

async function serve(options: {
  remoteAccess?: { admittedAddresses: readonly string[] };
} = {}) {
  const fs = new InMemoryFileSystem();
  fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);
  fs.seed('/home/.agent-flow/config.yaml', GLOBAL_CONFIG);

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
  fs.seed(
    '/install/prompts/implementation.md',
    '---\npermissions: write\nworkingDirectory: true\noutputFormat: json\nrequiredVars: [repositoryMap]\n---\n\n# implementation\n',
  );

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
    ...(options.remoteAccess === undefined ? {} : { remoteAccess: options.remoteAccess }),
  });

  return { server: running };
}

describe('GET /api/v1/doctor remote access projection (FR-023)', () => {
  it('reports remoteAccess as known with enabled=false and empty address list when remote access is off', async () => {
    const { server } = await serve();

    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/doctor',
    });

    expect(res.statusCode).toBe(200);
    const view = res.json<DoctorView>();
    expect(view.remoteAccess).toEqual({
      known: true,
      enabled: false,
      admittedAddresses: [],
      liveSessions: 0,
    });
  });

  it('reports remoteAccess as known with enabled=true, admitted addresses and initial liveSessions=0 when remote access is on', async () => {
    const { server } = await serve({
      remoteAccess: { admittedAddresses: ['192.168.1.9', '10.0.0.5'] },
    });

    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/doctor',
    });

    expect(res.statusCode).toBe(200);
    const view = res.json<DoctorView>();
    expect(view.remoteAccess).toEqual({
      known: true,
      enabled: true,
      admittedAddresses: ['192.168.1.9', '10.0.0.5'],
      liveSessions: 0,
    });
  });

  function expectKnownRemoteAccess(view: DoctorView) {
    expect(view.remoteAccess.known).toBe(true);
    if (!view.remoteAccess.known) {
      throw new Error('Expected remoteAccess to be known');
    }
    return view.remoteAccess;
  }

  it('liveSessions increments when a device pairs and decrements when the session is revoked', async () => {
    const { server } = await serve({
      remoteAccess: { admittedAddresses: ['192.168.1.9'] },
    });

    // 1. Initial doctor check: 0 live sessions
    const initialRes = await server.app.inject({ method: 'GET', url: '/api/v1/doctor' });
    expect(initialRes.statusCode).toBe(200);
    expect(expectKnownRemoteAccess(initialRes.json<DoctorView>()).liveSessions).toBe(0);

    // 2. Pair a device
    const code = server.pairing!.code;
    const pairRes = await server.app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      headers: { 'x-agent-flow-client': '1', 'content-type': 'application/json' },
      payload: { code, label: 'Operator Phone' },
    });
    expect(pairRes.statusCode).toBe(200);
    const pairBody = JSON.parse(pairRes.body);
    const deviceId = pairBody.deviceId as string;
    expect(deviceId).toBeDefined();

    // 3. Doctor check: 1 live session
    const pairedDoctorRes = await server.app.inject({ method: 'GET', url: '/api/v1/doctor' });
    expect(pairedDoctorRes.statusCode).toBe(200);
    expect(expectKnownRemoteAccess(pairedDoctorRes.json<DoctorView>()).liveSessions).toBe(1);

    // 4. Revoke the device session
    const revokeRes = await server.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${deviceId}/revoke`,
      headers: { 'x-agent-flow-client': '1' },
    });
    expect(revokeRes.statusCode).toBe(200);

    // 5. Doctor check: back to 0 live sessions
    const revokedDoctorRes = await server.app.inject({ method: 'GET', url: '/api/v1/doctor' });
    expect(revokedDoctorRes.statusCode).toBe(200);
    expect(expectKnownRemoteAccess(revokedDoctorRes.json<DoctorView>()).liveSessions).toBe(0);
  });

  it('positive control: liveSessions tracks real session store count (fails if hardcoded)', async () => {
    const { server } = await serve({
      remoteAccess: { admittedAddresses: ['192.168.1.9'] },
    });

    const before = server.app.inject({ method: 'GET', url: '/api/v1/doctor' });
    const code = server.pairing!.code;
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      headers: { 'x-agent-flow-client': '1', 'content-type': 'application/json' },
      payload: { code, label: 'Positive Control Device' },
    });
    const after = server.app.inject({ method: 'GET', url: '/api/v1/doctor' });

    const [beforeView, afterView] = await Promise.all([
      before.then((r) => r.json<DoctorView>()),
      after.then((r) => r.json<DoctorView>()),
    ]);

    const beforeKnown = expectKnownRemoteAccess(beforeView);
    const afterKnown = expectKnownRemoteAccess(afterView);

    expect(beforeKnown.liveSessions).not.toBe(afterKnown.liveSessions);
    expect(afterKnown.liveSessions - beforeKnown.liveSessions).toBe(1);
  });
});
