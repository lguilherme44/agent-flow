import { PIPELINE_STAGES, type PipelineStage, type StageViewResponse } from '@contracts/index.js';

export type PhaseId = 'plan' | 'approve' | 'build' | 'verify' | 'final';

/**
 * The five phases a person reads a run in, each owning the pipeline stages it runs.
 *
 * Eleven stages side by side did not fit: the stepper abbreviated them to `descob`,
 * `arquit` and `verif`, left implementation out altogether, and still showed `e2e` as a
 * step to come on a run that had it switched off (measured 23/09/2026). Five phases fit
 * with their whole names — on the run page and in the home's lanes alike.
 */
export const PHASES: readonly { readonly id: PhaseId; readonly stages: readonly PipelineStage[] }[] = [
  { id: 'plan', stages: ['discovery', 'architecture-impact', 'sdd', 'planning', 'plan-review'] },
  { id: 'approve', stages: ['approval'] },
  { id: 'build', stages: ['implementation', 'code-review'] },
  { id: 'verify', stages: ['verification', 'e2e'] },
  { id: 'final', stages: ['final-review'] },
];

const DONE = new Set(['completed', 'cached']);

export function isDone(status: string): boolean {
  return DONE.has(status);
}

/**
 * A stage still `pending` after a later stage moved did not run on this run, and never
 * will: a switched-off `e2e`, a `code-review` with no reviewer routed, a trivial workflow's
 * skipped discovery. Shown as a step to come, it reads as work outstanding on a finished run.
 */
export function skippedStages(statusOf: (stage: PipelineStage) => string): Set<PipelineStage> {
  const skipped = new Set<PipelineStage>();
  PIPELINE_STAGES.forEach((stage, index) => {
    if (statusOf(stage) !== 'pending') return;
    if (PIPELINE_STAGES.slice(index + 1).some((later) => statusOf(later) !== 'pending')) skipped.add(stage);
  });
  // Code review runs per task, inside implementation. Once implementation is done a
  // pending code review is one this run never used — not one still to come (AF-2026-005
  // read "Implementar, em andamento" with seven of seven tasks done).
  if (statusOf('code-review') === 'pending' && isDone(statusOf('implementation'))) skipped.add('code-review');
  return skipped;
}

/** One phase's status, from the stages of it that run. */
export function phaseStatus(statuses: readonly string[], finished: boolean): string {
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('waiting_approval')) return 'waiting_approval';
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.includes('running')) return 'running';
  if (statuses.length > 0 && statuses.every(isDone)) return 'completed';
  // Between two of its stages a phase is under way, unless the run itself has stopped.
  if (statuses.some(isDone)) return finished ? 'pending' : 'running';
  return 'pending';
}

export interface PhaseView {
  readonly id: PhaseId;
  readonly status: string;
  readonly durationMs: number;
  /** The first stage of the phase that is not done yet. */
  readonly current: PipelineStage | undefined;
  readonly stages: readonly { readonly stage: PipelineStage; readonly status: string; readonly view: StageViewResponse | undefined }[];
}

/**
 * The phases of one run, from the server's stage view; a phase with nothing left to show is dropped.
 *
 * `awaiting` is the run's gate when it is held for a person. `final_acceptance` waits on
 * `agent-flow review`, which is the verification and the final review — so the first of
 * those phases not yet done reads as waiting for you, rather than as not started.
 */
export function phasesOf(
  stages: readonly StageViewResponse[] | undefined,
  activeStage: string | undefined,
  finished: boolean,
  awaiting?: string,
): PhaseView[] {
  const byStage = new Map((stages ?? []).map((stage) => [stage.stage, stage]));
  const statusOf = (stage: PipelineStage): string =>
    byStage.get(stage)?.status ?? (activeStage === stage && !finished ? 'running' : 'pending');
  const skipped = skippedStages(statusOf);

  let held = awaiting === 'final_acceptance';
  return PHASES.map((phase) => {
    const shown = phase.stages.filter((stage) => !skipped.has(stage));
    let status = phaseStatus(shown.map(statusOf), finished);
    // Only the first of the two not done yet is what the gate waits on, and only while it
    // has not started: a running verification leaves the final review not started, not
    // waiting for a person.
    if (held && (phase.id === 'verify' || phase.id === 'final') && !isDone(status)) {
      if (status === 'pending') status = 'waiting_approval';
      held = false;
    }
    return {
      id: phase.id,
      status,
      durationMs: shown.reduce((sum, stage) => sum + (byStage.get(stage)?.durationMs ?? 0), 0),
      current: shown.find((stage) => !isDone(statusOf(stage))),
      stages: shown.map((stage) => ({ stage, status: statusOf(stage), view: byStage.get(stage) })),
    };
  }).filter((phase) => phase.stages.length > 0);
}
