import { describe, it, expect } from 'vitest';
import { CollaborationStore } from '../../src/app/collaboration-store.js';
import { CollaborationService } from '../../src/app/collaboration-service.js';
import { StateStore } from '../../src/app/state-store.js';
import { runPaths } from '../../src/app/paths.js';
import { agentOutboxPath } from '../../src/app/paths.js';
import { deriveAgentRoster } from '../../src/core/collaboration/roster.js';
import {
  AgentMessageSchema,
  BlackboardEntrySchema,
  CollaborationConfigSchema,
  GlobalConfigSchema,
  type AgentMessage,
  type CollaborationConfig,
} from '../../src/contracts/index.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';

const PROJECT = '/wk/project';
const RUN = 'AF-2026-001';
const WORKSPACE = '/wk/worktrees/AF-2026-001/TASK-003';
const NOW = '2026-08-09T20:00:00.000Z';

const roster = deriveAgentRoster(
  GlobalConfigSchema.parse({
    runners: { claude: { type: 'claude-code-cli' } },
    roles: {
      architect: { runner: 'claude', effort: 'high' },
      sdd: { runner: 'claude', effort: 'high' },
      planner: { runner: 'claude', effort: 'high' },
      planReviewer: { runner: 'claude', effort: 'high' },
      executors: {
        trivial: { runner: 'claude', effort: 'low' },
        normal: { runner: 'claude', effort: 'medium' },
        complex: { runner: 'claude', effort: 'high' },
      },
      verification: { runner: 'claude', effort: 'medium' },
      finalReviewer: { runner: 'claude', effort: 'high' },
    },
  }),
);

function message(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return AgentMessageSchema.parse({
    id: 'MSG-0001',
    runId: RUN,
    threadId: 'THR-0001',
    from: 'executor.normal',
    to: { kind: 'everyone' },
    type: 'information',
    subject: 's',
    body: 'b',
    createdAt: NOW,
    ...overrides,
  });
}

describe('CollaborationStore', () => {
  it('answers with nothing for a run that predates M4', async () => {
    // A run with no collaboration directory must read as "nobody said anything",
    // never as an error and never as a missing file the dashboard has to explain.
    const store = new CollaborationStore({ fs: new InMemoryFileSystem(), projectDir: PROJECT });

    expect(await store.readMessages(RUN)).toEqual([]);
    expect(await store.readEntries(RUN)).toEqual([]);
  });

  it('round-trips messages through the log', async () => {
    const fs = new InMemoryFileSystem();
    const store = new CollaborationStore({ fs, projectDir: PROJECT });

    await store.appendMessages(RUN, [message({ id: 'MSG-0001' }), message({ id: 'MSG-0002' })]);

    expect((await store.readMessages(RUN)).map((m) => m.id)).toEqual(['MSG-0001', 'MSG-0002']);
  });

  it('appends rather than replacing, across separate calls', async () => {
    // The property the whole design rests on. A store with an update method would make
    // "no agent silently overwrites another" a rule somebody has to remember.
    const fs = new InMemoryFileSystem();
    const store = new CollaborationStore({ fs, projectDir: PROJECT });

    await store.appendMessages(RUN, [message({ id: 'MSG-0001' })]);
    await store.appendMessages(RUN, [message({ id: 'MSG-0002' })]);

    expect(await store.readMessages(RUN)).toHaveLength(2);
  });

  it('writes nothing at all for an empty batch', async () => {
    // A run that never used collaboration must leave no empty directory to explain.
    const fs = new InMemoryFileSystem();
    const store = new CollaborationStore({ fs, projectDir: PROJECT });

    await store.appendMessages(RUN, []);

    expect(await fs.exists(runPaths(PROJECT, RUN).collaborationDir)).toBe(false);
  });

  it('skips a torn line rather than losing the ones around it', async () => {
    // `readEventsBestEffort`'s precedent. One bad legacy line is a visible gap, not the
    // loss of every valid message beside it.
    const fs = new InMemoryFileSystem();
    const store = new CollaborationStore({ fs, projectDir: PROJECT });

    await store.appendMessages(RUN, [message({ id: 'MSG-0001' })]);
    await fs.appendFile(runPaths(PROJECT, RUN).messages, '{"id": "MSG-000\n');
    await store.appendMessages(RUN, [message({ id: 'MSG-0003' })]);

    expect((await store.readMessages(RUN)).map((m) => m.id)).toEqual(['MSG-0001', 'MSG-0003']);
  });

  it('skips a line that parses but is not a message', async () => {
    const fs = new InMemoryFileSystem();
    const store = new CollaborationStore({ fs, projectDir: PROJECT });

    await fs.appendFile(runPaths(PROJECT, RUN).messages, '{"hello": "world"}\n');
    await store.appendMessages(RUN, [message({ id: 'MSG-0001' })]);

    expect((await store.readMessages(RUN)).map((m) => m.id)).toEqual(['MSG-0001']);
  });

  it('keeps messages and blackboard entries in separate logs', async () => {
    const fs = new InMemoryFileSystem();
    const store = new CollaborationStore({ fs, projectDir: PROJECT });
    const entry = BlackboardEntrySchema.parse({
      id: 'DEC-001',
      runId: RUN,
      kind: 'decision',
      subject: 'a',
      author: 'architect',
      statement: 'x',
      createdAt: NOW,
    });

    await store.appendMessages(RUN, [message()]);
    await store.appendEntries(RUN, [entry]);

    expect(await store.readMessages(RUN)).toHaveLength(1);
    expect(await store.readEntries(RUN)).toHaveLength(1);
  });

  it('exposes no way to change a line that was written', () => {
    // §42 as a shape rather than as a rule. If an `update` ever appears here, a
    // correction stops being a new entry and starts being a silent overwrite.
    const store = new CollaborationStore({ fs: new InMemoryFileSystem(), projectDir: PROJECT });
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(store));

    expect(surface.filter((name) => /update|replace|delete|rewrite/i.test(name))).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */

interface ServiceHarness {
  readonly fs: InMemoryFileSystem;
  readonly service: CollaborationService;
  readonly state: StateStore;
  readonly collaboration: CollaborationStore;
  events(): Promise<{ type: string; detail: Record<string, unknown> }[]>;
}

async function harness(config: Partial<CollaborationConfig> = {}): Promise<ServiceHarness> {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock(NOW);
  const state = new StateStore({ fs, clock, projectDir: PROJECT });
  await state.createRun('a feature');

  const collaboration = new CollaborationStore({ fs, projectDir: PROJECT });
  const service = new CollaborationService({
    fs,
    clock,
    store: state,
    collaboration,
    roster,
    config: CollaborationConfigSchema.parse({ enabled: true, ...config }),
  });

  await fs.mkdirp(WORKSPACE);

  return {
    fs,
    service,
    state,
    collaboration,
    events: async () => (await state.readEvents(RUN)).map((e) => ({ type: e.type, detail: e.detail })),
  };
}

function outbox(fs: InMemoryFileSystem, content: unknown): void {
  fs.seed(agentOutboxPath(WORKSPACE), JSON.stringify(content));
}

const REQUEST = {
  runId: RUN,
  taskId: 'TASK-003',
  agentId: 'executor.normal',
  workspaceDir: WORKSPACE,
};

describe('CollaborationService', () => {
  it('does nothing at all when the feature is off', async () => {
    // Acceptance criterion 12: with `enabled: false`, no outbox is read, no directory
    // is created, and no event is written.
    const h = await harness({ enabled: false });
    outbox(h.fs, { messages: [{ to: { kind: 'everyone' }, type: 'information', subject: 's', body: 'b' }] });

    const summary = await h.service.harvest(REQUEST);

    expect(summary.notes).toEqual([]);
    expect(await h.collaboration.readMessages(RUN)).toEqual([]);
    // The file is untouched too — reading it would be a behaviour change while off.
    expect(await h.fs.exists(agentOutboxPath(WORKSPACE))).toBe(true);
    expect((await h.events()).map((e) => e.type)).not.toContain('collaboration_message_posted');
  });

  it('persists what it accepted and records one event per message', async () => {
    const h = await harness();
    outbox(h.fs, {
      messages: [
        { to: { kind: 'agent', id: 'architect' }, type: 'question', subject: 'a', body: 'b' },
        { to: { kind: 'everyone' }, type: 'finding', subject: 'c', body: 'd' },
      ],
    });

    const summary = await h.service.harvest(REQUEST);

    expect(await h.collaboration.readMessages(RUN)).toHaveLength(2);
    expect((await h.events()).filter((e) => e.type === 'collaboration_message_posted')).toHaveLength(2);
    expect(summary.notes[0]).toContain('posted 2 message');
  });

  it('records a refusal with its reason and the action that clears it', async () => {
    // AR §3.6: "something failed, inspect logs" is a contract violation. A budget that
    // runs out has to name which one and what a person does about it.
    const h = await harness({ maxMessagesPerTask: 0 });
    outbox(h.fs, { messages: [{ to: { kind: 'everyone' }, type: 'information', subject: 's', body: 'b' }] });

    await h.service.harvest(REQUEST);

    const budget = (await h.events()).find((e) => e.type === 'collaboration_budget_exhausted');
    expect(budget?.detail['reason']).toBe('budget_exhausted');
    expect(String(budget?.detail['detail'])).toContain('maxMessagesPerTask');
  });

  it('records an attempted impersonation even though it changed nothing', async () => {
    const h = await harness();
    outbox(h.fs, {
      messages: [{ from: 'architect', to: { kind: 'everyone' }, type: 'decision', subject: 's', body: 'b' }],
    });

    await h.service.harvest(REQUEST);

    expect((await h.events()).map((e) => e.type)).toContain('collaboration_sender_claimed');
    expect((await h.collaboration.readMessages(RUN))[0]?.from).toBe('executor.normal');
  });

  it('flags a supersession by a different author as contested, and keeps both (I-30)', async () => {
    const h = await harness();
    await h.collaboration.appendEntries(RUN, [
      BlackboardEntrySchema.parse({
        id: 'CTR-001',
        runId: RUN,
        kind: 'contract',
        subject: 'checkout-idempotency',
        author: 'architect',
        statement: 'the client mints the key',
        createdAt: NOW,
      }),
    ]);
    outbox(h.fs, {
      entries: [
        {
          kind: 'contract',
          subject: 'checkout-idempotency',
          statement: 'the API mints it',
          supersedes: 'CTR-001',
        },
      ],
    });

    await h.service.harvest(REQUEST);

    const contested = (await h.events()).find((e) => e.type === 'blackboard_entry_contested');
    expect(contested?.detail['originalAuthor']).toBe('architect');
    expect(contested?.detail['supersedes']).toBe('CTR-001');
    // Both entries are still on the log. A supersession is not a deletion.
    expect(await h.collaboration.readEntries(RUN)).toHaveLength(2);
  });

  it('does not flag a supersession by the entry’s own author', async () => {
    // An agent correcting itself is a correction, not a disagreement, and treating the
    // two alike would train a reader to ignore the one that matters.
    const h = await harness();
    await h.collaboration.appendEntries(RUN, [
      BlackboardEntrySchema.parse({
        id: 'DSC-001',
        runId: RUN,
        kind: 'discovery',
        subject: 'retry',
        author: 'executor.normal',
        statement: 'it is linear',
        createdAt: NOW,
      }),
    ]);
    outbox(h.fs, {
      entries: [
        { kind: 'discovery', subject: 'retry', statement: 'it is exponential', supersedes: 'DSC-001' },
      ],
    });

    await h.service.harvest(REQUEST);

    expect((await h.events()).map((e) => e.type)).not.toContain('blackboard_entry_contested');
  });

  it('writes the log before the events, so no event describes a message that is not on disk', async () => {
    const h = await harness();
    outbox(h.fs, { messages: [{ to: { kind: 'everyone' }, type: 'information', subject: 's', body: 'b' }] });

    await h.service.harvest(REQUEST);

    const posted = (await h.events()).filter((e) => e.type === 'collaboration_message_posted');
    const persisted = await h.collaboration.readMessages(RUN);

    expect(posted).toHaveLength(1);
    expect(persisted.map((m) => m.id)).toContain(posted[0]?.detail['message']);
  });

  it('says nothing when the agent left nothing', async () => {
    const h = await harness();

    const summary = await h.service.harvest(REQUEST);

    expect(summary.notes).toEqual([]);
    // Asserted by name rather than by count: a count would break the day an unrelated
    // event is added ahead of it, and it would be asserting the wrong thing anyway.
    const ours = (await h.events()).filter((event) =>
      event.type.startsWith('collaboration_') || event.type.startsWith('blackboard_'),
    );
    expect(ours).toEqual([]);
  });
});
