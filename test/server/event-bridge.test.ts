import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { StateStore } from '../../src/app/state-store.js';
import {
  RunWatcher,
  createEventBus,
  toServerEventType,
} from '../../src/server/event-bridge.js';
import { registryOf } from '../../src/server/project-registry.js';
import { RunEventSchema, type ServerEvent } from '../../src/contracts/index.js';

/**
 * UI-05 — the event bridge.
 *
 * The bridge is a reader, not a store. Everything it publishes came out of
 * `events.jsonl` and `state.json`, and a client that missed a message and
 * re-fetched over HTTP would get the same answer from the same files.
 */

const PROJECT = { id: 'demo', name: 'demo', path: '/repo' };

const event = (type: string, detail: Record<string, unknown> = {}) =>
  RunEventSchema.parse({ at: '2026-08-10T20:00:00.000Z', type, detail });

async function world() {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const bus = createEventBus();
  const received: ServerEvent[] = [];
  bus.subscribe((incoming) => received.push(incoming));

  const watcher = new RunWatcher({
    fs,
    clock,
    registry: registryOf([PROJECT]),
    bus,
    intervalMs: 10,
  });

  return { fs, clock, store, bus, watcher, received };
}

describe('createEventBus', () => {
  it('delivers to every subscriber', () => {
    const bus = createEventBus();
    const seen: string[] = [];
    bus.subscribe((incoming) => seen.push(`a:${incoming.type}`));
    bus.subscribe((incoming) => seen.push(`b:${incoming.type}`));

    bus.publish({
      type: 'run.updated',
      projectId: 'demo',
      runId: 'AF-2026-001',
      timestamp: '2026-08-10T20:00:00.000Z',
      payload: {},
    });

    expect(seen).toEqual(['a:run.updated', 'b:run.updated']);
  });

  it('survives a listener that unsubscribes while being notified', () => {
    // A browser disconnecting mid-broadcast is the ordinary case, not an edge.
    const bus = createEventBus();
    const seen: string[] = [];

    const off = bus.subscribe(() => {
      off();
      seen.push('first');
    });
    bus.subscribe(() => seen.push('second'));

    expect(() =>
      bus.publish({
        type: 'run.updated',
        projectId: 'demo',
        runId: 'AF-2026-001',
        timestamp: '2026-08-10T20:00:00.000Z',
        payload: {},
      }),
    ).not.toThrow();
    expect(seen).toEqual(['first', 'second']);
    expect(bus.size).toBe(1);
  });
});

describe('toServerEventType', () => {
  it.each([
    ['run_created', 'run.created'],
    ['stage_started', 'stage.started'],
    ['stage_completed', 'stage.completed'],
    ['stage_failed', 'stage.failed'],
    ['task_started', 'task.started'],
    ['run_approved', 'approval.completed'],
  ])('maps %s to %s', (from, to) => {
    expect(toServerEventType(event(from))).toBe(to);
  });

  it('splits task_finished by what actually happened', () => {
    expect(toServerEventType(event('task_finished', { status: 'completed' }))).toBe(
      'task.completed',
    );
    expect(toServerEventType(event('task_finished', { status: 'failed' }))).toBe('task.failed');
    expect(toServerEventType(event('task_finished', { status: 'blocked' }))).toBe(
      'task.blocked',
    );
  });

  it('still delivers an event type it has never seen', () => {
    // A new workflow event must never make the dashboard go quiet — silence
    // looks exactly like nothing happening.
    expect(toServerEventType(event('something_new'))).toBe('run.updated');
  });
});

describe('RunWatcher', () => {
  it('publishes new events and nothing else', async () => {
    const w = await world();
    const run = await w.store.createRun('f');
    await w.watcher.prime();

    await w.store.appendEvent(run.runId, 'stage_started', { stage: 'discovery' });
    await w.watcher.sweep({ publish: true });

    expect(w.received.map((incoming) => incoming.type)).toEqual(['stage.started']);

    // A second sweep with nothing new says nothing.
    await w.watcher.sweep({ publish: true });
    expect(w.received).toHaveLength(1);
  });

  it('carries the envelope of §87', async () => {
    const w = await world();
    const run = await w.store.createRun('f');
    await w.watcher.prime();

    await w.store.appendEvent(run.runId, 'task_started', { task: 'TASK-001' });
    await w.watcher.sweep({ publish: true });

    expect(w.received[0]).toMatchObject({
      type: 'task.started',
      projectId: 'demo',
      runId: run.runId,
      timestamp: '2026-08-09T20:00:00.000Z',
    });
    expect(w.received[0]?.payload).toMatchObject({ event: 'task_started', task: 'TASK-001' });
  });

  it('notices a state change that produced no event', async () => {
    const w = await world();
    const run = await w.store.createRun('f');
    await w.watcher.prime();

    w.clock.advance(1_000);
    await w.store.updateRun(run.runId, (state) => ({
      ...state,
      status: 'waiting_for_approval',
    }));

    await w.watcher.sweep({ publish: true });

    const types = w.received.map((incoming) => incoming.type);
    expect(types).toContain('run.updated');
    expect(types).toContain('approval.requested');
  });

  it('announces a run that appeared after start-up', async () => {
    const w = await world();
    await w.watcher.prime();

    const run = await w.store.createRun('later');
    await w.watcher.sweep({ publish: true });

    expect(w.received.map((incoming) => incoming.type)).toContain('run.created');
    expect(w.received[0]?.runId).toBe(run.runId);
  });

  it('replays nothing it saw while priming', async () => {
    const w = await world();
    const run = await w.store.createRun('f');
    await w.store.appendEvent(run.runId, 'stage_completed', { stage: 'discovery' });

    await w.watcher.prime();
    await w.watcher.sweep({ publish: true });

    expect(w.received).toEqual([]);
  });

  it('reports a finished run once', async () => {
    const w = await world();
    const run = await w.store.createRun('f');
    await w.watcher.prime();

    w.clock.advance(1_000);
    await w.store.updateRun(run.runId, (state) => ({ ...state, status: 'completed' }));
    await w.watcher.sweep({ publish: true });
    await w.watcher.sweep({ publish: true });

    const completions = w.received.filter((incoming) => incoming.type === 'run.completed');
    expect(completions).toHaveLength(1);
  });

  it('keeps going when one run is unreadable', async () => {
    const w = await world();
    const run = await w.store.createRun('f');
    await w.watcher.prime();

    // A half-written state file must not take the whole stream down.
    w.fs.seed('/repo/.agent-flow/runs/AF-2026-002/state.json', '{ not json');
    await w.store.appendEvent(run.runId, 'stage_started', { stage: 'sdd' });

    await expect(w.watcher.sweep({ publish: true })).resolves.toBeUndefined();
    expect(w.received.map((incoming) => incoming.type)).toEqual(['stage.started']);
  });
});
