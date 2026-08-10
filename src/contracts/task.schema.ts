import { z } from 'zod';
import { AnyTaskIdSchema, RequirementIdSchema, ValidationIdSchema } from './common.schema.js';
import { CorrectiveOriginSchema } from './review.schema.js';

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
 * Task states. The seven of §22, plus `interrupted`.
 *
 * A task reaches `ready` only once every dependency is `completed`; enforced by
 * the DAG, not by convention.
 *
 * `interrupted` is not in the specification and had to be added. The scheduler
 * persists `running` before invoking an agent, so a process killed in between
 * leaves a task that looks in-flight forever: `readyTasks` admits only `queued`
 * and `ready`, so the task could never be scheduled again and the run made no
 * further progress. Reusing `failed` would have been wrong — nothing failed, the
 * machine stopped — and losing that distinction would make the audit trail lie
 * about what happened.
 */
export const TASK_STATES = [
  'queued',
  'ready',
  'running',
  'interrupted',
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
     * Required and non-empty for planned work — see the refinement below.
     * Coverage checking (§41) only works if every task points at a requirement:
     * the §12 example omits this, the §46 interface demands it, and the check is
     * worthless without it.
     */
    requirements: z.array(RequirementIdSchema).default([]),

    /**
     * Set only on corrective tasks (§29), and the reason `requirements` is not
     * unconditionally required.
     *
     * A corrective task answers a *finding*, not a requirement. Demanding one
     * anyway is what produced the invented `FR-001`; the honest alternative is
     * to say where the task came from and leave the requirement empty when the
     * finding named none.
     */
    correctiveFor: CorrectiveOriginSchema.optional(),

    files: z.object({ likely: z.array(z.string()).default([]) }).prefault({}),
    // prefault, not default: the nested field defaults must actually be applied
    // when a planner omits the object entirely.
    flags: TaskFlagsSchema.prefault({}),

    acceptanceCriteria: z.array(z.string().min(1)).min(1, 'a task must state how it is judged done'),
    /**
     * Ids of validation commands, resolved against the project configuration by
     * the orchestrator (AD-10). Never the commands themselves: a plan is model
     * output, and model output must not reach a shell.
     */
    validation: z.array(ValidationIdSchema).default([]),

    /**
     * What the validation is expected to do.
     *
     * `pass` is the ordinary case. `fail` exists because test-first development
     * has a step where a green suite is the failure: the task that writes the
     * RED tests is done correctly when they fail, and the previous model — exit
     * code zero means success — marked exactly that task `review_required`.
     *
     * A real plan hit this. Three reviews had asked for test-first work and none
     * noticed that the resulting task carried a validation command that could
     * not pass at that point.
     *
     * `fail` is not permission to ignore the result: a RED task whose tests
     * *pass* is also reported, because either the test asserts nothing or the
     * behaviour already exists. Both are worth a person's attention.
     */
    validationExpectation: z.enum(['pass', 'fail', 'none']).default('pass'),
  })
  .refine((task) => !task.dependencies.includes(task.id), {
    message: 'a task cannot depend on itself',
    path: ['dependencies'],
  })
  .refine((task) => task.correctiveFor !== undefined || task.requirements.length > 0, {
    // The exception is narrow on purpose. Planned tasks still must cite a
    // requirement, because that citation is the whole basis of coverage
    // checking; only a task that carries its own provenance — a finding — is
    // allowed to have none, and it is not allowed to be silent about why.
    message: 'a task must implement at least one requirement unless it is corrective',
    path: ['requirements'],
  })
  .refine((task) => task.validationExpectation !== 'fail' || task.validation.length > 0, {
    // A RED task with nothing to run is a contradiction the plan cannot hold:
    // the whole point of `fail` is that a specific command must fail *now*, and
    // an empty list makes the expectation unfalsifiable. Worse, it reads as
    // satisfied — no command failed, but none could — so a test-first task that
    // never wrote a test would have passed its own gate.
    message: "validationExpectation 'fail' requires at least one validation id to fail",
    path: ['validation'],
  });

export type Task = z.infer<typeof TaskSchema>;
