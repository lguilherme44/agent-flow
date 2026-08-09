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
  return rest;
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
