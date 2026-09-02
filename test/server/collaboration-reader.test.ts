import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { buildServer, type RunningServer } from '../../src/server/server.js';
import { registryOf } from '../../src/server/project-registry.js';
import { StateStore } from '../../src/app/state-store.js';
import { CollaborationStore } from '../../src/app/collaboration-store.js';
import {
  AgentMessageSchema,
  BlackboardEntrySchema,
  type AgentMessage,
  type BlackboardEntry,
  type CollaborationView,
} from '../../src/contracts/index.js';

/**
 * The collaboration read model (M4-07).
 *
 * Every assertion here is really about one property: **the dashboard reads what the
 * prompt read.** The endpoint runs the same four projections over the same two logs, so a
 * thread the block called resolved cannot render as open — and a second derivation, in
 * the browser or in this reader, is what would eventually make them disagree.
 */

const PROJECT = { id: 'demo', name: 'demo', path: '/repo' };
const NOW = '2026-08-09T20:00:00.000Z';

const PROJECT_CONFIG = `project:
  name: demo
  type: node
commands:
  test: npm test
`;

/** A global config with a full role table, so a roster can be derived from it. */
const GLOBAL_CONFIG = (collaborationEnabled: boolean): string => `version: 1
runners:
  claude:
    type: claude-code-cli
roles:
  architect: { runner: claude, effort: high }
  sdd: { runner: claude, effort: high }
  planner: { runner: claude, effort: high }
  planReviewer: { runner: claude, effort: high }
  executors:
    trivial: { runner: claude, effort: low }
    normal: { runner: claude, effort: medium, model: a-model }
    complex: { runner: claude, effort: high }
  verification: { runner: claude, effort: medium }
  finalReviewer: { runner: claude, effort: high }
collaboration:
  enabled: ${String(collaborationEnabled)}
`;

let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

function message(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return AgentMessageSchema.parse({
    id: 'MSG-0001',
    runId: 'AF-2026-001',
    threadId: 'THR-0001',
    from: 'executor.normal',
    to: { kind: 'agent', id: 'architect' },
    type: 'question',
    taskId: 'TASK-001',
    subject: 'which idempotency key?',
    body: 'the SDD names one but does not say where it is minted',
    createdAt: NOW,
    ...overrides,
  });
}

function entry(overrides: Partial<BlackboardEntry> = {}): BlackboardEntry {
  return BlackboardEntrySchema.parse({
    id: 'DEC-001',
    runId: 'AF-2026-001',
    kind: 'decision',
    subject: 'checkout-idempotency',
    author: 'architect',
    statement: 'the API mints the key',
    createdAt: NOW,
    ...overrides,
  });
}

async function serve(
  options: {
    readonly enabled?: boolean;
    readonly messages?: readonly AgentMessage[];
    readonly entries?: readonly BlackboardEntry[];
    readonly terminal?: boolean;
  } = {},
) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();

  fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);
  fs.seed('/home/.agent-flow/config.yaml', GLOBAL_CONFIG(options.enabled ?? true));

  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const run = await store.createRun('weekly recurrence');
  if (options.terminal === true) {
    await store.updateRun(run.runId, (state) => ({ ...state, status: 'completed' }));
  }

  const collaboration = new CollaborationStore({ fs, projectDir: '/repo' });
  await collaboration.appendMessages(run.runId, options.messages ?? []);
  await collaboration.appendEntries(run.runId, options.entries ?? []);

  running = await buildServer({
    fs,
    clock,
    processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: '1.0.0' }),
    registry: registryOf([PROJECT]),
    globalConfigPath: '/home/.agent-flow/config.yaml',
    version: '0.1.0',
    host: '127.0.0.1',
    port: 4782,
    promptsDir: '/install/prompts',
    processHost: new FakeHost(),
    pollIntervalMs: 20,
  });

  const view = async (): Promise<CollaborationView> => {
    const response = await running!.app.inject({
      method: 'GET',
      url: `/api/v1/runs/${run.runId}/collaboration?projectId=demo`,
    });
    expect(response.statusCode).toBe(200);
    return response.json<CollaborationView>();
  };

  return { fs, store, run, server: running, view };
}

describe('GET /runs/:runId/collaboration', () => {
  it('answers with an empty view for a run that predates M4', async () => {
    // A run with no collaboration directory is not an error and must not render as one.
    const { view } = await serve();
    const collaboration = await view();

    expect(collaboration.threads).toEqual([]);
    expect(collaboration.entries).toEqual([]);
    expect(collaboration.handoffs).toEqual([]);
  });

  it('reports whether the feature is on, separately from whether anything was said', async () => {
    // Two different answers, and the empty state depends on which: "off" invites the
    // operator to turn it on, and "on, and quiet" does not.
    expect((await (await serve({ enabled: false })).view()).enabled).toBe(false);
    expect((await (await serve({ enabled: true })).view()).enabled).toBe(true);
  });

  it('derives the roster from configuration, with no credential in it', async () => {
    const { view } = await serve();
    const collaboration = await view();

    expect(collaboration.agents).toHaveLength(9);
    const executor = collaboration.agents.find((agent) => agent.id === 'executor.normal');
    expect(executor?.displayName).toBe('Executor (normal)');
    expect(executor?.runner).toBe('claude');
    expect(executor?.model).toBe('a-model');
  });

  it('renders a thread with its messages and a readable sender', async () => {
    const { view } = await serve({
      messages: [
        message({ id: 'MSG-0001' }),
        message({ id: 'MSG-0002', from: 'architect', type: 'answer', body: 'the API mints it' }),
      ],
    });
    const collaboration = await view();

    expect(collaboration.threads).toHaveLength(1);
    expect(collaboration.threads[0]?.status).toBe('answered');
    expect(collaboration.threads[0]?.messages[0]?.fromName).toBe('Executor (normal)');
    expect(collaboration.threads[0]?.messages[0]?.to).toBe('architect');
  });

  it('flattens a role and a broadcast recipient for display', async () => {
    const { view } = await serve({
      messages: [
        message({ id: 'MSG-0001', to: { kind: 'role', role: 'planner' } }),
        message({ id: 'MSG-0002', threadId: 'THR-0002', to: { kind: 'everyone' } }),
      ],
    });
    const collaboration = await view();

    const recipients = collaboration.threads.flatMap((thread) =>
      thread.messages.map((m) => m.to),
    );
    expect(recipients).toEqual(['@planner', 'everyone']);
  });

  it('reports a thread on a finished run as abandoned, not open', async () => {
    // The run's own terminal status decides it. "Open" on a finished run invites a
    // person to wait for an answer that is never coming.
    const { view } = await serve({ messages: [message()], terminal: true });

    expect((await view()).threads[0]?.status).toBe('abandoned');
  });

  it('renders a handoff with its status', async () => {
    const { view } = await serve({
      messages: [
        message({
          id: 'MSG-0001',
          type: 'handoff_request',
          from: 'executor.normal',
          to: { kind: 'agent', id: 'executor.complex' },
          body: 'it turned out to touch the scheduler',
        }),
        message({
          id: 'MSG-0002',
          type: 'handoff_accepted',
          from: 'executor.complex',
          to: { kind: 'agent', id: 'executor.normal' },
        }),
      ],
    });
    const collaboration = await view();

    expect(collaboration.handoffs).toHaveLength(1);
    expect(collaboration.handoffs[0]?.status).toBe('accepted');
    expect(collaboration.handoffs[0]?.reason).toBe('it turned out to touch the scheduler');
  });

  it('shows both sides of a contested entry, and marks them', async () => {
    // I-30 reaching a person. A dashboard that showed only the winner would let a
    // disagreement between two agents settle itself out of sight.
    const { view } = await serve({
      entries: [
        entry({ id: 'CTR-001', kind: 'contract', author: 'architect', statement: 'the client mints it' }),
        entry({
          id: 'CTR-002',
          kind: 'contract',
          author: 'executor.normal',
          supersedes: 'CTR-001',
          statement: 'the API mints it',
        }),
      ],
    });
    const collaboration = await view();

    expect(collaboration.entries.map((e) => e.status)).toEqual(['contested', 'contested']);
    expect(collaboration.entries[0]?.supersededBy).toBe('CTR-002');
    expect(collaboration.entries[0]?.authorName).toBe('Architect');
  });

  it('marks a self-correction as superseded rather than contested', async () => {
    const { view } = await serve({
      entries: [
        entry({ id: 'DSC-001', kind: 'discovery', author: 'architect', statement: 'linear' }),
        entry({
          id: 'DSC-002',
          kind: 'discovery',
          author: 'architect',
          supersedes: 'DSC-001',
          statement: 'exponential',
        }),
      ],
    });
    const collaboration = await view();

    expect(collaboration.entries.map((e) => e.status)).toEqual(['superseded', 'active']);
  });

  it('404s for a run that does not exist', async () => {
    // Distinct from an empty view: one is a missing run, the other is a quiet one.
    const { server } = await serve();

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/v1/runs/AF-2026-999/collaboration?projectId=demo',
    });

    expect(response.statusCode).toBe(404);
  });

  it('takes no path from the client and returns none', async () => {
    // The filesystem boundary is the registry (§93). A collaboration response names
    // agents, tasks and threads — never a directory on this machine.
    const { view } = await serve({ messages: [message()], entries: [entry()] });

    expect(JSON.stringify(await view())).not.toContain('/repo');
  });

  it('skips a torn line rather than losing the run’s whole conversation', async () => {
    const { fs, run, view } = await serve({ messages: [message({ id: 'MSG-0001' })] });
    await fs.appendFile(`/repo/.agent-flow/runs/${run.runId}/collaboration/messages.jsonl`, '{ torn\n');

    expect((await view()).threads).toHaveLength(1);
  });
});
