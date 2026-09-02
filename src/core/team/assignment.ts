import type {
  AgentId,
  AgentIdentity,
  CandidateScore,
  OwnershipRule,
  SkillId,
  TaskRequirements,
} from '../../contracts/index.js';
import { ownershipScore } from './ownership.js';
import { serves } from '../collaboration/roster.js';

/**
 * Who should execute a task, and why (M5).
 *
 * **Eligibility precedes ranking, and the order is the contract.** A member that cannot
 * do the work is out before any score is compared, however well it would have scored — so
 * a high skill match can never smuggle an agent past a capability it does not have.
 *
 * ```text
 * every member
 *   → role compatible?            the plan is written in roles
 *   → runner capable?             resolveRole must succeed for this pair
 *   → ownership eligible?         nobody else holds this area exclusively
 *   → capacity available?         at maxConcurrentTasks → out
 *        ↓
 *   score the survivors
 *        ↓
 *   deterministic tie-break
 * ```
 *
 * **`core/router.ts` is not replaced; it becomes a term.** `riskFit` asks whether this
 * member's role is the one the router would have chosen, so a high-risk task still
 * gravitates to `executor.complex` even when a trivial executor has every skill. That is
 * how one router survives inside one policy rather than two routers disagreeing.
 *
 * Pure: members, requirements and state in, a ranking out. No configuration lookup, no
 * capability table, no provider name — the capability question is answered by a predicate
 * the caller supplies, because `resolveRole` owns it and a second implementation here
 * would be a second answer.
 */

/**
 * What each term is worth.
 *
 * Exported so the weights are one constant a reader can find, rather than three literals
 * inside a sum. Not configurable: an operator tuning a scoring function is an operator
 * debugging a ranking they cannot reproduce, and no dogfood has yet said these are wrong.
 *
 * Skill dominates because it is the only term that says whether the member can do *this*
 * work well. Ownership is next because it is a human's stated intent about the area. Risk
 * fit is smallest and never zero: it is the router's judgement, and the router has been
 * right about high-risk work since MVP 1.
 */
export const SCORE_WEIGHTS = { skill: 0.55, ownership: 0.25, riskFit: 0.2 } as const;

export interface Candidate {
  readonly agent: AgentIdentity;
  readonly ownership: OwnershipRule;
  readonly maxConcurrentTasks: number;
}

export interface RankInput {
  readonly requirements: TaskRequirements;
  readonly candidates: readonly Candidate[];
  /** How many tasks each member currently holds. Derived from run state, never stored. */
  readonly inFlight: ReadonlyMap<AgentId, number>;
  /**
   * Whether this member's (runner, model) pair can do the work.
   *
   * A predicate rather than a capability map, so this module stays pure and provider-free.
   * `resolveRole` owns the question; this only asks it.
   */
  readonly canImplement: (agent: AgentIdentity) => boolean;
  /**
   * Areas held exclusively by a member other than the candidate, as `agentId → patterns`.
   *
   * Passed rather than computed, because "who else owns this exclusively" is a question
   * about the whole team and this function reasons about one task.
   */
  readonly exclusivelyHeldByOthers?: (agent: AgentIdentity) => boolean;
}

/**
 * Every member, ranked, with what each scored and what ruled it out.
 *
 * Excluded members stay in the list (I-34): "why did Backend not get this" is the question
 * an operator asks, and a filtered list cannot answer it.
 */
export function rankCandidates(input: RankInput): CandidateScore[] {
  const scored = input.candidates.map((candidate) => score(candidate, input));

  return [...scored].sort(compare);
}

/** The best eligible member, or `undefined` when none is. */
export function bestCandidate(ranked: readonly CandidateScore[]): CandidateScore | undefined {
  return ranked.find((candidate) => candidate.excludedBy === undefined);
}

function score(candidate: Candidate, input: RankInput): CandidateScore {
  const { requirements } = input;
  const matched = matchedSkills(candidate.agent.skills, requirements.skills);

  const skillMatch =
    requirements.skills.length === 0 ? 1 : matched.length / requirements.skills.length;
  const ownership = ownershipScore({ rule: candidate.ownership, files: requirements.files });
  const riskFit = candidate.agent.role === requirements.role ? 1 : 0;

  const base: CandidateScore = {
    agentId: candidate.agent.id,
    score:
      SCORE_WEIGHTS.skill * skillMatch +
      SCORE_WEIGHTS.ownership * ownership +
      SCORE_WEIGHTS.riskFit * riskFit,
    skillMatch,
    ownership,
    riskFit,
    matchedSkills: matched,
  };

  // **Eligibility, in the order the specification fixes.** Most disabling first, so the
  // recorded reason is the one a person has to act on: a member with the wrong role is
  // not "at capacity", it is the wrong member.
  const excludedBy = exclusionFor(candidate, input);
  return excludedBy === undefined ? base : { ...base, excludedBy };
}

function exclusionFor(candidate: Candidate, input: RankInput): CandidateScore['excludedBy'] {
  // The plan is written in roles, and a role is what a stage asks for. A member that
  // serves `verification` is not a candidate for an implementation task however capable.
  //
  // Asked through `serves` rather than by comparing `role`, because a member may declare
  // several. Comparing the primary alone is what made a real plan lose six of its seven
  // tasks to the router: the planner flagged four `crossModule`, the router escalated
  // them to `executor.complex`, and a team written for `executor.normal` had nobody.
  if (!serves(candidate.agent, input.requirements.role)) return 'role_mismatch';

  if (!input.canImplement(candidate.agent)) return 'runner_capability';

  if (input.exclusivelyHeldByOthers?.(candidate.agent) === true) return 'ownership';

  const held = input.inFlight.get(candidate.agent.id) ?? 0;
  if (held >= candidate.maxConcurrentTasks) return 'capacity';

  return undefined;
}

/**
 * The skills the task asked for that this member declares.
 *
 * Exact ids on both sides, because both went through `normaliseSkill` at their own
 * boundary. A fuzzy match here would make `vue` and `vuex` partially the same skill and
 * would put the answer beyond anybody's ability to predict.
 */
function matchedSkills(
  declared: readonly string[],
  required: readonly SkillId[],
): SkillId[] {
  const has = new Set(declared);
  return required.filter((skill) => has.has(skill));
}

/**
 * **Where the router's answer enters the score, and why it is not recomputed here.**
 *
 * `requirements.role` *is* `routeTask`'s answer, carried from the one call the executor
 * already made. An earlier version re-routed the task inside this function to compare
 * against, which was a second source for one question — and the two disagreed the moment
 * a caller passed a role the task's own complexity would not have produced.
 *
 * The comparison lives inline in `score` now, one line, against the primary role. What it
 * measures is whether the routed role is this member's *main* one: a member listing
 * `[executor.normal, executor.complex]` is saying it mainly does ordinary work, and
 * preferring the member for whom this role is the main one is the preference the operator
 * expressed by the order they wrote.
 *
 * As specified the term asked "would the router have chosen this member's role" — a
 * question eligibility already answers, since a candidate that does not serve the routed
 * role is excluded before it is scored. Among eligible candidates it was constant, and
 * constant terms rank nothing. The live dogfood is what surfaced it: `backend` took an
 * `executor.complex` task through its secondary role and the explanation read "role is
 * not the one the router would have chosen", which was untrue.
 */

/**
 * The order two candidates are ranked in.
 *
 * **Total, and stable across runs** (I-35). Sorting by score alone leaves ties to array
 * order, and array order comes from object key order in a YAML file — so the same team
 * written in a different order would assign differently, and a resumed run could reroute
 * for no reason at all.
 *
 *   1. eligible before excluded — an excluded member never outranks an eligible one
 *   2. score, descending
 *   3. ownership, descending — an owner beats a stranger at equal score
 *   4. agent id, ascending — total, and the same on every machine
 */
function compare(a: CandidateScore, b: CandidateScore): number {
  const eligible = Number(a.excludedBy === undefined) - Number(b.excludedBy === undefined);
  if (eligible !== 0) return -eligible;

  if (a.score !== b.score) return b.score - a.score;
  if (a.ownership !== b.ownership) return b.ownership - a.ownership;

  return a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0;
}
