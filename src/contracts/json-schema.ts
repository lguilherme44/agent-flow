import { z } from 'zod';
import type { ZodType } from 'zod';

/**
 * One Zod schema, three uses (AD-08): static types, runtime validation, and the
 * JSON Schema handed to a runner that supports enforced structured output.
 *
 * `io: 'input'` matters — defaults are optional on the way in, and the model is
 * being told what it may send, not what it will get back.
 */
export function toJsonSchema(schema: ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;

  // `$schema` is dropped deliberately. Zod emits a draft/2020-12 URL, and a CLI
  // validating against a bundled dialect set rejects the whole schema rather
  // than fetching it — Claude Code fails with "no schema with key or ref
  // https://json-schema.org/draft/2020-12/schema". The declaration buys nothing
  // here: the consumer is a tool we hand the schema to directly, not a document
  // that has to identify its own dialect.
  const { $schema: _dialect, ...rest } = generated;
  return expandClassEscapesDeep(rest) as Record<string, unknown>;
}

/**
 * Character-class escapes, and the classes they stand for.
 *
 * A `pattern` reaches llama.cpp as a grammar: the server compiles the JSON Schema
 * into GBNF and samples against it. GBNF has character classes but **no class
 * escapes**, so `\d` is not "any digit" there — it fails to compile, and the whole
 * request comes back `400 Failed to initialize samplers: failed to parse grammar`
 * before a single token is generated.
 *
 * Measured against a real server rather than assumed: `\d` and `\w` fail, while
 * `enum`, `minLength`, `minItems`, `minimum`/`maximum`, `default`, `anyOf` and an
 * explicit `[a-z0-9]` all pass. Six of the nine patterns in `PlanSchema` use `\d`,
 * which is why every structured stage was unreachable for an inference endpoint.
 *
 * This is a projection concern, not a schema one: the Zod schemas keep `\d`, and
 * runtime validation is untouched. Only what we hand a runner changes — the same
 * reason `$schema` is stripped above.
 */
const CLASS_ESCAPES: Readonly<Record<string, { readonly bare: string; readonly negated: boolean }>> =
  {
    d: { bare: '0-9', negated: false },
    D: { bare: '0-9', negated: true },
    w: { bare: 'A-Za-z0-9_', negated: false },
    W: { bare: 'A-Za-z0-9_', negated: true },
    s: { bare: ' \\t\\n\\r\\f\\v', negated: false },
    S: { bare: ' \\t\\n\\r\\f\\v', negated: true },
  };

/**
 * Rewrites class escapes in one regular expression source.
 *
 * Scans instead of running a global replace, because two cases make the obvious
 * `pattern.replace(/\\d/g, '[0-9]')` wrong:
 *
 * - **An escaped backslash is not an escape.** In `\\d` the `\\` is a literal
 *   backslash followed by the letter `d`, and rewriting it would change the
 *   language the pattern accepts. Consuming escape pairs as pairs handles it.
 * - **Inside a character class, brackets do not nest.** `[\d-]` must become
 *   `[0-9-]`, never `[[0-9]-]`, which is a different (and invalid) expression.
 *
 * A negated escape inside a class (`[\D]`) has no bracket-expression equivalent
 * and is left untouched: a pattern that still fails to compile is a visible
 * problem, while a silent rewrite to something subtly different is not. No schema
 * in this repository uses one.
 */
export function expandClassEscapes(pattern: string): string {
  let out = '';
  let inClass = false;

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] as string;

    if (ch !== '\\') {
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      out += ch;
      continue;
    }

    const next = pattern[i + 1];
    if (next === undefined) {
      out += ch;
      continue;
    }

    const escape = CLASS_ESCAPES[next];
    if (escape === undefined || (inClass && escape.negated)) {
      // Not a class escape (`\\`, `\.`, `\/`), or one with no equivalent here:
      // copy the pair through untouched.
      out += ch + next;
    } else if (inClass) {
      out += escape.bare;
    } else {
      out += `[${escape.negated ? '^' : ''}${escape.bare}]`;
    }
    i += 1;
  }

  return out;
}

/** Applies {@link expandClassEscapes} to every `pattern` in a schema tree. */
function expandClassEscapesDeep(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expandClassEscapesDeep);
  if (node === null || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[key] =
      key === 'pattern' && typeof value === 'string'
        ? expandClassEscapes(value)
        : expandClassEscapesDeep(value);
  }
  return out;
}

/**
 * Renders a validation failure as something a person can act on: which file,
 * which key, what was wrong. Config errors are the most common way this tool
 * will fail, and a raw Zod dump is not an answer.
 */
export function formatValidationError(error: z.ZodError, source?: string): string {
  const header = source ? `Invalid ${source}:` : 'Validation failed:';
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    const received =
      'received' in issue && issue.received !== undefined
        ? ` (received: ${JSON.stringify(issue.received)})`
        : '';
    return `  • ${path}: ${issue.message}${received}`;
  });
  return [header, ...lines].join('\n');
}
