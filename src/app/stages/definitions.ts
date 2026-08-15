import { PlanSchema } from '../../contracts/index.js';
import { validateSdd } from '../../core/sdd-validator.js';
import type { StageDefinition } from '../stage-runner.js';

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
 * Direct / Short Planning for TRIVIAL and SIMPLE workflows (M2.1-C).
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
