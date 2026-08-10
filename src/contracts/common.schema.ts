import { z } from 'zod';

/**
 * Logical reasoning effort (§3.1).
 *
 * These are the only values the core ever sees. Each adapter translates them to
 * whatever its CLI accepts — Claude Code takes `xhigh`, Codex takes something
 * else. Letting a physical value reach the core would defeat the abstraction, so
 * the schema rejects them outright.
 */
export const REASONING_ORDER = ['low', 'medium', 'high', 'very_high'] as const;

export const ReasoningLevelSchema = z.enum(REASONING_ORDER);
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

/**
 * Logical roles the workflow addresses (§3). Stages resolve roles; they never
 * name a runner or a model.
 */
export const WORKFLOW_ROLES = [
  'architect',
  'sdd',
  'planner',
  'planReviewer',
  'executor.trivial',
  'executor.normal',
  'executor.complex',
  'verification',
  'finalReviewer',
] as const;

export const WorkflowRoleSchema = z.enum(WORKFLOW_ROLES);
export type WorkflowRole = z.infer<typeof WorkflowRoleSchema>;

/**
 * Normalised runner failures (§22.1). Adapters translate their CLI's error
 * vocabulary into these; the core decides on the code and never on the text.
 */
export const RUNNER_ERROR_CODES = [
  'quota_exceeded',
  'auth_required',
  'runner_unavailable',
  'timeout',
  'execution_failed',
  'invalid_output',
  'blocked',
] as const;

export const RunnerErrorCodeSchema = z.enum(RUNNER_ERROR_CODES);
export type RunnerErrorCode = z.infer<typeof RunnerErrorCodeSchema>;

/**
 * The only failures a fallback may react to (§55).
 *
 * Fallback is infrastructure, not a correction strategy. Retrying a poor
 * implementation on a different model buries a quality problem instead of
 * surfacing it, so the remaining codes are deliberately excluded here — at the
 * schema level, where config cannot opt back in.
 */
export const FALLBACK_TRIGGERS = ['quota_exceeded', 'auth_required', 'runner_unavailable'] as const;

export const FallbackTriggerSchema = z.enum(FALLBACK_TRIGGERS);
export type FallbackTrigger = z.infer<typeof FallbackTriggerSchema>;

/** Requirement ids carried by the SDD (§40) and referenced by tasks (§41). */
export const RequirementIdSchema = z
  .string()
  .regex(/^(FR|NFR|SEC)-\d{3}$/, 'expected FR-000, NFR-000 or SEC-000');

export const TaskIdSchema = z.string().regex(/^TASK-\d{3}$/, 'expected TASK-000');

export const FixTaskIdSchema = z.string().regex(/^FIX-\d{3}$/, 'expected FIX-000');

export const AnyTaskIdSchema = z.union([TaskIdSchema, FixTaskIdSchema]);

export const RunIdSchema = z.string().regex(/^AF-\d{4}-\d{3}$/, 'expected AF-YYYY-NNN');

/**
 * Identifier of a validation command declared in the project configuration.
 *
 * The shape is the first of two defences. A plan is written by a model, and the
 * repository's own contents feed the prompt that produces it — so plan content
 * is untrusted input. Before this existed, `Task.validation` was a free string
 * that the orchestrator handed to `/bin/sh -c`, which put model-authored text on
 * a shell *outside* the runner's sandbox, the only containment agent-flow has.
 *
 * Restricting the character set means no string accepted here can express a
 * command, a pipe, a redirect or a substitution. The second defence is
 * `checkPlan`, which requires the id to exist in the project configuration.
 */
export const ValidationIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    'expected the id of a validation command declared in the project config ' +
      '(lowercase letters, digits and dashes), not a shell command',
  );

export const IsoTimestampSchema = z.iso.datetime();
