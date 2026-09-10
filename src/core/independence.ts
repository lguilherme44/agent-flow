import type { Independence } from '../contracts/index.js';

/**
 * Whether a review was genuinely independent of the work it judged.
 *
 * Two mistakes are easy here, and the implementation this replaces made both.
 *
 * **Comparing intent instead of execution.** Independence used to be derived
 * from the *configured* runners. A fallback can change who actually ran, so a
 * reviewer that fell back onto the planner's runner still produced an artifact
 * claiming `cross-provider`. The guarantee stated on the artifact had not held.
 *
 * **Comparing runner ids instead of providers.** Two runner entries can point
 * at the same CLI:
 *
 * ```yaml
 * runners:
 *   claudePrimary: { type: claude-code-cli }
 *   claudeBackup:  { type: claude-code-cli }
 * ```
 *
 * Different ids, same model family, same training, same blind spots. Comparing
 * ids reports `cross-provider` for a review the model gave of its own work —
 * and this needs no fallback to happen, just that configuration.
 *
 * The point of cross-provider review (§3.2) is that one model should not confirm
 * its own mistaken hypothesis. Only the provider answers that question.
 */

/** How a runner is identified for independence: its adapter type, not its id. */
export type ProviderOf = (runnerId: string) => string | undefined;

/**
 * Can this configuration ever satisfy a HIGH-RISK plan review? (§3.2)
 *
 * **A question about configuration and about nothing else** — which is the whole reason it
 * is a fold here rather than a check inside the pipeline. It reads two runner ids and their
 * providers; it needs no run, no description, no repository and no clock. So it is
 * answerable at the moment somebody asks for a high-risk workflow, before anything has been
 * created.
 *
 * That mattered. The check lived only inside the pipeline, so a run explicitly requested in
 * HIGH-RISK on a single-provider setup was **created**, refused 2.2 seconds later, and left
 * in the history with no plan and no stages. Both facts the refusal rests on were known at
 * the moment of the request. It is C-19's rule — "refused before the lock, not inside it" —
 * applied to a path that had not received it.
 *
 * Returns the shared provider when the two collide, and `undefined` when the pair is fine
 * *or cannot be judged*. Undecidable is deliberately not a refusal: a runner whose provider
 * does not resolve is a misconfiguration the registry reports with a better sentence than
 * this one could.
 */
export function sharedReviewProvider(input: {
  readonly plannerRunner: string;
  readonly reviewerRunner: string;
  readonly providerOf: ProviderOf;
}): string | undefined {
  const planner = input.providerOf(input.plannerRunner);
  const reviewer = input.providerOf(input.reviewerRunner);
  if (planner === undefined || reviewer === undefined) return undefined;
  return planner === reviewer ? planner : undefined;
}

export function assessIndependence(
  authorRunners: readonly string[],
  reviewerRunner: string,
  providerOf: ProviderOf,
): Independence {
  const reviewerProvider = providerOf(reviewerRunner);

  // Two ways of not knowing, one answer. An unknown provider, or no recorded
  // author at all, means independence cannot be demonstrated — and claiming a
  // guarantee we cannot demonstrate is the failure mode worth avoiding.
  if (reviewerProvider === undefined) return 'same-provider-fresh-context';
  if (authorRunners.length === 0) return 'same-provider-fresh-context';

  const authorProviders = new Set(
    authorRunners.map((runner) => providerOf(runner) ?? reviewerProvider),
  );

  return authorProviders.has(reviewerProvider) ? 'same-provider-fresh-context' : 'cross-provider';
}

/** Explains the verdict, for the degradation recorded on the run. */
export function explainIndependence(
  authorRunners: readonly string[],
  reviewerRunner: string,
  providerOf: ProviderOf,
): string {
  const reviewerProvider = providerOf(reviewerRunner) ?? '(unknown)';
  const authors = [...new Set(authorRunners)].join(', ') || '(none)';

  return (
    `the review ran on "${reviewerRunner}" (${reviewerProvider}); ` +
    `the work it judges ran on ${authors}`
  );
}
