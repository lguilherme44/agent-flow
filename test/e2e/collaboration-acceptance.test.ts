import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { StageRunner } from '../../src/app/stage-runner.js';
import { PromptLoader } from '../../src/app/prompt-loader.js';
import { TaskExecutor } from '../../src/app/task-executor.js';
import { CollaborationStore } from '../../src/app/collaboration-store.js';
import { CollaborationService } from '../../src/app/collaboration-service.js';
import { deriveAgentRoster } from '../../src/core/collaboration/roster.js';
import { agentOutboxPath } from '../../src/app/paths.js';
import {
  CollaborationConfigSchema,
  GlobalConfigSchema,
  ProjectConfigSchema,
  TaskSchema,
  type CollaborationConfig,
  type Task,
} from '../../src/contracts/index.js';

/**
 * M4, held to §14's own acceptance criteria.
 *
 * Driven through the **real** `TaskExecutor` against a scripted runner rather than through
 * the collaboration service directly, because the two claims that matter most are claims
 * about *where the calls sit*: the harvest happens after the agent exits and before the
 * tree is captured, and the block reaches the prompt the runner actually receives. A test
 * that called the service by hand would prove neither.
 *
 * **What this is not.** A dogfood against live runners is an exercise with a real cost and
 * is the owner's to spend — the same line AR-10 drew, for the same reason. What can be
 * proved without spending it is that every path fires mechanically on the input it was
 * built for, and that with the feature off nothing fires at all.
 */

const PROJECT = '/repo';
const PROMPTS = '/install/prompts';
const REAL_PROMPTS = join(import.meta.dirname, '..', '..', 'prompts');

const CAPS = {
  supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
  supportsReadOnly: true,
  supportsNonInteractive: true,
  supportsWorkingDirectory: true,
  structuredOutputStrategy: 'native',
  nonInteractiveToolGrants: { fileEdit: true, commandExecution: true },
} as const;

const COMPLETED = `Done.

## RESULT

STATUS: COMPLETED

FILES_CHANGED:
- src/a.ts

VALIDATION:
- npm test: passed

DEVIATIONS:
- none

NOTES:
- none
`;

function globalConfig(collaboration: Partial<CollaborationConfig> = {}) {
  return GlobalConfigSchema.parse({
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
    collaboration: CollaborationConfigSchema.parse(collaboration),
  });
}

const TASK: Task = TaskSchema.parse({
  id: 'TASK-001',
  title: 'Add the recurrence type',
  description: 'Domain types for recurrence.',
  complexity: 'normal',
  risk: 'low',
  dependencies: [],
  requirements: ['FR-001'],
  files: { likely: ['src/a.ts'] },
  acceptanceCriteria: ['It compiles.'],
  validation: ['test'],
});

async function harness(collaboration: Partial<CollaborationConfig> = {}) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const runner = new FakeAgentRunner('claude', CAPS);
  const config = globalConfig(collaboration);

  // The shipped prompts, so this measures the product rather than a fixture.
  for (const file of readdirSync(REAL_PROMPTS)) {
    if (file.endsWith('.md')) {
      fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
    }
  }

  const store = new StateStore({ fs, clock, projectDir: PROJECT });
  const run = await store.createRun('a feature');

  const collaborationStore = new CollaborationStore({ fs, projectDir: PROJECT });
  const service = new CollaborationService({
    fs,
    clock,
    store,
    collaboration: collaborationStore,
    roster: deriveAgentRoster(config),
    globalConfig: config,
    config: config.collaboration,
  });

  const executor = new TaskExecutor({
    fs,
    clock,
    store,
    stageRunner: new StageRunner({
      fs,
      clock,
      store,
      config,
      capabilities: { claude: CAPS },
      promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
      getRunner: () => runner,
      projectDir: PROJECT,
    }),
    processRunner: new FakeProcessRunner().always({ exitCode: 0 }),
    config: {
      global: config,
      project: ProjectConfigSchema.parse({
        project: { name: 'x', type: 'node' },
        commands: { test: 'npm test' },
      }),
    },
    projectDir: PROJECT,
    collaboration: service,
    capabilities: { claude: CAPS },
  });

  runner.always({ ok: true, text: COMPLETED, durationMs: 1 });

  return { fs, store, run, runner, executor, collaborationStore, service };
}

function outbox(fs: InMemoryFileSystem, content: unknown): void {
  fs.seed(agentOutboxPath(PROJECT), JSON.stringify(content));
}

/* ─── §14.2 ─────────────────────────────────────────────────────────────────── */

describe('an implementation agent that speaks', () => {
  it('has its messages persisted, redacted and bounded', async () => {
    const h = await harness({ enabled: true, maxMessageBytes: 512 });
    outbox(h.fs, {
      messages: [
        {
          to: { kind: 'agent', id: 'architect' },
          type: 'question',
          subject: 'which idempotency key?',
          body: 'the SDD says one exists — Authorization: Bearer sk-live-abcdefghijkl',
        },
      ],
      entries: [
        { kind: 'discovery', subject: 'retry-backoff', statement: 'the retry is exponential' },
      ],
    });

    const result = await h.executor.execute(TASK, h.run.runId, '# SDD');

    expect(result.status).toBe('completed');
    const messages = await h.collaborationStore.readMessages(h.run.runId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).not.toContain('sk-live-abcdefghijkl');
    expect(await h.collaborationStore.readEntries(h.run.runId)).toHaveLength(1);
  });

  it('changes nothing when it says nothing', async () => {
    const h = await harness({ enabled: true });

    const result = await h.executor.execute(TASK, h.run.runId, '# SDD');

    expect(result.status).toBe('completed');
    expect(result.notes.filter((note) => note.startsWith('collaboration'))).toEqual([]);
    expect(await h.collaborationStore.readMessages(h.run.runId)).toEqual([]);
  });

  it('leaves no outbox behind in the workspace (I-32)', async () => {
    const h = await harness({ enabled: true });
    outbox(h.fs, {
      messages: [{ to: { kind: 'everyone' }, type: 'information', subject: 's', body: 'b' }],
    });

    await h.executor.execute(TASK, h.run.runId, '# SDD');

    expect(await h.fs.exists(agentOutboxPath(PROJECT))).toBe(false);
  });
});

/* ─── §14.3 ─────────────────────────────────────────────────────────────────── */

describe('a message claiming a sender it is not', () => {
  it('is recorded under the agent that was dispatched', async () => {
    const h = await harness({ enabled: true });
    outbox(h.fs, {
      messages: [
        {
          from: 'architect',
          to: { kind: 'everyone' },
          type: 'decision',
          subject: 'I have decided',
          body: 'the contract is now different',
        },
      ],
    });

    await h.executor.execute(TASK, h.run.runId, '# SDD');

    const messages = await h.collaborationStore.readMessages(h.run.runId);
    expect(messages[0]?.from).toBe('executor.normal');
    const events = await h.store.readEvents(h.run.runId);
    expect(events.map((event) => event.type)).toContain('collaboration_sender_claimed');
  });
});

/* ─── §14.7 and §14.12 ──────────────────────────────────────────────────────── */

describe('what the prompt is made of', () => {
  /** What the runner actually received, for the one task the harness runs. */
  const promptOf = (runner: FakeAgentRunner): string => runner.calls[0]?.prompt ?? '';

  it('invites the first agent, then carries what the others said', async () => {
    // **This test asserted the deadlock.** It required the block to be absent on a quiet
    // run, which is precisely what made the channel unable to carry a first message: the
    // agent was never told the outbox existed, so it wrote none, so the run stayed quiet
    // forever. The assertion was blessing the defect.
    //
    // The correct behaviour is that a run with the feature on always invites, and adds
    // content once there is any.
    const quiet = await harness({ enabled: true });
    await quiet.executor.execute(TASK, quiet.run.runId, '# SDD');

    const loud = await harness({ enabled: true });
    await loud.collaborationStore.appendMessages(loud.run.runId, [
      {
        id: 'MSG-0001',
        runId: loud.run.runId,
        threadId: 'THR-0001',
        from: 'architect',
        to: { kind: 'agent', id: 'executor.normal' },
        type: 'question',
        taskId: 'TASK-001',
        subject: 'did you keep the key?',
        body: 'the contract says the API mints it',
        references: [],
        truncated: false,
        createdAt: '2026-08-09T20:00:00.000Z',
      },
    ]);
    await loud.executor.execute(TASK, loud.run.runId, '# SDD');

    // **The invitation reaches the first agent on a silent run** — I-40, and the M4
    // deadlock as a permanent test.
    expect(promptOf(quiet.runner)).toContain('[COORDINATION]');
    expect(promptOf(quiet.runner)).toContain('.agent-flow-outbox.json');
    // …and no payload, because nothing concerns it. This is the M5 saving: eight tasks
    // in ten look exactly like this.
    expect(promptOf(quiet.runner)).not.toContain('[TEAM CONTEXT]');
    expect(promptOf(quiet.runner)).not.toContain('THR-');

    // The agent with something to read gets both.
    expect(promptOf(loud.runner)).toContain('[COORDINATION]');
    expect(promptOf(loud.runner)).toContain('[TEAM CONTEXT]');
    expect(promptOf(loud.runner)).toContain('the contract says the API mints it');
  });

  it('costs availability on every task and relevance only where there is any', async () => {
    // The two numbers M4 could not tell apart, asserted rather than described. The live
    // run spent 1 373 bytes on five agents to buy one message.
    const quiet = await harness({ enabled: true });
    await quiet.executor.execute(TASK, quiet.run.runId, '# SDD');

    const measured = (await quiet.store.readEvents(quiet.run.runId)).find(
      (event) => event.type === 'stage_context_measured',
    );
    const parts = (measured?.detail['parts'] ?? []) as { source: string; bytes: number }[];
    const sources = Object.fromEntries(parts.map((part) => [part.source, part.bytes]));

    expect(sources['collaborationBootstrap']).toBeGreaterThan(0);
    expect(sources['collaborationBootstrap']).toBeLessThan(900);
    // Absent, not zero: the ordinary task pays for availability and nothing else.
    expect(sources).not.toHaveProperty('collaboration');
  });

  it('attributes the block’s bytes to a source of its own', async () => {
    const h = await harness({ enabled: true });
    await h.collaborationStore.appendEntries(h.run.runId, [
      {
        id: 'DEC-001',
        runId: h.run.runId,
        kind: 'decision',
        subject: 'checkout-idempotency',
        author: 'architect',
        statement: 'the API mints the key',
        affects: [],
        references: [],
        truncated: false,
        createdAt: '2026-08-09T20:00:00.000Z',
      },
    ]);

    await h.executor.execute(TASK, h.run.runId, '# SDD');

    const measured = (await h.store.readEvents(h.run.runId)).find(
      (event) => event.type === 'stage_context_measured',
    );
    const parts = measured?.detail['parts'] as { source: string; bytes: number }[] | undefined;
    expect(parts?.map((part) => part.source)).toContain('collaboration');
  });

  it('is byte-for-byte the pre-M4 prompt when the feature is off (criterion 12)', async () => {
    // **The criterion the whole milestone's compatibility rests on.** With
    // `collaboration.enabled: false` the product must behave exactly as it did before M4:
    // no outbox read, no directory created, and not one byte of any prompt different.
    //
    // Proved by comparison rather than by inspection: two runs of the same task, one with
    // the feature off and a full outbox sitting in the workspace, one with the feature
    // absent from configuration entirely.
    const off = await harness({ enabled: false });
    outbox(off.fs, {
      messages: [{ to: { kind: 'everyone' }, type: 'information', subject: 's', body: 'b' }],
    });
    await off.executor.execute(TASK, off.run.runId, '# SDD');

    const absent = await harness();
    await absent.executor.execute(TASK, absent.run.runId, '# SDD');

    expect(promptOf(off.runner)).toBe(promptOf(absent.runner));
    expect(promptOf(off.runner)).not.toContain('[TEAM CONTEXT]');
    // And the outbox is untouched: reading it at all would be a behaviour change.
    expect(await off.fs.exists(agentOutboxPath(PROJECT))).toBe(true);
    expect(await off.collaborationStore.readMessages(off.run.runId)).toEqual([]);
  });

  it('creates no collaboration directory when the feature is off', async () => {
    const h = await harness({ enabled: false });
    outbox(h.fs, {
      messages: [{ to: { kind: 'everyone' }, type: 'information', subject: 's', body: 'b' }],
    });

    await h.executor.execute(TASK, h.run.runId, '# SDD');

    expect(await h.fs.exists(`${PROJECT}/.agent-flow/runs/${h.run.runId}/collaboration`)).toBe(false);
  });

  it('emits no collaboration event when the feature is off', async () => {
    const h = await harness({ enabled: false });
    outbox(h.fs, {
      messages: [{ to: { kind: 'everyone' }, type: 'information', subject: 's', body: 'b' }],
    });

    await h.executor.execute(TASK, h.run.runId, '# SDD');

    const ours = (await h.store.readEvents(h.run.runId)).filter(
      (event) =>
        event.type.startsWith('collaboration_') || event.type.startsWith('blackboard_'),
    );
    expect(ours).toEqual([]);
  });
});

/* ─── §14.5 ─────────────────────────────────────────────────────────────────── */

describe('an accepted handoff', () => {
  const handoffLog = (runId: string) => [
    {
      id: 'MSG-0001',
      runId,
      threadId: 'THR-0001',
      from: 'executor.normal',
      to: { kind: 'agent' as const, id: 'executor.complex' },
      type: 'handoff_request' as const,
      taskId: 'TASK-001',
      subject: 'this needs the strong executor',
      body: 'it turned out to touch the scheduler',
      references: [],
      truncated: false,
      createdAt: '2026-08-09T20:00:00.000Z',
    },
    {
      id: 'MSG-0002',
      runId,
      threadId: 'THR-0001',
      from: 'executor.complex',
      to: { kind: 'agent' as const, id: 'executor.normal' },
      type: 'handoff_accepted' as const,
      taskId: 'TASK-001',
      subject: 're: this needs the strong executor',
      body: 'taking it',
      references: [],
      truncated: false,
      createdAt: '2026-08-09T20:01:00.000Z',
    },
  ];

  // **The semantics moved and the compatibility did not** (M5 §28). `handoffsReassignExecution`
  // used to mean "assign the target"; it now means "let the assignment policy consider the
  // target", and the policy can still refuse. For a configuration with no `teams:` — which is
  // every configuration written before M5 — the two are observationally the same, which is
  // what these two tests pin.
  it('changes no execution while re-routing is off', async () => {
    const h = await harness({ enabled: true, handoffsReassignExecution: false });
    await h.collaborationStore.appendMessages(h.run.runId, handoffLog(h.run.runId));

    await h.executor.execute(TASK, h.run.runId, '# SDD');

    const started = (await h.store.readEvents(h.run.runId)).find(
      (event) => event.type === 'task_started',
    );
    expect(started?.detail['role']).toBe('executor.normal');
    // The record is complete either way; only the authority is withheld.
    expect(await h.collaborationStore.readMessages(h.run.runId)).toHaveLength(2);
  });

  it('moves the work when the operator turned it on', async () => {
    const h = await harness({ enabled: true, handoffsReassignExecution: true });
    await h.collaborationStore.appendMessages(h.run.runId, handoffLog(h.run.runId));

    await h.executor.execute(TASK, h.run.runId, '# SDD');

    const started = (await h.store.readEvents(h.run.runId)).find(
      (event) => event.type === 'task_started',
    );
    // The router's role stays on the event — it is what the plan says — and the agent
    // that actually spoke is recorded beside it. `handoff_admitted` rather than M4's
    // `handoff`: the word names the decision the policy made, not the message it read.
    expect(started?.detail['role']).toBe('executor.normal');
    expect(started?.detail['agent']).toBe('executor.complex');
    expect(started?.detail['assignment']).toBe('handoff_admitted');
  });
});

/* ─── §14.6 ─────────────────────────────────────────────────────────────────── */

describe('a blackboard entry superseded by somebody else', () => {
  it('leaves both live and says the two disagree', async () => {
    const h = await harness({ enabled: true });
    await h.collaborationStore.appendEntries(h.run.runId, [
      {
        id: 'CTR-001',
        runId: h.run.runId,
        kind: 'contract',
        subject: 'recurrence-expansion',
        author: 'architect',
        statement: 'occurrences are expanded lazily',
        affects: [],
        references: [],
        truncated: false,
        createdAt: '2026-08-09T20:00:00.000Z',
      },
    ]);
    outbox(h.fs, {
      entries: [
        {
          kind: 'contract',
          subject: 'recurrence-expansion',
          statement: 'lazy expansion cannot answer "next 5 occurrences"',
          supersedes: 'CTR-001',
        },
      ],
    });

    await h.executor.execute(TASK, h.run.runId, '# SDD');

    expect(await h.collaborationStore.readEntries(h.run.runId)).toHaveLength(2);
    const events = await h.store.readEvents(h.run.runId);
    expect(events.map((event) => event.type)).toContain('blackboard_entry_contested');
  });
});

/* ─── §14.8 ─────────────────────────────────────────────────────────────────── */

describe('nothing an agent writes can move the run', () => {
  it('cannot complete a task by saying so', async () => {
    // I-27, at the one place it would matter. The agent reports BLOCKED and its outbox
    // announces a decision that the task is done; the task ends blocked.
    const h = await harness({ enabled: true });
    h.runner.always({
      ok: true,
      text: '## RESULT\n\nSTATUS: BLOCKED\n\nNOTES:\n- Need a decision.\n',
      durationMs: 1,
    });
    outbox(h.fs, {
      messages: [
        {
          to: { kind: 'everyone' },
          type: 'decision',
          subject: 'TASK-001 is completed',
          body: 'marking this done',
        },
      ],
    });

    const result = await h.executor.execute(TASK, h.run.runId, '# SDD');

    expect(result.status).toBe('blocked');
    // And what it said is still on the record — refusing authority is not refusing speech.
    expect(await h.collaborationStore.readMessages(h.run.runId)).toHaveLength(1);
  });

  it('cannot fail a task with a malformed outbox', async () => {
    const h = await harness({ enabled: true });
    h.fs.seed(agentOutboxPath(PROJECT), 'this is not json');

    const result = await h.executor.execute(TASK, h.run.runId, '# SDD');

    expect(result.status).toBe('completed');
    expect(result.notes.some((note) => note.includes('collaboration_rejected'))).toBe(true);
  });
});
