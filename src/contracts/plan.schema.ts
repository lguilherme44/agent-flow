import { z } from 'zod';
import { TaskSchema } from './task.schema.js';

export const FindingProposalStatusSchema = z.enum([
  'RESOLVED',
  'SUPERSEDED',
  'PROPOSE_ACCEPT_WITH_RATIONALE',
]);
export type FindingProposalStatus = z.infer<typeof FindingProposalStatusSchema>;

export const FindingProposalSchema = z.object({
  findingIndex: z.number().int().min(0),
  status: FindingProposalStatusSchema,
  rationale: z.string().optional(),
});
export type FindingProposal = z.infer<typeof FindingProposalSchema>;

/**
 * A measurement the plan says a person must make, because the executor cannot (FR-017).
 *
 * A build of another branch, a cherry-pick, a device matrix: things a task would otherwise
 * ask of an agent that has no grant to run them, which then stops BLOCKED mid-run. Never a
 * task — nothing schedules it, and nothing records it as done.
 */
export const OperatorVerificationSchema = z.object({
  check: z.string().min(1),
  reason: z.string().min(1),
});
export type OperatorVerification = z.infer<typeof OperatorVerificationSchema>;

export const PlanSchema = z
  .object({
    feature: z.string().min(1),
    tasks: z.array(TaskSchema).min(1, 'a plan must contain at least one task'),
    findingProposals: z.array(FindingProposalSchema).default([]),
    // Optional and never defaulted (NFR-001): a default would write `[]` into every plan
    // parsed from now on, so a plan without it would no longer serialize as it did — and
    // `final-review.json`, which embeds the plan, would change for runs that never used it.
    operatorVerifications: z.array(OperatorVerificationSchema).optional(),
  })
  .superRefine((plan, ctx) => {
    // Duplicate ids would silently collapse the DAG: two nodes, one key.
    const seen = new Set<string>();
    for (const [index, task] of plan.tasks.entries()) {
      if (seen.has(task.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate task id ${task.id}`,
          path: ['tasks', index, 'id'],
        });
      }
      seen.add(task.id);
    }
  });

export type Plan = z.infer<typeof PlanSchema>;
