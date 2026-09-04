/**
 * What the product may say about which model ran something (Issue #21).
 *
 * **Two states, and the third one was a fabrication.** An earlier draft of this seam
 * offered three — the model id, `Runner default` when a runner was recorded without a
 * model, and `Not reported` when neither was. The middle one reads as a measurement and
 * is not one. Every link behind it breaks somewhere:
 *
 *   - `task-executor.ts` persists `failure?.execution ?? execution ?? plannedExecution(role)`,
 *     and `plannedExecution` resolves the role with **no member** — so a record can carry
 *     a runner nothing spawned, and a member's pinned model is dropped while the role's
 *     runner is written in its place.
 *   - `runners.<id>.model` is a fourth place a model can be configured. It goes straight
 *     to the adapter and no execution record ever sees it, so an absent model can mean
 *     "pointed at a model nothing wrote down".
 *   - the openai-compatible adapter sends the literal string `'default'` when nothing is
 *     configured, so even "the CLI chose for itself" is not true of every runner.
 *
 * So the only honest reading of an absent model is that **nothing recorded one**, and
 * that is what this says.
 *
 * **A discriminant rather than a sentence, deliberately.** Three renderers show these
 * facts — the dashboard in two languages, and the CLI, which already spells the absence a
 * fourth way as `(runner default)`. English prose returned from `src/contracts` would
 * satisfy the i18n key-parity test by never having a key, and leave the screen half
 * translated. Prose belongs where the language does.
 *
 * **This module imports nothing, and that is load-bearing.** `apps/web`'s Vite config
 * states that every import through the `@contracts` alias is type-only so nothing from
 * the core is bundled, and `zod` is not a dependency of the dashboard — so a component
 * importing a *value* from the contracts barrel would pull zod into the browser bundle.
 * It resolves, nothing fails, and the invariant is quietly gone. Web code imports this
 * leaf by path instead, which it can only do while the leaf stays free of imports.
 *
 * Named `modelIdentity` and not `describeModel` because `app/stage-runner.ts` already has
 * a private `describeModel` that renders `on model "x"` into a sentence. One word, one
 * meaning.
 */

/**
 * The execution provenance any surface has, in the shape every view already carries.
 *
 * `runner` is accepted and deliberately unused for the verdict. It is here because every
 * caller has it and because the next person to reach for it should find the reason it is
 * not consulted written down rather than have to rediscover the three bullets above.
 */
export interface ModelProvenanceFacts {
  readonly runner?: string | undefined;
  readonly model?: string | undefined;
}

/** A model the record names, or the absence of one. There is no third case. */
export type ModelIdentity =
  | { readonly kind: 'model'; readonly model: string }
  | { readonly kind: 'not_reported' };

/**
 * The longest model id this will render whole.
 *
 * `TaskResultSchema.model` and `TaskAttemptResultSchema.model` are `z.string().optional()`
 * with **no `.min(1)` and no `.max()`** — unlike their configuration counterparts, which
 * have both. So an arbitrarily long string can reach a card, and a card is 244px wide.
 * CSS truncation handles the layout; this handles the pathological case, so a
 * hundred-kilobyte id cannot reach the DOM at all.
 *
 * Generous on purpose: real ids are under forty characters, and a bound that trims a
 * plausible id would be a lie of a different kind.
 */
export const MODEL_ID_MAX = 120;

/**
 * What may be said about the model behind one invocation.
 *
 * **A blank string is an absence, and the schemas allow one.** `model: ""` parses today,
 * and a reader guarding on `=== undefined` projects it as *present* — so without this,
 * the honest "nothing recorded a model" would render as an empty cell that looks like a
 * rendering fault. Whitespace-only is the same case.
 */
export function modelIdentity(facts: ModelProvenanceFacts): ModelIdentity {
  const model = facts.model?.trim();
  if (model === undefined || model === '') return { kind: 'not_reported' };

  return {
    kind: 'model',
    model: model.length > MODEL_ID_MAX ? `${model.slice(0, MODEL_ID_MAX - 1)}…` : model,
  };
}

/** The model id when one was recorded, and `undefined` when none was. */
export function recordedModel(facts: ModelProvenanceFacts): string | undefined {
  const identity = modelIdentity(facts);
  return identity.kind === 'model' ? identity.model : undefined;
}
