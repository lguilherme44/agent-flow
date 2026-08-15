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

export const PlanSchema = z
  .object({
    feature: z.string().min(1),
    tasks: z.array(TaskSchema).min(1, 'a plan must contain at least one task'),
    findingProposals: z.array(FindingProposalSchema).default([]),
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
