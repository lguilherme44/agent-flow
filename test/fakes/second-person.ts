/**
 * An instruction to the reader to observe the change themselves.
 *
 * The reader of a NOT_RUN line is usually an AI. "Exercise the change on the target
 * yourself, then record what you saw" told it to attest on its own observation — the one
 * thing the attestation exists to keep out. Every line that asks for an observation asks
 * for the human's, so none of them may match this.
 */
export const SECOND_PERSON_OBSERVING =
  /yourself|what you saw|what you did|you observed|you saw|você mesmo|o que você viu|o que você fez/i;
