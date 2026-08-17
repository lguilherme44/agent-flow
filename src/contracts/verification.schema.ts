import { z } from 'zod';
import { FindingSchema } from './review.schema.js';
import { CommandResultSchema } from './result.schema.js';

/**
 * The verification artifact, and the three-valued mechanical verdict (AD-45, AR §8.7).
 *
 * **Its own file, and the reason is an import cycle rather than taste.** This shape needs
 * `FindingSchema` from `review.schema.ts` and `CommandResultSchema` from
 * `result.schema.ts`, and `result` already reaches `state` → `task` → `review`. Declaring
 * it inside `review.schema.ts` closed that loop, and a Zod schema evaluated mid-cycle sees
 * `undefined` where a member should be — which surfaces as "expected a Zod schema" at
 * import time, far from the file that caused it. A leaf module that both sides can be
 * read by has no such problem.
 */

/**
 * Whether the project's own commands could answer, and what they said (AD-45).
 *
 * Three values where the current model has two, and `NOT_RUN` is the missing one. An
 * unprepared workspace produces exit codes that describe the *environment* and get
 * read as a verdict on the *code* — the evidence run printed `Verification: PASS`, the
 * model's semantic verdict, directly beneath four mechanical `✗` from exit 127, and the
 * operator reasonably concluded the tool was lying. The Definition of Done was in fact
 * correct; the rendering was not.
 *
 * `NOT_RUN` makes the Definition of Done `not done` and suppresses both model verdicts
 * as conclusions about the code, because they were formed against an environment that
 * could not answer (I-24).
 */
export const MECHANICAL_VERDICTS = ['PASS', 'FAIL', 'NOT_RUN'] as const;

export const MechanicalVerdictSchema = z.enum(MECHANICAL_VERDICTS);
export type MechanicalVerdict = z.infer<typeof MechanicalVerdictSchema>;

export const MechanicalVerificationSchema = z
  .object({
    verdict: MechanicalVerdictSchema,
    commands: z.array(CommandResultSchema).default([]),
    /** Verification steps the project declares no command for. */
    skipped: z.array(z.string()).default([]),
    workspacePrepared: z.boolean(),
    /** Required when the verdict is NOT_RUN — see the refinement. */
    notRunReason: z.string().min(1).optional(),
  })
  .refine((mechanical) => mechanical.verdict !== 'NOT_RUN' || mechanical.notRunReason !== undefined, {
    // `NOT_RUN` with no reason is the shape AR §3.6 forbids in words: "something
    // failed, inspect logs" is a contract violation, and an unexplained NOT_RUN is
    // that sentence with the words removed.
    message: 'a NOT_RUN verification must say why it could not run',
    path: ['notRunReason'],
  });
export type MechanicalVerification = z.infer<typeof MechanicalVerificationSchema>;

/**
 * The model's half of a verification, in the shape the split artifact stores it.
 *
 * Named rather than inlined so {@link semanticVerificationOf} can *derive* its return type
 * from it. A hand-written `{ verdict; findings; summary? }` looked equivalent and was not:
 * under `exactOptionalPropertyTypes` — which the dashboard's tsconfig sets and the root's
 * does not — `summary?: string` and `summary?: string | undefined` are different types, so
 * the normaliser failed to compile in one workspace and not the other.
 */
export const SemanticVerificationSchema = z.object({
  verdict: z.enum(['PASS', 'FAIL']),
  findings: z.array(FindingSchema).default([]),
  summary: z.string().optional(),
});
export type SemanticVerification = z.infer<typeof SemanticVerificationSchema>;

/**
 * The verification artifact, in the two shapes a reader may find on disk (AD-45, §8.7).
 *
 * The legacy shape is the model's response at the top level — `{ verdict, summary,
 * findings }` — which is what every `reviews/verification.json` written before this
 * milestone holds, including the evidence run's. The new shape splits the two questions:
 * `mechanical` for what the commands found, `semantic` for what the model thought.
 *
 * Readers accept both, and never by sniffing for a `mechanical` key at the call site:
 * {@link semanticVerificationOf} and {@link mechanicalVerificationOf} are the two
 * accessors that decide which shape was found.
 */
export const VerificationArtifactSchema = z.object({
  mechanical: MechanicalVerificationSchema.optional(),
  semantic: SemanticVerificationSchema.optional(),
  // The legacy flat members, kept so a pre-milestone artifact parses as itself rather
  // than as an empty object with two absent sections.
  verdict: z.enum(['PASS', 'FAIL']).optional(),
  findings: z.array(FindingSchema).optional(),
  summary: z.string().optional(),
});
export type VerificationArtifact = z.infer<typeof VerificationArtifactSchema>;

/**
 * The semantic half of a verification artifact, whichever shape it was written in.
 *
 * Returns `undefined` only for an artifact that carries neither — which a reader must
 * treat as "no semantic verdict was recorded", never as a `FAIL`.
 */
export function semanticVerificationOf(
  artifact: VerificationArtifact,
): SemanticVerification | undefined {
  if (artifact.semantic !== undefined) return artifact.semantic;
  if (artifact.verdict === undefined) return undefined;

  return {
    verdict: artifact.verdict,
    findings: artifact.findings ?? [],
    // Spread rather than `summary: artifact.summary`: under
    // `exactOptionalPropertyTypes` an explicit `undefined` is not the same as an absent
    // key, and the dashboard's tsconfig enables it.
    ...(artifact.summary === undefined ? {} : { summary: artifact.summary }),
  };
}

/**
 * The mechanical half, or `undefined` for a legacy artifact that has none.
 *
 * **`undefined` is not `NOT_RUN`.** A pre-milestone artifact predates the question
 * entirely: its commands did run, and their result was folded into a boolean somewhere
 * else. Reading absence as `NOT_RUN` would retroactively invalidate every run that
 * completed before this milestone, and reading it as `PASS` would be the silent-pass
 * path AD-45 exists to close. So the answer is "this artifact cannot say", and the
 * caller decides what to do with that.
 */
export function mechanicalVerificationOf(
  artifact: VerificationArtifact,
): MechanicalVerification | undefined {
  return artifact.mechanical;
}
