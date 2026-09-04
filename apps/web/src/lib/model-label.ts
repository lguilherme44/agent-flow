import {
  modelIdentity,
  recordedModel,
  type ModelProvenanceFacts,
} from '@contracts/model-identity.js';

/**
 * Re-exported so every model question in the dashboard comes through one door.
 *
 * A component that wants the id itself — for an accessible name, where a "not reported"
 * would be noise rather than information — asks here rather than importing the contract
 * beside this file and drifting from it.
 */
export { recordedModel };

/**
 * The words the dashboard puts where a model goes (Issue #21).
 *
 * **The verdict is the contract's; only the wording is here.** `modelIdentity` answers
 * whether a model was recorded, and it returns a discriminant rather than a sentence
 * precisely so that this file — and the CLI, and a second language — can each say it in
 * their own words without three places deciding the same thing.
 *
 * **Two functions and not one, because they are two different facts.** A task's model is
 * a *record*: an artifact either named one or it did not, and the reason it did not is
 * unknowable from the view (a record can be a plan, `runners.<id>.model` is a fourth
 * configuration site no artifact sees, and the openai-compatible adapter sends the
 * literal string `'default'`). A role's model is *configuration*: the role either pins
 * one or it does not, and that much the configuration can prove about itself.
 *
 * So an absent record says `not reported` and an absent role pin says `no model pinned`,
 * and a call site cannot accidentally borrow the other's confidence, because it has to
 * name which question it is asking.
 *
 * **What neither of them ever says is a runner id.** `claude` in a model slot is the one
 * substitution the issue forbids by name, and it is what the graph node used to fall
 * through to.
 */

/** An artifact recorded no model. Nothing more is claimed. */
export const MODEL_NOT_REPORTED = 'not reported';

/** This role's configuration names no model. A statement about the config, not the run. */
export const MODEL_NONE_PINNED = 'no model pinned';

/** The model an execution record named, or the fact that none did. */
export function recordedModelLabel(facts: ModelProvenanceFacts): string {
  const identity = modelIdentity(facts);
  return identity.kind === 'model' ? identity.model : MODEL_NOT_REPORTED;
}

/** The model a configured route names, or the fact that it names none. */
export function configuredModelLabel(facts: ModelProvenanceFacts): string {
  const identity = modelIdentity(facts);
  return identity.kind === 'model' ? identity.model : MODEL_NONE_PINNED;
}

/**
 * Whether there is a model to show at all.
 *
 * For styling only — an absence is drawn quieter than a fact, which is the same rule the
 * rest of the app follows for a value nobody supplied. It exists so a component does not
 * have to compare a rendered string against one of the constants above to find out.
 */
export function hasModel(facts: ModelProvenanceFacts): boolean {
  return modelIdentity(facts).kind === 'model';
}
