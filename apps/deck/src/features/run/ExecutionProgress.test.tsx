import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PipelineStage, StageViewResponse } from '@contracts/index.js';
import { ExecutionProgress } from './ExecutionProgress';
import { phaseStatus, phasesOf, skippedStages } from '../../lib/phases';
import { ptBR as t } from '../../lib/i18n';

/** A finished run of a Python service, as the server served it on 23/09/2026. */
const FINISHED_RUN: StageViewResponse[] = [
  { stage: 'discovery', status: 'completed', durationMs: 797_040, model: 'claude-opus-5-5' },
  { stage: 'architecture-impact', status: 'completed', durationMs: 431_856 },
  { stage: 'sdd', status: 'completed', durationMs: 356_155 },
  { stage: 'planning', status: 'completed', durationMs: 124_379 },
  { stage: 'plan-review', status: 'completed', durationMs: 143_981 },
  { stage: 'approval', status: 'completed' },
  { stage: 'implementation', status: 'completed' },
  { stage: 'code-review', status: 'pending' },
  { stage: 'verification', status: 'completed', durationMs: 45_620 },
  { stage: 'e2e', status: 'pending' },
  { stage: 'final-review', status: 'completed', durationMs: 220_000 },
];

function progress(stages: StageViewResponse[], options: { activeStage?: string; finished?: boolean } = {}) {
  return render(
    <ExecutionProgress
      stages={stages}
      activeStage={options.activeStage}
      onOpenStageLog={vi.fn()}
      domain={[0, 1_000]}
      t={1_000}
      live
      finished={options.finished ?? true}
      onScrub={vi.fn()}
      tasksCount={{ total: 5, completed: 5, running: 0, attention: 0, queued: 0 }}
      showTimeline={false}
      onToggleTimeline={vi.fn()}
    />,
  );
}

describe('the phases of a run', () => {
  it('names every phase in full, implementation included', () => {
    // The stepper it replaced cut labels to `descob` / `arquit` / `verif` and had no step
    // for implementation at all.
    progress(FINISHED_RUN);

    for (const name of Object.values(t.run.phase)) {
      expect(screen.getByRole('button', { name: new RegExp(name) })).toBeInTheDocument();
    }
    expect(screen.getByText(t.run.phaseTasks(5, 5))).toBeInTheDocument();
  });

  it('does not offer a stage the run skipped as a step to come', () => {
    progress(FINISHED_RUN);

    fireEvent.click(screen.getByRole('button', { name: new RegExp(t.run.phase.verify) }));
    const stages = screen.getByText(t.run.phaseStagesOf(t.run.phase.verify)).parentElement as HTMLElement;
    expect(within(stages).getByText(t.stageLong.verification)).toBeInTheDocument();
    expect(within(stages).queryByText(t.stageLong.e2e)).not.toBeInTheDocument();
  });

  it('opens on the phase that holds the run', () => {
    const waiting = FINISHED_RUN.map((stage): StageViewResponse =>
      stage.stage === 'approval' ? { stage: 'approval', status: 'waiting_approval' } : ['discovery', 'architecture-impact', 'sdd', 'planning', 'plan-review'].includes(stage.stage) ? stage : { stage: stage.stage, status: 'pending' },
    );
    progress(waiting, { activeStage: 'approval', finished: false });

    expect(screen.getByRole('button', { name: new RegExp(t.run.phase.approve) })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(t.run.phaseWaiting)).toBeInTheDocument();
  });
});

describe('a run held for its final review', () => {
  /**
   * AF-2026-005 on 23/09/2026: every task done, held at `final_acceptance`. The phases read
   * "Implementar — em andamento" (its per-task code review sat at `pending`, a stage that
   * run never uses) and nothing said the run was waiting for a person.
   */
  const HELD: StageViewResponse[] = FINISHED_RUN.map((stage): StageViewResponse =>
    stage.stage === 'verification' || stage.stage === 'final-review' || stage.stage === 'e2e' ? { stage: stage.stage, status: 'pending' } : stage,
  );

  it('reads implementation as done, and the next phase as waiting for you', () => {
    render(
      <ExecutionProgress
        stages={HELD}
        activeStage="implementation"
        awaiting="final_acceptance"
        onOpenStageLog={vi.fn()}
        domain={[0, 1_000]}
        t={1_000}
        live
        finished={false}
        onScrub={vi.fn()}
        tasksCount={{ total: 7, completed: 7, running: 0, attention: 0, queued: 0 }}
        showTimeline={false}
        onToggleTimeline={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: new RegExp(t.run.phase.build) }).closest('[data-status]')).toHaveAttribute('data-status', 'completed');
    const verify = screen.getByRole('button', { name: new RegExp(t.run.phase.verify) });
    expect(verify).toHaveAttribute('aria-pressed', 'true');
    expect(verify).toHaveTextContent(t.run.phaseWaiting);
  });

  it('does not read the final review as waiting for you while verification runs', () => {
    // The gate is still `final_acceptance` while `review` runs: the phase not started yet
    // is not started, not a request to a person.
    const verifying = HELD.map((stage): StageViewResponse =>
      stage.stage === 'verification' ? { stage: 'verification', status: 'running' } : stage,
    );
    const phases = phasesOf(verifying, 'verification', false, 'final_acceptance');

    expect(phases.find((phase) => phase.id === 'verify')?.status).toBe('running');
    expect(phases.find((phase) => phase.id === 'final')?.status).toBe('pending');
  });
});

describe('skippedStages', () => {
  it('skips a pending stage only once a later one has moved', () => {
    const status = new Map<PipelineStage, string>(FINISHED_RUN.map((stage) => [stage.stage, stage.status]));
    expect([...skippedStages((stage) => status.get(stage) ?? 'pending')]).toEqual(['code-review', 'e2e']);

    // Mid-run nothing after the current stage has moved, so nothing is skipped yet.
    const midRun = (stage: PipelineStage): string => (stage === 'discovery' ? 'running' : 'pending');
    expect([...skippedStages(midRun)]).toEqual([]);
  });
});

describe('phaseStatus', () => {
  it('reads a phase between two of its stages as under way, unless the run stopped', () => {
    expect(phaseStatus(['completed', 'pending'], false)).toBe('running');
    expect(phaseStatus(['completed', 'pending'], true)).toBe('pending');
    expect(phaseStatus(['completed', 'failed'], true)).toBe('failed');
    expect(phaseStatus(['completed', 'cached'], true)).toBe('completed');
  });
});
