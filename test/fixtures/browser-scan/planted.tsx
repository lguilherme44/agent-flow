/**
 * A forbidden construct, planted in a `.tsx` file on purpose (M8-A18).
 *
 * M6 discovered that `sourceFiles` walked `.ts` only, so every rule scanning
 * `apps/web/src` was reading **0 of its 47 components**: a rule forbidding the browser
 * from deciding anything passed while the browser was free to decide everything. The fix
 * was one `endsWith`, and a fix nobody can see fail is a fix nobody has evidence for.
 *
 * So this file exists to be *found*. `test/gates.test.ts` has positive controls for the
 * gate contract; this is the same idea for the browser scan — the rule's reach is proved
 * rather than assumed, and deleting `.tsx` from the walker turns that proof red.
 *
 * Nothing imports it and nothing ships it. It lives under `test/fixtures/` precisely so
 * the real rules, which scan `src/` and `apps/web/src`, never see it.
 */

export function decideQuality(): boolean {
  return true;
}
