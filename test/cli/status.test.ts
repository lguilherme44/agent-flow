import { describe, it, expect } from 'vitest';
import { renderPlanningProgress } from '../../src/cli/status.js';

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
