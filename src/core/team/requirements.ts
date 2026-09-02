import {
  normaliseSkill,
  type SkillId,
  type Task,
  type TaskRequirements,
  type WorkflowRole,
} from '../../contracts/index.js';
import { patternCovers } from './ownership.js';

/**
 * What a task needs, before any member is considered (M5).
 *
 * **Derived from the plan, and from a model nowhere the plan already answers.**
 * `complexity`, `risk` and `files.likely` are fields the planner filled in and a review
 * approved; asking a model to classify them again would be a second answer to a settled
 * question, and the second answer is the one that eventually disagrees.
 *
 * Skills are the one thing the plan does not carry as such, and they are inferred from
 * two things it does — the free-form `scope` label, and where the files sit — with a
 * third, advisory source allowed to fill gaps and never to overrule.
 *
 * Pure. No I/O, no model, no configuration beyond the ownership map it is handed.
 */

export interface RequirementsInput {
  readonly task: Task;
  /** The role `core/router.ts` chose. Carried, not recomputed. */
  readonly role: WorkflowRole;
  /**
   * Skills each ownership area implies, as `pattern → skills`.
   *
   * Built by the caller from the team's own ownership map plus its members' skills: an
   * area owned by a member that declares `vue` implies `vue` for work in that area. That
   * inference is the whole reason ownership and skills are not two unrelated maps.
   */
  readonly areaSkills?: ReadonlyMap<string, readonly SkillId[]>;
  /**
   * Skills a UtilityModel suggested, already bounded and validated by the caller.
   *
   * **Advisory, and last** (§15). It fills gaps and never overrules: a skill the plan or
   * the ownership map implied keeps the source it was derived from, so an operator can
   * tell configuration from inference by reading `skillSources` alone. A failure of the
   * utility model is an empty list, never a blocked assignment.
   */
  readonly advisorySkills?: readonly string[];
}

export function deriveTaskRequirements(input: RequirementsInput): TaskRequirements {
  const skills: SkillId[] = [];
  const sources: Record<string, 'scope' | 'ownership' | 'advisory'> = {};

  const add = (skill: SkillId | undefined, source: 'scope' | 'ownership' | 'advisory'): void => {
    if (skill === undefined) return;
    // First source wins. Ordered scope → ownership → advisory below, so a skill the plan
    // stated keeps `scope` even when an area or a model would also have implied it.
    if (sources[skill] !== undefined) return;
    sources[skill] = source;
    skills.push(skill);
  };

  // 1. The planner's own label. `scope` is a free-form module name — `"backend"`,
  //    `"docs"`, `"infra"` — that has been on every task since MVP 1 and that nothing has
  //    ever read. It is the cheapest true signal there is about what a task is.
  add(normaliseSkill(input.task.scope ?? ''), 'scope');

  // 2. Where the work lands. An area owned by a member that declares `vue` implies `vue`
  //    for anything written there, which is what makes an ownership map worth more than a
  //    routing preference.
  for (const [pattern, implied] of input.areaSkills ?? []) {
    if (!input.task.files.likely.some((file) => patternCovers(pattern, file))) continue;
    for (const skill of implied) add(skill, 'ownership');
  }

  // 3. Whatever a model thought, normalised and last.
  for (const suggestion of input.advisorySkills ?? []) {
    add(normaliseSkill(suggestion), 'advisory');
  }

  return {
    taskId: input.task.id,
    role: input.role,
    complexity: input.task.complexity,
    risk: input.task.risk,
    files: [...input.task.files.likely],
    skills,
    skillSources: sources,
  };
}
