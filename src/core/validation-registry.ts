import type { ProjectConfig } from '../contracts/index.js';

/**
 * The set of validation commands a plan is allowed to reference.
 *
 * This is the trust boundary. A plan is model output, and the repository's own
 * contents feed the prompt that produced it — so a plan is untrusted input, and
 * nothing in it may become a shell command. Instead a plan names an id, and the
 * id is resolved here against configuration a human wrote.
 *
 * Two entirely separate things share the word "command", and keeping them apart
 * is the whole point:
 *
 *   - **What to run** — lives in the project config. Trusted.
 *   - **Which of those to run** — comes from the plan. Untrusted, and reduced to
 *     picking from a list.
 *
 * Pure: it takes configuration and answers questions about it. The core learns
 * nothing about shells.
 */

export interface ValidationRegistry {
  /** Every id a plan may reference, sorted, for prompts and error messages. */
  readonly ids: readonly string[];
  has(id: string): boolean;
  /** The command behind an id, or undefined when the id is unknown. */
  resolve(id: string): string | undefined;
}

/** Standard steps, referenceable by their own name when the project defines them. */
const STANDARD_STEPS = ['install', 'lint', 'typecheck', 'test', 'build'] as const;

export function buildValidationRegistry(project: ProjectConfig | undefined): ValidationRegistry {
  const commands = new Map<string, string>();

  for (const step of STANDARD_STEPS) {
    const command = project?.commands[step]?.trim();
    if (command !== undefined && command.length > 0) commands.set(step, command);
  }

  // Declared last so a project can override a standard step with a narrower
  // variant under the same id.
  for (const [id, command] of Object.entries(project?.validationCommands ?? {})) {
    const trimmed = command.trim();
    if (trimmed.length > 0) commands.set(id, trimmed);
  }

  const ids = [...commands.keys()].sort();

  return {
    ids,
    has: (id) => commands.has(id),
    resolve: (id) => commands.get(id),
  };
}

/**
 * Ids a plan references that the project does not define.
 *
 * Reported per task so the message can name where the mistake is, rather than
 * telling the planner that "something" is wrong.
 */
export function unknownValidationIds(
  registry: ValidationRegistry,
  tasks: readonly { id: string; validation: readonly string[] }[],
): Array<{ task: string; id: string }> {
  const unknown: Array<{ task: string; id: string }> = [];

  for (const task of tasks) {
    for (const id of task.validation) {
      if (!registry.has(id)) unknown.push({ task: task.id, id });
    }
  }

  return unknown;
}
