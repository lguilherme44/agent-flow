import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli/index.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { renderTimeline } from '../../src/cli/render/timeline.js';
import { buildRunTimeline } from '../../src/core/run-timeline.js';
import { en, ptBR } from '../../src/core/phrases/index.js';
import { StateStore } from '../../src/app/state-store.js';
import { runPaths } from '../../src/app/paths.js';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { RunEventSchema } from '../../src/contracts/index.js';
import { FixedClock } from '../fakes/fixed-clock.js';

/**
 * `agent-flow timeline` — the decomposition, in a terminal.
 *
 * The fold is tested in `test/core/run-timeline.test.ts`; what is tested here is that the
 * command finds the run (the current one when none is named), reads its result files, and
 * prints minutes and dollars where a person expects them.
 */

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { stdout: () => out.join(''), stderr: () => err.join('') };
}

let dir: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A completed run: twenty minutes of discovery, an hour's approval, one task validated. */
async function seededRun() {
  dir = mkdtempSync(join(tmpdir(), 'agent-flow-timeline-'));
  const fs = new NodeFileSystem();
  const clock = new FixedClock('2026-10-05T12:00:00.000Z');
  const store = new StateStore({ fs, clock, projectDir: dir });
  const run = await store.createRun('weekly recurrence');
  const step = async (minutes: number, type: string, detail: Record<string, unknown> = {}) => {
    clock.advance(minutes * 60_000);
    await store.appendEvent(run.runId, type, detail);
  };

  await step(0, 'stage_started', { stage: 'discovery' });
  await step(20, 'stage_completed', { stage: 'discovery', usage: { costUsd: 12 } });
  await step(60, 'run_approved');
  await step(0, 'task_started', { task: 'TASK-001' });
  await step(0, 'stage_started', { stage: 'implementation' });
  await step(10, 'stage_completed', { stage: 'implementation', usage: { costUsd: 3 } });
  await step(5, 'task_finished', { task: 'TASK-001', status: 'completed' });
  await store.updateRun(run.runId, (state) => ({
    ...state,
    status: 'completed',
    tasks: [{ id: 'TASK-001', state: 'completed', attempts: 1, infrastructureFailures: 0 }],
  }));
  await fs.writeFileAtomic(
    runPaths(dir, run.runId).taskResult('TASK-001'),
    JSON.stringify({
      task: 'TASK-001',
      status: 'completed',
      runner: 'r',
      reasoning: 'high',
      startedAt: '2026-10-05T13:20:00.000Z',
      finishedAt: '2026-10-05T13:35:00.000Z',
      validation: {
        passed: true,
        commands: [{ command: 'npm test', exitCode: 0, durationMs: 300_000 }],
      },
    }),
  );

  return { dir, runId: run.runId };
}

describe('agent-flow timeline', () => {
  it('prints the current run’s decomposition when no run is named', async () => {
    const { dir: cwd, runId } = await seededRun();
    const output = capture();

    const code = await main(['node', 'agent-flow', '--cwd', cwd, 'timeline']);

    expect(code).toBe(ExitCode.OK);
    const text = output.stdout();
    expect(text).toContain(en.timeline.heading(runId));
    expect(text).toMatch(/Wall clock\s+95\.0 minutes\s+\$15\.00/);
    expect(text).toMatch(/Model\s+30\.0\s+32%\s+\$15\.00/);
    expect(text).toMatch(/Validation\s+5\.0/);
    expect(text).toMatch(/Waiting for a person\s+60\.0/);
    expect(text).toMatch(/discovery\s+1\s+20\.0\s+12\.00/);
    expect(text).toContain(en.timeline.notABill);
  });

  it('prints the fold itself with --json, for a run named by id', async () => {
    const { dir: cwd, runId } = await seededRun();
    const output = capture();

    const code = await main(['node', 'agent-flow', '--cwd', cwd, '--json', 'timeline', runId]);

    expect(code).toBe(ExitCode.OK);
    const parsed = JSON.parse(output.stdout()) as { wallMs: number; validationMs: number; tasks: unknown[] };
    expect(parsed.wallMs).toBe(95 * 60_000);
    expect(parsed.validationMs).toBe(5 * 60_000);
    expect(parsed.tasks).toHaveLength(1);
  });

  it('refuses a run that does not exist, naming it', async () => {
    const { dir: cwd } = await seededRun();
    const output = capture();

    const code = await main(['node', 'agent-flow', '--cwd', cwd, 'timeline', 'AF-2026-999']);

    expect(code).toBe(ExitCode.EXECUTION_ERROR);
    expect(output.stderr()).toContain('AF-2026-999');
  });

  it('says there is no active run rather than failing, in a fresh project', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-flow-timeline-'));
    const output = capture();

    const code = await main(['node', 'agent-flow', '--cwd', dir, 'timeline']);

    expect(code).toBe(ExitCode.OK);
    expect(output.stdout()).toContain(en.timeline.noActiveRun);
  });

  it('answers --json with an error object, not prose, when there is no active run', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-flow-timeline-'));
    const output = capture();

    const code = await main(['node', 'agent-flow', '--cwd', dir, '--json', 'timeline']);

    expect(code).toBe(ExitCode.OK);
    expect(JSON.parse(output.stdout())).toEqual({ error: 'no_active_run', message: en.timeline.noActiveRun });
  });

  it('says the quota rule beside quota time, and says when a silent run was cut', () => {
    const timeline = buildRunTimeline(
      [
        RunEventSchema.parse({ at: '2026-10-05T12:00:00.000Z', type: 'stage_started', detail: { stage: 'sdd' } }),
        RunEventSchema.parse({
          at: '2026-10-05T12:01:00.000Z',
          type: 'stage_failed',
          detail: { stage: 'sdd', errorCode: 'quota_exceeded' },
        }),
      ],
      [],
      '2026-10-05T13:01:00.000Z',
    );

    const plain = renderTimeline(timeline, 'AF-2026-001');
    expect(plain).toContain(en.timeline.quotaNote);
    expect(plain).not.toContain(en.timeline.staleNote);
    expect(renderTimeline({ ...timeline, stale: true }, 'AF-2026-001')).toContain(en.timeline.staleNote);
  });

  it('renders from the phrase book it is given, and says "not reported" for an unpriced stage', () => {
    const at = (minute: number) => `2026-10-05T12:${String(minute).padStart(2, '0')}:00.000Z`;
    const timeline = buildRunTimeline(
      [
        RunEventSchema.parse({ at: at(0), type: 'stage_started', detail: { stage: 'sdd' } }),
        RunEventSchema.parse({ at: at(6), type: 'stage_completed', detail: { stage: 'sdd' } }),
      ],
      [],
    );

    const lines = renderTimeline(timeline, 'AF-2026-001', ptBR);

    expect(lines[0]).toBe(ptBR.timeline.heading('AF-2026-001'));
    expect(lines.find((line) => line.trimStart().startsWith('sdd'))).toContain(ptBR.timeline.notReported);
    // No money anywhere when no runner reported any.
    expect(lines.join('\n')).not.toContain('$');
  });
});
