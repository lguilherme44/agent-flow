import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { formatValidationError } from '../contracts/index.js';
import type { FileSystem } from '../ports/index.js';

export class PromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptError';
  }
}

/**
 * What a prompt declares about itself (AD-12).
 *
 * Prompts are versioned assets rather than string literals in code, so they can
 * be iterated without a rebuild. The front matter is what makes them checkable:
 * the orchestrator validates requirements against runner capabilities *before*
 * spawning anything.
 */
export const PromptMetaSchema = z.object({
  /**
   * No `role` here on purpose.
   *
   * It used to be declared and never read: the StageRunner resolves the role
   * from the StageDefinition, so the front matter could name a different one
   * and nothing would notice. Worse, it could not be right — the implementation
   * prompt serves all three executor roles, so any single value it declared was
   * a lie about two of them.
   *
   * Metadata that cannot be enforced and is not consulted is worse than absent:
   * it reads as a constraint and is a comment.
   */
  /** Read-only is the default; a prompt that writes must say so (§35). */
  permissions: z.enum(['read-only', 'write']).default('read-only'),
  outputFormat: z.enum(['markdown', 'json', 'text']).default('markdown'),
  /** Rendering fails if any of these is missing or blank. */
  requiredVars: z.array(z.string()).default([]),
  /** True when prompted-and-validated structured output is not acceptable. */
  nativeStructuredOutput: z.boolean().default(false),
});
export type PromptMeta = z.infer<typeof PromptMetaSchema>;

export interface LoadedPrompt {
  readonly name: string;
  readonly meta: PromptMeta;
  readonly body: string;
  render(vars: Record<string, string>): string;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface PromptLoaderOptions {
  readonly fs: FileSystem;
  readonly promptsDir: string;
}

export class PromptLoader {
  private readonly fs: FileSystem;
  private readonly promptsDir: string;

  constructor(options: PromptLoaderOptions) {
    this.fs = options.fs;
    this.promptsDir = options.promptsDir;
  }

  async load(name: string): Promise<LoadedPrompt> {
    const path = `${this.promptsDir}/${name}.md`;

    if (!(await this.fs.exists(path))) {
      throw new PromptError(`Prompt "${name}" not found (looked for ${path}).`);
    }

    const raw = await this.fs.readFile(path);
    const match = FRONT_MATTER.exec(raw);
    if (!match) {
      throw new PromptError(
        `Prompt "${name}" has no front matter.\n` +
          `  Every prompt must declare at least its role between --- markers.`,
      );
    }

    const [, frontMatter = '', body = ''] = match;

    let parsedMeta: unknown;
    try {
      parsedMeta = parseYaml(frontMatter) ?? {};
    } catch (error) {
      throw new PromptError(
        `Prompt "${name}" has unparseable front matter: ${(error as Error).message}`,
      );
    }

    const result = PromptMetaSchema.safeParse(parsedMeta);
    if (!result.success) {
      throw new PromptError(formatValidationError(result.error, `prompt "${name}"`));
    }

    const meta = result.data;
    return {
      name,
      meta,
      body,
      render: (vars) => render(name, body, meta.requiredVars, vars),
    };
  }
}

/**
 * Single-pass substitution.
 *
 * Deliberately not recursive: substituted content is data, not template. A
 * repository file that happens to contain `{{something}}` must not be
 * re-expanded, or project content could inject placeholders into the prompt.
 *
 * Undeclared placeholders are left as-is rather than blanked — a visible
 * `{{typo}}` in the output is a better clue than a silent hole.
 */
function render(
  name: string,
  body: string,
  requiredVars: readonly string[],
  vars: Record<string, string>,
): string {
  const missing = requiredVars.filter((key) => (vars[key] ?? '').trim().length === 0);

  if (missing.length > 0) {
    // Raised before any process is spawned: the cheapest failure available,
    // and far better than asking a model to reason about an empty section.
    throw new PromptError(
      `Prompt "${name}" is missing required variables: ${missing.join(', ')}.\n` +
        `  Nothing was sent to a runner.`,
    );
  }

  return body.replace(/\{\{(\w+)\}\}/g, (placeholder, key: string) =>
    Object.hasOwn(vars, key) ? (vars[key] as string) : placeholder,
  );
}
