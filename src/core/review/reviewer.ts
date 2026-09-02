import type {
  AgentId,
  AgentIdentity,
  GlobalConfig,
  IndependenceLevel,
  SkillId,
  Task,
  TaskAssignment,
  WorkflowRole,
} from '../../contracts/index.js';
import { normaliseSkills } from '../../contracts/index.js';
import { teamMembers, type AgentRoster } from '../collaboration/roster.js';
import { resolveTaskAgent } from '../team/policy.js';

/**
 * Who reviews this change (M6-02, §18).
 *
 * **There is no `ReviewRouter`.** A review is work, and this product already has one
 * answer to who does work: `resolveTaskAgent`. What is new is the shape of the question —
 * a review asks for review skills, and it excludes the one member who must never answer.
 *
 * The charter is explicit about both halves. §18: "Reutilize M5. Não crie
 * `ReviewRouter`." §20: "O implementer não pode aprovar seu próprio trabalho." The first
 * is why this file is thirty lines of requirements and a call; the second is why
 * `is_author` is an exclusion in the policy rather than a field on the artifact.
 *
 * Pure. It reads no configuration file, spawns nothing, and cannot be handed a review's
 * output: a reviewer is chosen before there is anything to review.
 */

/** The skill a member declares to say it reviews. Normalised like every other. */
export const REVIEW_SKILL = 'review';

/** The role a per-task review is asked of. */
export const REVIEWER_ROLE: WorkflowRole = 'finalReviewer';

export interface ReviewerSelection {
  /** The full assignment, ranking and all, so "why this reviewer" is answerable (I-34). */
  readonly assignment: TaskAssignment;
  /** Absent when no member could review — the run then has no per-task review. */
  readonly reviewer?: AgentId;
  readonly independence: IndependenceLevel;
  /** Set when the level achieved is below what was available in principle. */
  readonly degraded?: string;
}

export interface ReviewerInput {
  readonly task: Task;
  readonly author: AgentId;
  readonly config: GlobalConfig;
  readonly roster: AgentRoster;
  readonly inFlight: ReadonlyMap<AgentId, number>;
  readonly canImplement: (agent: AgentIdentity) => boolean;
  readonly now: string;
}

/**
 * Whether this configuration has anybody who reviews.
 *
 * **This is the switch, and it is not a flag.** Whether a task is reviewed follows from
 * whether the team has a member with review skills — a fact the configuration already
 * carries. A `review.enabled` beside it would be a second way to say the same thing, and
 * the two would disagree the first time somebody set one and not the other.
 */
export function hasReviewer(config: GlobalConfig): boolean {
  return teamMembers(config).some((member) =>
    normaliseSkills(member.member.skills).includes(REVIEW_SKILL),
  );
}

/**
 * The reviewer for this change, or nobody.
 *
 * Nobody is a legitimate answer: a team with no reviewer gets no per-task review and
 * behaves exactly as M5. It is not an error and it is not a degradation — it is a
 * configuration that did not ask for this.
 */
export function selectReviewer(input: ReviewerInput): ReviewerSelection | undefined {
  if (!hasReviewer(input.config)) return undefined;

  const assignment = resolveTaskAgent({
    task: input.task,
    routedRole: REVIEWER_ROLE,
    config: input.config,
    roster: input.roster,
    handoffs: [],
    inFlight: input.inFlight,
    canImplement: input.canImplement,
    isAuthor: (agent) => agent.id === input.author,
    requiredSkills: [REVIEW_SKILL as SkillId],
    now: input.now,
  });

  // `routed` and `no_eligible_member` both mean the policy could not name a member. A
  // review by the *role* rather than by a member is not a review this milestone can make
  // any promise about — it has no identity to record and no independence to measure.
  const reviewer = assignment.reason === 'team_match' ? assignment.agentId : undefined;
  if (reviewer === undefined) {
    return { assignment, independence: 1, degraded: 'no configured member could review' };
  }

  return { ...independenceOf(input, reviewer), assignment, reviewer };
}

/**
 * How far the chosen reviewer stands from the author (§19).
 *
 * ```text
 * 3  different provider
 * 2  same provider, different model
 * 1  same provider and model — a fresh invocation with fresh context, and nothing more
 * ```
 *
 * **Level 0 is not returned, because it is not reachable.** A review is always a separate
 * invocation with its own context; there is no code path that hands a reviewer the
 * implementation's conversation, and an architecture test says so. The value exists in
 * the vocabulary so a projection can name what is being refused.
 *
 * A degradation is recorded whenever the level achieved is below the best the *team*
 * could have offered, so "same provider" reads as a fact about this run rather than as a
 * property of the product.
 */
function independenceOf(
  input: ReviewerInput,
  reviewer: AgentId,
): { independence: IndependenceLevel; degraded?: string } {
  const author = input.roster.byId(input.author);
  const chosen = input.roster.byId(reviewer);

  if (author === undefined || chosen === undefined) {
    return { independence: 1, degraded: 'one of the two agents is not in the roster' };
  }

  const level: IndependenceLevel =
    chosen.runner !== author.runner ? 3 : chosen.model !== author.model ? 2 : 1;

  // What a different member on a different runner would have been. Reported only when
  // the team had one and this review did not get it.
  const best = teamMembers(input.config).some(({ agentId, member }) => {
    if (agentId === input.author) return false;
    if (!normaliseSkills(member.skills).includes(REVIEW_SKILL)) return false;
    return member.runner !== author.runner;
  });

  if (level === 3 || !best) return { independence: level };

  return {
    independence: level,
    degraded:
      `reviewed on ${chosen.runner}, the same provider that wrote it; a reviewer on ` +
      'another provider exists in this team and was not available',
  };
}
