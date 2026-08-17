/**
 * The one place raw third-party output is made safe to persist (AD-35, I-21).
 *
 * AD-33 and AD-34 open three new persistence paths for text a runner produced — a
 * stage log, an event's `rawExcerpt`, and the failed-attempt artifact — and that text
 * is untrusted: it may carry bearer tokens, API keys, `Authorization` headers and the
 * absolute path of a worktree on somebody's laptop. Redacting at each writer
 * independently guarantees drift, and the repository already demands path-free persisted
 * detail (`app/task-workspaces.ts`); that rule must not weaken because the channel is
 * new.
 *
 * **Redaction is irreversible and lossy by design, and it happens on the way in.**
 * Redacting at read time would mean the secret is already on disk. There is no
 * unredacted mirror anywhere.
 *
 * Pure: no filesystem, no runner, no Git, no shell. The caller supplies the machine
 * facts — the worktree root, the home directory, the values of any configured secret
 * environment variables — because those are observations about a machine and this layer
 * cannot make one.
 */

/** Stable stand-ins. Chosen to be recognisable in a log and useless to an attacker. */
export const WORKSPACE_PLACEHOLDER = '<workspace>';
export const HOME_PLACEHOLDER = '<home>';
export const SECRET_PLACEHOLDER = '<redacted>';

export interface RedactionContext {
  /**
   * Absolute path of the worktree the work ran in, when there was one.
   *
   * Replaced before {@link home} regardless of the order they are given, because a
   * worktree usually lives *under* the home directory — substituting `<home>` first
   * would leave the run-specific remainder of the path intact, which is the part that
   * identifies a machine's layout.
   */
  readonly workspaceRoot?: string;
  readonly home?: string;
  /**
   * Values of environment variables the configuration names as secret-bearing.
   *
   * Values, never names: a name is safe to log and is often the useful part of a
   * diagnosis. Empty and whitespace-only entries are ignored — replacing the empty
   * string would rewrite every position in the text.
   */
  readonly secretValues?: readonly string[];
}

/**
 * Credential shapes, each anchored on a structural marker rather than on entropy.
 *
 * Entropy heuristics were rejected: a commit hash, a nonce and a base64 test fixture all
 * look like secrets to one, and redacting a tree hash would destroy the evidence AD-38
 * depends on. Every pattern here keys on something a credential *says about itself* — a
 * scheme, a documented prefix, an assignment to a key-shaped name.
 *
 * `replacement` keeps the marker and removes the value, so a redacted log still tells a
 * reader which kind of credential was present.
 */
const CREDENTIAL_PATTERNS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  // `Authorization: Bearer …` and bare `Bearer …`. The header form first, so the
  // header name survives into the output.
  {
    pattern: /\b(authorization\s*[:=]\s*)(?:bearer\s+)?\S+/gi,
    replacement: `$1${SECRET_PLACEHOLDER}`,
  },
  { pattern: /\bbearer\s+[\w\-._~+/]{8,}=*/gi, replacement: `Bearer ${SECRET_PLACEHOLDER}` },
  // Documented vendor prefixes. Deliberately provider-agnostic in intent: these are
  // token *shapes* that appear in any tool's output, not names of runners this core
  // knows about.
  { pattern: /\bsk-[A-Za-z0-9\-_]{16,}/g, replacement: SECRET_PLACEHOLDER },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replacement: SECRET_PLACEHOLDER },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: SECRET_PLACEHOLDER },
  { pattern: /\bAIza[A-Za-z0-9\-_]{16,}/g, replacement: SECRET_PLACEHOLDER },
  // `api_key = "…"`, `apiKey: …`, `secret=…`, `token: …`. The quote handling is
  // separate from the bare form because a quoted value may contain spaces.
  //
  // **The quote characters are written as `\x22` and `\x27` rather than literally, and
  // that is not obfuscation.** `test/architecture.test.ts` scans source through a
  // deliberately simple lexer that blanks string literals, and it has no notion of a
  // regex literal — so a `"` or `'` inside a character class opens a string that closes
  // at the next one anywhere below. Measured while writing this file: it swallowed 1894
  // characters, and every architecture rule written against this module was passing by
  // looking at nothing. A rule that cannot see the thing it forbids passes forever.
  {
    pattern:
      /\b((?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\s*[:=]\s*)([\x22\x27])(?:(?!\2).){4,}\2/gi,
    replacement: `$1$2${SECRET_PLACEHOLDER}$2`,
  },
  {
    pattern:
      /\b((?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\s*[:=]\s*)(?![\x22\x27])\S{4,}/gi,
    replacement: `$1${SECRET_PLACEHOLDER}`,
  },
  // A URL carrying credentials in its authority. The scheme and host stay; the
  // userinfo goes.
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, replacement: `$1${SECRET_PLACEHOLDER}@` },
  // PEM blocks. Matched as a whole so no fragment of the key survives.
  {
    pattern: /-----BEGIN[^-]{0,64}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,64}PRIVATE KEY-----/g,
    replacement: SECRET_PLACEHOLDER,
  },
];

/**
 * Everything in `text` that must not reach disk, replaced.
 *
 * Order is load-bearing and is asserted by the tests: explicit secret values first (they
 * are known exactly, so nothing should get the chance to reshape them), then credential
 * shapes, then paths. Paths last because a credential pattern anchored on `=` would
 * otherwise be looking at a string a path substitution had already rewritten.
 */
export function redactEvidence(text: string, context: RedactionContext = {}): string {
  let out = text;

  for (const value of context.secretValues ?? []) {
    if (value.trim().length === 0) continue;
    out = replaceAllLiteral(out, value, SECRET_PLACEHOLDER);
  }

  for (const { pattern, replacement } of CREDENTIAL_PATTERNS) {
    out = out.replace(pattern, replacement);
  }

  // Longest first, so a nested root is not half-substituted by its parent.
  const paths: { root: string; placeholder: string }[] = [];
  if (context.workspaceRoot !== undefined && context.workspaceRoot.length > 0) {
    paths.push({ root: context.workspaceRoot, placeholder: WORKSPACE_PLACEHOLDER });
  }
  if (context.home !== undefined && context.home.length > 0) {
    paths.push({ root: context.home, placeholder: HOME_PLACEHOLDER });
  }
  paths.sort((a, b) => b.root.length - a.root.length);

  for (const { root, placeholder } of paths) {
    out = replaceAllLiteral(out, stripTrailingSeparator(root), placeholder);
  }

  return out;
}

/**
 * The head of a redacted string, with an explicit marker when anything was cut.
 *
 * Redaction runs **before** truncation, never after: cutting first could split a
 * credential across the boundary and leave a readable prefix of it on disk. Bounded in
 * *bytes* rather than characters, because the budgets in AR §6.5 are byte budgets and a
 * multi-byte character counted as one would quietly overshoot them.
 *
 * The marker is part of the contract — AR §6.5 says a budget is never applied silently.
 */
export function redactAndTruncate(
  text: string,
  maxBytes: number,
  context: RedactionContext = {},
): { readonly text: string; readonly truncated: boolean } {
  const redacted = redactEvidence(text, context);
  const encoded = new TextEncoder().encode(redacted);
  if (encoded.length <= maxBytes) return { text: redacted, truncated: false };

  const marker = `\n… [truncated: ${String(encoded.length)} bytes of evidence, ${String(maxBytes)} kept]`;
  const markerBytes = new TextEncoder().encode(marker).length;
  const room = Math.max(0, maxBytes - markerBytes);

  const head = new TextDecoder('utf-8').decode(encoded.slice(0, boundaryBefore(encoded, room)));
  return { text: `${head}${marker}`, truncated: true };
}

/**
 * The tail of a redacted string — what a test runner's summary is in (AD-40).
 *
 * A failing command's useful output is at the end, so the packet's `failedChecks` keep
 * the tail where `rawExcerpt` keeps the head.
 */
export function redactAndTruncateTail(
  text: string,
  maxBytes: number,
  context: RedactionContext = {},
): { readonly text: string; readonly truncated: boolean } {
  const redacted = redactEvidence(text, context);
  const encoded = new TextEncoder().encode(redacted);
  if (encoded.length <= maxBytes) return { text: redacted, truncated: false };

  const marker = `[truncated: ${String(encoded.length)} bytes of evidence, ${String(maxBytes)} kept]\n`;
  const markerBytes = new TextEncoder().encode(marker).length;
  const room = Math.max(0, maxBytes - markerBytes);

  const tail = new TextDecoder('utf-8').decode(
    encoded.slice(boundaryAfter(encoded, encoded.length - room)),
  );
  return { text: `${marker}${tail}`, truncated: true };
}

/**
 * The largest index at or below `limit` that does not fall inside a UTF-8 character.
 *
 * Needed because `TextDecoder` does **not** drop a partial trailing sequence — it emits
 * U+FFFD, which is *three* bytes. So slicing blindly at a byte budget can produce output
 * two bytes longer than the budget it was cutting to, which is a byte budget that does
 * not hold. Measured, not reasoned about: a 120-byte cut of three-byte characters came
 * back at 121.
 *
 * A continuation byte is `10xxxxxx`; walking back off those lands on a lead byte.
 */
function boundaryBefore(bytes: Uint8Array, limit: number): number {
  let index = Math.min(limit, bytes.length);
  while (index > 0 && isContinuation(bytes[index])) index -= 1;
  return index;
}

/** The smallest index at or above `from` that starts a character. */
function boundaryAfter(bytes: Uint8Array, from: number): number {
  let index = Math.max(0, from);
  while (index < bytes.length && isContinuation(bytes[index])) index += 1;
  return index;
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0b1100_0000) === 0b1000_0000;
}

/** Literal replacement, so a path containing regex metacharacters is handled. */
function replaceAllLiteral(haystack: string, needle: string, replacement: string): string {
  if (needle.length === 0) return haystack;
  return haystack.split(needle).join(replacement);
}

function stripTrailingSeparator(path: string): string {
  return path.length > 1 && (path.endsWith('/') || path.endsWith('\\')) ? path.slice(0, -1) : path;
}
