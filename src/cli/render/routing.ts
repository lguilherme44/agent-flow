import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GlobalConfig, WorkflowRole } from '../../contracts/index.js';
import { roleConfigForStage } from '../../contracts/index.js';

/**
 * Two questions `doctor` did not answer, and an operator has to.
 *
 * The capability report is by **role**, which is how configuration is written.
 * Routing decisions are by **stage**, which is what actually runs — and the two
 * do not line up, because one role can serve stages with different needs.
 *
 * Concretely: `architect` serves `discovery`, which reads the repository, and
 * `architecture-impact`, which reads nothing. Because runner is chosen per role,
 * the first forces the second onto a coding CLI. Measured on one run, that put
 * 22 kB of context through a frontier CLI that an inference endpoint would have
 * absorbed at no quota cost — and nothing in `doctor` said so.
 *
 * The second question is smaller and cost a session: a runner configured and
 * routed to nothing simply does not appear in the report, so "I configured it
 * and it is not listed" reads as a broken configuration rather than as a
 * configuration nobody uses.
 */

/** A pipeline stage, the role that serves it, and the prompt it renders. */
export interface StageRouting {
  readonly stage: string;
  readonly role: WorkflowRole;
  readonly prompt: string;
}

/**
 * The stage/role/prompt triples, in pipeline order.
 *
 * Written out rather than imported from `app/stages/definitions.ts` on purpose:
 * `cli/render` renders and must not pull the application layer in to do it. The
 * test asserts this list against the real definitions, so a drift is a red test
 * rather than a quiet lie in a report.
 */
export const PIPELINE_ROUTING: readonly StageRouting[] = [
  { stage: 'discovery', role: 'architect', prompt: 'discovery' },
  { stage: 'architecture-impact', role: 'architect', prompt: 'architecture-impact' },
  { stage: 'sdd', role: 'sdd', prompt: 'sdd' },
  { stage: 'planning', role: 'planner', prompt: 'planning' },
  { stage: 'plan-review', role: 'planReviewer', prompt: 'plan-review' },
  { stage: 'implementation', role: 'executor.normal', prompt: 'implementation' } as StageRouting,
  { stage: 'code-review', role: 'finalReviewer', prompt: 'code-review' },
  { stage: 'verification', role: 'verification', prompt: 'verification' },
  { stage: 'final-review', role: 'finalReviewer', prompt: 'final-review' },
];

/** Whether a prompt declares that it reads the repository. */
function needsWorkingDirectory(promptsDir: string, prompt: string): boolean {
  try {
    return /^\s*workingDirectory:\s*true\s*$/m.test(
      readFileSync(join(promptsDir, `${prompt}.md`), 'utf8'),
    );
  } catch {
    // A prompt that cannot be read is not a routing finding. `doctor` has other
    // sections for a broken installation, and inventing a requirement here would
    // put a warning on a stage nobody can even run.
    return false;
  }
}

/**
 * One line per stage: what serves it, and whether that is more than it needs.
 *
 * The judgement is deliberately narrow — a stage that reads no file being served
 * by a coding CLI is the only thing flagged, because it is the only one that is
 * unambiguously a cost with no benefit. Whether a *cheaper model* should serve a
 * stage is a quality decision, and this report does not have an opinion on it.
 */
export function renderStageRouting(config: GlobalConfig, promptsDir: string): string[] {
  const lines: string[] = ['Stage routing (which runner serves what)'];

  for (const entry of PIPELINE_ROUTING) {
    // Resolved through the stage override, or the report describes a routing the
    // run will not take — which is what it did on the first pass here.
    const role = roleConfigForStage(config.roles, entry.role, entry.stage);
    if (role === undefined) continue;

    const runnerType = config.runners[role.runner]?.type ?? '(unknown)';
    const reads = needsWorkingDirectory(promptsDir, entry.prompt);

    lines.push(
      `  ${entry.stage.padEnd(20)} ${role.runner.padEnd(12)} ${reads ? 'reads the repository' : 'text in, text out'}`,
    );

    // The finding: text-only work on a runner that spawns a process.
    if (!reads && runnerType !== 'openai-compatible') {
      lines.push(
        `    · this stage opens no file — an \`openai-compatible\` runner could serve it`,
      );
    }
  }

  return lines;
}

/**
 * Runners that exist in configuration and serve no role.
 *
 * Information, never a failure: an operator may keep a runner configured for a
 * profile they switch to. What it is not is invisible, which is what it was.
 */
export function renderUnusedRunners(config: GlobalConfig): string[] {
  const routed = new Set<string>();
  for (const entry of PIPELINE_ROUTING) {
    // Through the override too: a runner used only by one stage is routed.
    const role = roleConfigForStage(config.roles, entry.role, entry.stage);
    if (role !== undefined) routed.add(role.runner);
  }
  for (const fallbackRole of Object.values(config.fallback.roles)) {
    routed.add(fallbackRole.runner);
  }

  const unused = Object.keys(config.runners)
    .filter((id) => !routed.has(id))
    .sort();

  if (unused.length === 0) return [];

  return [
    'Configured and unrouted',
    ...unused.map(
      (id) => `  ${id.padEnd(20)} ${config.runners[id]?.type ?? ''} — no role points at it`,
    ),
    '  Point a role at one to use it; `doctor` reports only what a role resolves to.',
  ];
}
