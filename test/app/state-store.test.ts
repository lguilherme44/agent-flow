import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { StateStore, StateError } from '../../src/app/state-store.js';
import { runPaths, agentFlowPaths } from '../../src/app/paths.js';

const PROJECT = '/repo';

function makeStore(fs = new InMemoryFileSystem(), clock = new FixedClock()) {
  return { store: new StateStore({ fs, clock, projectDir: PROJECT }), fs, clock };
}

describe('layout (R-01)', () => {
  it('keeps every content artifact inside the run directory', () => {
    // The spec puts sdd.md and plan.json at the root of .agent-flow while also
    // giving each run its own folder. Two concurrent features would overwrite
    // each other. Everything with content lives under the run.
    const paths = runPaths(PROJECT, 'AF-2026-001');

    expect(paths.dir).toBe('/repo/.agent-flow/runs/AF-2026-001');
    expect(paths.state).toBe('/repo/.agent-flow/runs/AF-2026-001/state.json');
    expect(paths.sdd).toBe('/repo/.agent-flow/runs/AF-2026-001/sdd.md');
    expect(paths.plan).toBe('/repo/.agent-flow/runs/AF-2026-001/plan.json');
    expect(paths.events).toBe('/repo/.agent-flow/runs/AF-2026-001/events.jsonl');
  });

  it('leaves only config, the run pointer and the cache at the root', () => {
    const paths = agentFlowPaths(PROJECT);
    expect(paths.config).toBe('/repo/.agent-flow/config.yaml');
    expect(paths.currentRun).toBe('/repo/.agent-flow/current-run');
    // Discovery is feature-agnostic, so its artifact is shared across runs (R-07).
    expect(paths.architectureCache).toBe('/repo/.agent-flow/cache/architecture.md');
  });
});

describe('creating a run', () => {
  it('allocates AF-YYYY-NNN starting at 001', async () => {
    const { store } = makeStore();
    const run = await store.createRun('recurring-bookings');
    expect(run.runId).toBe('AF-2026-001');
    expect(run.status).toBe('running');
    expect(run.stage).toBe('discovery');
    expect(run.approved).toBe(false);
  });

  it('increments the sequence for further runs in the same year', async () => {
    const { store } = makeStore();
    await store.createRun('first');
    const second = await store.createRun('second');
    expect(second.runId).toBe('AF-2026-002');
  });

  it('lets two runs coexist without touching each other (R-01)', async () => {
    // The concrete failure the layout change exists to prevent.
    const { store, fs } = makeStore();
    const first = await store.createRun('feature-a');
    await store.writeArtifact(first.runId, 'sdd', '# SDD for A');

    const second = await store.createRun('feature-b');
    await store.writeArtifact(second.runId, 'sdd', '# SDD for B');

    expect(await fs.readFile(runPaths(PROJECT, first.runId).sdd)).toBe('# SDD for A');
    expect(await fs.readFile(runPaths(PROJECT, second.runId).sdd)).toBe('# SDD for B');
  });

  it('points current-run at the newest run', async () => {
    const { store } = makeStore();
    await store.createRun('first');
    const second = await store.createRun('second');
    expect(await store.currentRunId()).toBe(second.runId);
  });

  it('records a creation event', async () => {
    const { store } = makeStore();
    const run = await store.createRun('recurring-bookings');
    const events = await store.readEvents(run.runId);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('run_created');
    expect(events[0]?.at).toBe('2026-08-09T20:00:00.000Z');
  });
});

describe('atomic persistence (AD-06)', () => {
  it('writes through a temp file before replacing state.json', async () => {
    const { store, fs } = makeStore();
    const run = await store.createRun('f');
    fs.writes.length = 0;

    await store.updateRun(run.runId, (state) => ({ ...state, stage: 'sdd' }));

    expect(fs.writes[0]).toMatch(/\.tmp$/);
    expect(fs.writes.at(-1)).toBe(runPaths(PROJECT, run.runId).state);
  });

  it('leaves the previous state readable when a write is interrupted', async () => {
    // Killing the terminal mid-write must not cost the run.
    const { store, fs } = makeStore();
    const run = await store.createRun('f');
    await store.updateRun(run.runId, (state) => ({ ...state, stage: 'sdd' }));

    fs.failNextAtomicWriteAfterTemp = true;
    await expect(
      store.updateRun(run.runId, (state) => ({ ...state, stage: 'planning' })),
    ).rejects.toThrow();

    const recovered = await store.loadRun(run.runId);
    expect(recovered.stage).toBe('sdd');
  });

  it('validates state on read so corruption is caught, not propagated', async () => {
    const { store, fs } = makeStore();
    const run = await store.createRun('f');
    fs.seed(runPaths(PROJECT, run.runId).state, '{"runId":"nonsense"}');

    await expect(store.loadRun(run.runId)).rejects.toThrowError(StateError);
  });

  it('reports a missing run clearly', async () => {
    const { store } = makeStore();
    await expect(store.loadRun('AF-2026-404')).rejects.toThrowError(StateError);
  });
});

describe('timestamps', () => {
  it('advances updatedAt but preserves createdAt', async () => {
    const { store, clock } = makeStore();
    const run = await store.createRun('f');

    clock.advance(60_000);
    const updated = await store.updateRun(run.runId, (state) => ({ ...state, stage: 'sdd' }));

    expect(updated.createdAt).toBe('2026-08-09T20:00:00.000Z');
    expect(updated.updatedAt).toBe('2026-08-09T20:01:00.000Z');
  });
});

describe('events are an append-only audit trail (AD-06)', () => {
  it('appends without rewriting earlier entries', async () => {
    const { store } = makeStore();
    const run = await store.createRun('f');

    await store.appendEvent(run.runId, 'stage_started', { stage: 'sdd' });
    await store.appendEvent(run.runId, 'stage_completed', { stage: 'sdd' });

    const events = await store.readEvents(run.runId);
    expect(events.map((e) => e.type)).toEqual(['run_created', 'stage_started', 'stage_completed']);
    expect(events[1]?.detail).toEqual({ stage: 'sdd' });
  });

  it('survives a trailing newline and ignores blank lines', async () => {
    const { store, fs } = makeStore();
    const run = await store.createRun('f');
    await fs.appendFile(runPaths(PROJECT, run.runId).events, '\n\n');
    expect(await store.readEvents(run.runId)).toHaveLength(1);
  });
});

describe('degradations survive resume (R-16)', () => {
  it('persists a degradation on the run', async () => {
    // The whole point: a DEGRADED environment must still be visible tomorrow,
    // not just in the terminal output of the command that detected it.
    const { store } = makeStore();
    const run = await store.createRun('f');

    await store.recordDegradation(run.runId, {
      kind: 'single_provider',
      reason: 'only claude is healthy',
      impact: 'plan review and final review cannot be cross-provider',
    });

    const reloaded = await store.loadRun(run.runId);
    expect(reloaded.degradations).toHaveLength(1);
    expect(reloaded.degradations[0]?.kind).toBe('single_provider');
    expect(reloaded.degradations[0]?.detectedAt).toBe('2026-08-09T20:00:00.000Z');
  });

  it('does not record the same degradation twice', async () => {
    const { store } = makeStore();
    const run = await store.createRun('f');
    const degradation = {
      kind: 'single_provider' as const,
      reason: 'only claude is healthy',
      impact: 'reviews are same-provider',
    };

    await store.recordDegradation(run.runId, degradation);
    await store.recordDegradation(run.runId, degradation);

    expect((await store.loadRun(run.runId)).degradations).toHaveLength(1);
  });

  it('logs a degradation as an event as well', async () => {
    const { store } = makeStore();
    const run = await store.createRun('f');
    await store.recordDegradation(run.runId, {
      kind: 'reasoning_clamped',
      reason: 'fallback runner tops out at high',
      impact: 'architect runs below the configured level',
    });

    const events = await store.readEvents(run.runId);
    expect(events.map((e) => e.type)).toContain('degradation_detected');
  });
});

describe('resume', () => {
  it('reloads the active run from disk', async () => {
    // Closing the terminal and running `agent-flow status` again must work.
    const fs = new InMemoryFileSystem();
    const first = makeStore(fs);
    const run = await first.store.createRun('recurring-bookings');
    await first.store.updateRun(run.runId, (state) => ({ ...state, stage: 'planning' }));

    const fresh = makeStore(fs).store;
    const current = await fresh.loadCurrentRun();

    expect(current?.runId).toBe(run.runId);
    expect(current?.stage).toBe('planning');
  });

  it('returns null when no run has been started', async () => {
    expect(await makeStore().store.loadCurrentRun()).toBeNull();
  });

  it('lists runs newest first', async () => {
    const { store } = makeStore();
    await store.createRun('a');
    await store.createRun('b');
    expect(await store.listRunIds()).toEqual(['AF-2026-002', 'AF-2026-001']);
  });
});

describe('artifacts', () => {
  it('round-trips an artifact through the run directory', async () => {
    const { store } = makeStore();
    const run = await store.createRun('f');
    await store.writeArtifact(run.runId, 'plan', '{"feature":"f"}');
    expect(await store.readArtifact(run.runId, 'plan')).toBe('{"feature":"f"}');
  });

  it('returns null for an artifact that does not exist yet', async () => {
    const { store } = makeStore();
    const run = await store.createRun('f');
    expect(await store.readArtifact(run.runId, 'sdd')).toBeNull();
  });
});
