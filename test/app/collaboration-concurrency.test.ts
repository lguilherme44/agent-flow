import { describe, it, expect } from 'vitest';
import { CollaborationStore } from '../../src/app/collaboration-store.js';
import { CollaborationService } from '../../src/app/collaboration-service.js';
import { StateStore } from '../../src/app/state-store.js';
import { agentOutboxPath, runPaths } from '../../src/app/paths.js';
import { deriveAgentRoster } from '../../src/core/collaboration/roster.js';
import { CollaborationConfigSchema, GlobalConfigSchema } from '../../src/contracts/index.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';

/**
 * Eight tasks in one wave, each leaving an outbox, harvested out of order (M4-02).
 *
 * The property being proved is not "it works". It is that the *record* of a wave does not
 * depend on which agent happened to finish first — which is the same property MVP 2 spent
 * a milestone on for integration, restated for speech.
 *
 * There is one deliberate limitation, stated rather than hidden: this runs in one process
 * over an in-memory filesystem, so it cannot prove anything about two OS processes racing
 * `O_APPEND`. What it proves is that the *application* never interleaves, never allocates
 * a duplicate id, and never lets an ordering decide a projection.
 */

const PROJECT = '/wk/project';
const RUN = 'AF-2026-001';
const TASKS = Array.from({ length: 8 }, (_, index) => `TASK-00${String(index + 1)}`);

const GLOBAL = GlobalConfigSchema.parse({
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
});

const roster = deriveAgentRoster(GLOBAL);

function workspaceOf(taskId: string): string {
  return `/wk/worktrees/${RUN}/${taskId}`;
}

async function wave(order: readonly string[]): Promise<{
  fs: InMemoryFileSystem;
  store: CollaborationStore;
}> {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const state = new StateStore({ fs, clock, projectDir: PROJECT });
  await state.createRun('a feature');

  const store = new CollaborationStore({ fs, projectDir: PROJECT });
  const service = new CollaborationService({
    fs,
    clock,
    store: state,
    collaboration: store,
    roster,
    globalConfig: GLOBAL,
    config: CollaborationConfigSchema.parse({ enabled: true }),
  });

  for (const taskId of TASKS) {
    await fs.mkdirp(workspaceOf(taskId));
    fs.seed(
      agentOutboxPath(workspaceOf(taskId)),
      JSON.stringify({
        messages: [
          {
            to: { kind: 'everyone' },
            type: 'finding',
            subject: `finding from ${taskId}`,
            body: `${taskId} touched something worth saying`,
          },
        ],
        entries: [
          { kind: 'discovery', subject: `subject-${taskId}`, statement: `${taskId} discovered a thing` },
        ],
      }),
    );
  }

  // Sequential in the order given, which is what the scheduler's settle loop does: it
  // iterates `batch` order, not completion order. The point of varying the order is that
  // the *projection* must not vary with it.
  for (const taskId of order) {
    await service.harvest({
      runId: RUN,
      taskId,
      agentId: 'executor.normal',
      workspaceDir: workspaceOf(taskId),
    });
  }

  return { fs, store };
}

describe('a wave of eight agents, all speaking', () => {
  it('allocates a unique id to every message and every entry', async () => {
    const { store } = await wave(TASKS);

    const messages = await store.readMessages(RUN);
    const entries = await store.readEntries(RUN);

    expect(messages).toHaveLength(8);
    expect(new Set(messages.map((m) => m.id)).size).toBe(8);
    expect(new Set(entries.map((e) => e.id)).size).toBe(8);
  });

  it('gives every message its own thread, since none of them replies to anything', async () => {
    const { store } = await wave(TASKS);

    const threads = new Set((await store.readMessages(RUN)).map((m) => m.threadId));
    expect(threads.size).toBe(8);
  });

  it('attributes each message to the task that produced it', async () => {
    const { store } = await wave(TASKS);

    for (const message of await store.readMessages(RUN)) {
      expect(message.subject).toContain(message.taskId ?? 'none');
    }
  });

  it('writes whole lines only — no interleaving', async () => {
    const { fs } = await wave(TASKS);

    const raw = await fs.readFile(runPaths(PROJECT, RUN).messages);
    const lines = raw.split('\n').filter((line) => line.length > 0);

    expect(lines).toHaveLength(8);
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
  });

  it('produces the same set of facts however the wave settled', async () => {
    // The property MVP 2 spent a milestone on for integration, restated for speech:
    // agents finish out of order, and the record does not.
    const forwards = await wave(TASKS);
    const backwards = await wave([...TASKS].reverse());

    const factsOf = async (harness: Awaited<ReturnType<typeof wave>>) =>
      (await harness.store.readMessages(RUN))
        .map((message) => `${message.taskId ?? ''}:${message.type}:${message.subject}`)
        .sort();

    expect(await factsOf(forwards)).toEqual(await factsOf(backwards));
  });

  it('leaves no outbox behind in any workspace (I-32)', async () => {
    const { fs } = await wave(TASKS);

    for (const taskId of TASKS) {
      expect(await fs.exists(agentOutboxPath(workspaceOf(taskId))), taskId).toBe(false);
    }
  });

  it('bounds each task by its own budget rather than by the run’s traffic', async () => {
    // Seven tasks having spoken must not silence the eighth. A run-wide message budget
    // would let one task consume what the others needed.
    const { store } = await wave(TASKS);

    const perTask = new Map<string, number>();
    for (const message of await store.readMessages(RUN)) {
      const key = message.taskId ?? 'none';
      perTask.set(key, (perTask.get(key) ?? 0) + 1);
    }

    expect([...perTask.values()]).toEqual(Array.from({ length: 8 }, () => 1));
  });
});
