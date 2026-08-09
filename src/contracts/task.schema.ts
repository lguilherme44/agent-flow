import { z } from 'zod';
import { AnyTaskIdSchema, RequirementIdSchema } from './common.schema.js';

export const ComplexitySchema = z.enum(['trivial', 'normal', 'complex']);
export type Complexity = z.infer<typeof ComplexitySchema>;

export const RiskSchema = z.enum(['low', 'medium', 'high']);
export type Risk = z.infer<typeof RiskSchema>;

/** Routing inputs (§15). The planner classifies; the router decides. */
export const TaskFlagsSchema = z.object({
  databaseChange: z.boolean().default(false),
  crossModule: z.boolean().default(false),
  architectureDecision: z.boolean().default(false),
  externalIntegration: z.boolean().default(false),
});
export type TaskFlags = z.infer<typeof TaskFlagsSchema>;

/**
 * The seven task states of §22. A task reaches `ready` only once every
 * dependency is `completed`; enforced by the DAG in AF-07, not by convention.
 */
export const TASK_STATES = [
  'queued',
  'ready',
  'running',
  'completed',
  'failed',
  'blocked',
  'review_required',
] as const;

export const TaskStateSchema = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TaskSchema = z
  .object({
    id: AnyTaskIdSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    scope: z.string().optional(),
    /** Present for monorepos (§39); ignored until MVP 3. */
    workspace: z.string().optional(),

    complexity: ComplexitySchema,
    risk: RiskSchema,

    dependencies: z.array(AnyTaskIdSchema).default([]),

    /**
     * Required and non-empty. Coverage checking (§41) only works if every task
     * points at a requirement — the §12 example omits this, the §46 interface
     * demands it, and the check is worthless without it.
     */
    requirements: z.array(RequirementIdSchema).min(1, 'a task must implement at least one requirement'),

    files: z.object({ likely: z.array(z.string()).default([]) }).prefault({}),
    // prefault, not default: the nested field defaults must actually be applied
    // when a planner omits the object entirely.
    flags: TaskFlagsSchema.prefault({}),

    acceptanceCriteria: z.array(z.string().min(1)).min(1, 'a task must state how it is judged done'),
    /** Commands run by the orchestrator after the task (AD-10). */
    validation: z.array(z.string()).default([]),
  })
  .refine((task) => !task.dependencies.includes(task.id), {
    message: 'a task cannot depend on itself',
    path: ['dependencies'],
  });

export type Task = z.infer<typeof TaskSchema>;
