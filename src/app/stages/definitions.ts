import { PlanSchema, type RunStage, type WorkflowRole } from '../../contracts/index.js';
import { validateSdd } from '../../core/sdd-validator.js';
import type { StageDefinition } from '../stage-runner.js';
import { VERIFICATION_STAGE, FINAL_REVIEW_STAGE } from './final-review.js';

/**
 * The planning pipeline, as data.
 *
 * Each stage names a role, a prompt and where its output goes. Everything else —
 * resolution, invocation, validation, the repair loop, persistence — belongs to
 * the StageRunner, so adding a stage costs a prompt and an entry here.
 */

/**
 * Discovery maps the repository and says nothing about any feature.
 *
 * Feature-agnostic on purpose: the output is cached and reused across runs
 * (R-07), which removes one expensive call per feature. Its artifact therefore
 * lives outside the run directory.
 */
export const DISCOVERY_STAGE: StageDefinition = {
  name: 'discovery',
  role: 'architect',
  prompt: 'discovery',
};

/** What this particular feature reaches. Per-run, unlike discovery. */
export const ARCHITECTURE_IMPACT_STAGE: StageDefinition = {
  name: 'architecture-impact',
  role: 'architect',
  prompt: 'architecture-impact',
  artifact: 'architectureImpact',
};

/**
 * The SDD is the contract everything downstream is judged against, so it is
 * checked structurally before being accepted: a missing section is a blind spot
 * in planning and, later, a gap nobody notices in review.
 */
export const SDD_STAGE: StageDefinition = {
  name: 'sdd',
  role: 'sdd',
  prompt: 'sdd',
  artifact: 'sdd',
  validate: (_value, text) => validateSdd(text),
};

/**
 * Planning emits `plan.json`, validated against the schema. Coverage and graph
 * checks need the SDD as well, so they run in the stage wrapper rather than
 * here.
 */
export const PLANNING_STAGE: StageDefinition = {
  name: 'planning',
  role: 'planner',
  prompt: 'planning',
  artifact: 'plan',
  outputSchema: PlanSchema,
};

/**
 * Direct single-task Planning for TRIVIAL workflow (M2.1-C / P1-06).
 * Strictly limits decomposition to 1 task ceiling.
 */
export const PLANNING_TRIVIAL_STAGE: StageDefinition = {
  name: 'planning',
  role: 'planner',
  prompt: 'planning-trivial',
  artifact: 'plan',
  outputSchema: PlanSchema,
};

/**
 * Direct / Short Planning for SIMPLE workflows (M2.1-C).
 * Bypasses SDD and discovery, focusing directly on focused task decomposition.
 */
export const PLANNING_SIMPLE_STAGE: StageDefinition = {
  name: 'planning',
  role: 'planner',
  prompt: 'planning-simple',
  artifact: 'plan',
  outputSchema: PlanSchema,
};

/**
 * Lightweight Plan Review for SIMPLE workflow (M2.1-C).
 */
export const PLAN_REVIEW_SIMPLE_STAGE: StageDefinition = {
  name: 'plan-review',
  role: 'planReviewer',
  prompt: 'plan-review-simple',
};

/**
 * The role a stage answers to, derived from the definitions above rather than listed.
 *
 * Built from the shipped stages themselves, so it cannot drift: a stage whose role
 * changes changes this with it, and a stage added without one is absent rather than
 * wrong. `implementation` is deliberately not here — it has no single definition,
 * because its role is chosen per task from the task's complexity (`core/router.ts`).
 *
 * `undefined` is a real answer and callers must treat it as one: it means "this module
 * does not know", never "no role". The one caller today reads it to find a stage's
 * timeout, and answers *nothing* rather than guessing when the stage is unknown.
 */
export function roleForStage(stage: RunStage): WorkflowRole | undefined {
  const known: readonly StageDefinition[] = [
    DISCOVERY_STAGE,
    ARCHITECTURE_IMPACT_STAGE,
    SDD_STAGE,
    PLANNING_STAGE,
    PLAN_REVIEW_SIMPLE_STAGE,
    VERIFICATION_STAGE,
    FINAL_REVIEW_STAGE,
  ];

  return known.find((definition) => definition.name === stage)?.role;
}
