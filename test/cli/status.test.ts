import { describe, it, expect } from 'vitest';
import { renderIsolatedProgress, renderPlanningProgress } from '../../src/cli/status.js';
import { RunStateSchema, type RunState } from '../../src/contracts/index.js';

/**
 * Found by killing a run mid-discovery, not by reading the code.
 *
 * `status` inferred progress from `state.stage`, and two things conspired.
 * `createRun` initialises `stage: 'discovery'`, so a run that had executed
 * nothing already claimed to be at the first stage; and the marker was
 *
 *   index < reached ? '✓' : index === reached ? '✓' : '·'
 *
 * a nested ternary whose first two branches are the same value — the residue of
 * a version that distinguished "done" from "in progress" and was collapsed
 * without being simplified. Together they printed `Discovery ✓` for a run whose
 * event log contained a single `stage_started` and no completion at all.
 *
 * Progress is now read from `stage_completed` events, which are written after
 * the work, not before it.
 */
describe('planning progress is read from what completed', () => {
  it('claims nothing for a run that has only started', () => {
    const lines = renderPlanningProgress([], 'discovery', 'running');

    expect(lines.find((line) => line.includes('Discovery'))).toContain('…');
    expect(lines.find((line) => line.includes('Architecture'))).toContain('·');
  });

  it('marks a stage done only once it has completed', () => {
    const lines = renderPlanningProgress(['discovery'], 'architecture-impact', 'running');

    expect(lines.find((line) => line.includes('Discovery'))).toContain('✓');
    expect(lines.find((line) => line.includes('Architecture'))).toContain('…');
    expect(lines.find((line) => line.includes('SDD'))).toContain('·');
  });

  it('does not show a stage as running when the run is not', () => {
    // A killed process leaves `status: running` behind on disk. The stage it
    // died in is neither done nor in flight, and saying "…" would be as wrong
    // as saying "✓" — it suggests something is still happening.
    const lines = renderPlanningProgress(['discovery'], 'architecture-impact', 'waiting_for_approval');

    expect(lines.find((line) => line.includes('Architecture'))).toContain('·');
  });

  it('marks every completed stage regardless of order in the log', () => {
    const lines = renderPlanningProgress(
      ['sdd', 'discovery', 'architecture-impact'],
      'planning',
      'running',
    );

    for (const label of ['Discovery', 'Architecture', 'SDD']) {
      expect(lines.find((line) => line.includes(label))).toContain('✓');
    }
  });

  it('shows the whole planning sequence, done or not', () => {
    const lines = renderPlanningProgress([], 'discovery', 'running');

    expect(lines).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// §21.4 — what an isolated run is doing (M2-10)
// ---------------------------------------------------------------------------

describe('renderIsolatedProgress (§21.4)', () => {
  const isolated = (patch: Partial<RunState> = {}): RunState =>
    RunStateSchema.parse({
      runId: 'AF-2026-001',
      feature: 'f',
      stage: 'implementation',
      status: 'running',
      isolationMode: 'worktree',
      gitRunKey: 'AF-2026-001-0f3a91c4bd27e615',
      planningBase: 'a'.repeat(40),
      createdAt: '2026-08-09T20:00:00.000Z',
      updatedAt: '2026-08-09T20:00:00.000Z',
      ...patch,
    });

  it('says nothing at all for a run that is not isolated', () => {
    // Printing empty headings for machinery a user never turned on is the tool
    // describing itself rather than their run (§25.1).
    const sequential = isolated({ isolationMode: 'none' });
    expect(renderIsolatedProgress(sequential, [])).toEqual([]);

    const legacy = RunStateSchema.parse({
      runId: 'AF-2026-002',
      feature: 'f',
      stage: 'planning',
      status: 'running',
      createdAt: '2026-08-09T20:00:00.000Z',
      updatedAt: '2026-08-09T20:00:00.000Z',
    });
    expect(renderIsolatedProgress(legacy, [])).toEqual([]);
  });

  it('names the branch, derived from the run key rather than stored', () => {
    const rendered = renderIsolatedProgress(isolated(), []).join('\n');

    expect(rendered).toContain('agent-flow/AF-2026-001-0f3a91c4bd27e615/integration');
    // No absolute path anywhere: a worktree path is a machine fact the artifact
    // deliberately does not record (§7.2, §21.3).
    expect(rendered).not.toContain('/.agent-flow/worktrees');
    expect(rendered.split('\n').some((line) => /\s\//.test(line))).toBe(false);
  });

  it('counts what is integrated, not what finished (I-3)', () => {
    const rendered = renderIsolatedProgress(
      isolated({
        tasks: [
          { id: 'TASK-001', state: 'completed', attempts: 1, infrastructureFailures: 0 },
          { id: 'TASK-002', state: 'running', attempts: 1, infrastructureFailures: 0 },
          { id: 'TASK-003', state: 'review_required', attempts: 1, infrastructureFailures: 0 },
        ],
        integrationHead: 'b'.repeat(40),
      }),
      [],
    ).join('\n');

    expect(rendered).toContain('integrated      1 of 3 task(s)');
    expect(rendered).toContain('bbbbbbbb');
  });

  it('lists attempt numbers only where a task was retried', () => {
    // A column of "1" teaches nobody anything; a "3" is the whole reason to look.
    const rendered = renderIsolatedProgress(
      isolated({
        tasks: [
          { id: 'TASK-001', state: 'completed', attempts: 1, infrastructureFailures: 0 },
          { id: 'TASK-002', state: 'running', attempts: 3, infrastructureFailures: 0 },
        ],
      }),
      [],
    ).join('\n');

    expect(rendered).toContain('attempts');
    expect(rendered).toContain('TASK-002');
    expect(rendered).not.toMatch(/TASK-001\s+1/);
  });

  it('names the conflicting paths and what to do about them (§15)', () => {
    const rendered = renderIsolatedProgress(isolated(), [
      { task: 'TASK-002', attempt: 1, paths: ['src/shared.ts', 'src/other.ts'] },
    ]).join('\n');

    expect(rendered).toContain('TASK-002 attempt 1 — src/shared.ts, src/other.ts');
    // A refusal with no next step is a dead end.
    expect(rendered).toContain('agent-flow retry');
  });
});
