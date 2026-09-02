import type {
  AgentId,
  AgentIdentity,
  CandidateScore,
  GlobalConfig,
  Handoff,
  OwnershipRule,
  Task,
  TaskAssignment,
  WorkflowRole,
} from '../../contracts/index.js';
import type { RoutingPolicy } from '../router.js';
import { teamMembers } from '../collaboration/roster.js';
import type { AgentRoster } from '../collaboration/roster.js';
import { deriveTaskRequirements } from './requirements.js';
import { bestCandidate, rankCandidates, type Candidate } from './assignment.js';
import { patternCovers } from './ownership.js';
import { admitHandoff } from '../collaboration/budgets.js';
import { normaliseSkills, type SkillId } from '../../contracts/index.js';

/**
 * The one answer to "who executes this task" (M5).
 *
 * **`resolveTaskAgent` keeps its position and gets a new body.** M4 built that seam
 * deliberately — it is asked on every task and answered `routed` for almost all of them —
 * precisely so this milestone would have somewhere to put a decision rather than a second
 * router beside the first. There is one call site, one answer, and `core/router.ts`
 * survives inside it as both the legacy path and a scoring term.
 *
 * Pure. Everything it needs about capability arrives as a predicate, everything it needs
 * about the run arrives as counts. It reads no configuration file, spawns nothing, and
 * cannot be handed a message body: **an agent-authored message may say "Frontend should
 * take this" and only this module assigns** (I-33).
 */

export interface AssignmentInput {
  readonly task: Task;
  /** What `core/router.ts` decided. The default, and the fallback for every refusal. */
  readonly routedRole: WorkflowRole;
  readonly config: GlobalConfig;
  readonly roster: AgentRoster;
  /** Accepted, rejected and pending transfers, projected from the message log. */
  readonly handoffs: readonly Handoff[];
  /** How many tasks each member currently holds. Derived from run state (I-39). */
  readonly inFlight: ReadonlyMap<AgentId, number>;
  readonly canImplement: (agent: AgentIdentity) => boolean;
  /** Files other in-flight tasks declared, for the exclusive-ownership check. */
  readonly concurrentFiles?: readonly string[];
  readonly routingPolicy?: RoutingPolicy;
  readonly now: string;
}

/**
 * Who executes this task, with every candidate it was chosen over.
 *
 * Three shapes of answer, in the order they are decided:
 *
 *   1. **No team configured** — the router's role, `reason: 'routed'`, no candidates.
 *      Byte-identical to what M4 produced, which is what M5-ACC-01 compares against.
 *   2. **A team, and an admitted handoff** — the target, once it has passed every filter
 *      the ordinary path applies. A handoff is an *input* to this decision, never an
 *      instruction (I-33).
 *   3. **A team** — the best eligible member by score, or the router's role when none is
 *      eligible, which is a refusal that names itself rather than a task nobody holds.
 */
export function resolveTaskAgent(input: AssignmentInput): TaskAssignment {
  const routed: TaskAssignment = {
    taskId: input.task.id,
    agentId: input.routedRole,
    role: input.routedRole,
    reason: 'routed',
    candidates: [],
    assignedAt: input.now,
  };

  const members = teamMembers(input.config);
  if (members.length === 0) {
    // **Legacy, and legacy still honours a handoff.** A configuration written before M5
    // has no `teams:` and may well have `handoffsReassignExecution: true`, which in M4
    // moved the work. Returning `routed` here would have silently taken that away from
    // every run that had it — the ranking is what a team buys, not the permission.
    const legacy = admittedHandoff(input, (agentId) => {
      const agent = input.roster.byId(agentId);
      if (agent === undefined) return 'role_mismatch';
      return input.canImplement(agent) ? undefined : 'runner_capability';
    });
    return legacy === undefined ? routed : { ...routed, ...legacy };
  }

  const ownershipOf = new Map<AgentId, OwnershipRule>(
    members.map(({ agentId, member }) => [agentId, member.ownership]),
  );

  const requirements = deriveTaskRequirements({
    task: input.task,
    role: input.routedRole,
    areaSkills: areaSkillsOf(members),
  });

  const candidates: Candidate[] = members.flatMap(({ agentId, member }) => {
    const agent = input.roster.byId(agentId);
    return agent === undefined
      ? []
      : [{ agent, ownership: member.ownership, maxConcurrentTasks: member.capacity.maxConcurrentTasks }];
  });

  const ranked = rankCandidates({
    requirements,
    candidates,
    inFlight: input.inFlight,
    canImplement: input.canImplement,
    exclusivelyHeldByOthers: (agent) =>
      heldExclusivelyByAnother(agent.id, ownershipOf, requirements.files),
    ...(input.routingPolicy === undefined ? {} : { routingPolicy: input.routingPolicy }),
  });

  const handoff = admittedHandoff(input, (agentId) => {
    const candidate = ranked.find((scored) => scored.agentId === agentId);
    return candidate === undefined ? 'role_mismatch' : candidate.excludedBy;
  });
  if (handoff !== undefined) return { ...routed, ...handoff, candidates: ranked };

  const best = bestCandidate(ranked);
  if (best === undefined) {
    return {
      ...routed,
      reason: 'no_eligible_member',
      candidates: ranked,
      detail:
        `No configured member can take ${input.task.id}: ` +
        `${summarise(ranked)}. It stays with the role the router chose.`,
    };
  }

  return {
    ...routed,
    agentId: best.agentId,
    reason: 'team_match',
    candidates: ranked,
    detail: explain(best, requirements.skills),
  };
}

/**
 * The accepted handoff this task may honour, once the policy has admitted it.
 *
 * **An accepted handoff is a request, and this is where it is decided** (§27). Its target
 * passes the same eligibility the ordinary path applies — `eligible` is the team ranking
 * on the M5 path and a bare capability check on the legacy one — so a handoff can never
 * route work to an agent the ordinary path would have refused.
 */
function admittedHandoff(
  input: AssignmentInput,
  /** The exclusion that would keep this agent from the task, or `undefined` if none. */
  eligible: (agentId: AgentId) => string | undefined,
): Partial<TaskAssignment> | undefined {
  const accepted = input.handoffs.filter(
    (handoff) => handoff.taskId === input.task.id && handoff.status === 'accepted',
  );
  const latest = accepted[accepted.length - 1];
  if (latest === undefined) return undefined;

  // Two flags, and both must allow it. `collaboration.handoffsReassignExecution` is M4's
  // and keeps its name for compatibility; its *meaning* has migrated from "assign the
  // target" to "let the policy consider the target". `teams.*.policies.admitHandoffs` is
  // the same permission expressed where a team owns it.
  const collaborationAllows = input.config.collaboration.handoffsReassignExecution;
  const teamAllows = Object.values(input.config.teams ?? {}).some(
    (team) => team.policies.admitHandoffs,
  );
  if (!collaborationAllows && !teamAllows) {
    return {
      reason: 'handoff_not_admitted',
      detail:
        `${latest.from} handed ${input.task.id} to ${latest.to} and it was recorded, not ` +
        'applied. Set collaboration.handoffsReassignExecution to let the assignment ' +
        'policy consider it.',
    };
  }

  // `collaboration.maxHandoffsPerTask`, through the function that already owns it. A
  // second budget on the team object would have been one concept with two names, and
  // the two would eventually disagree about how many is too many.
  const budget = admitHandoff({
    config: input.config.collaboration,
    // The accepted ones minus the one being considered: a rejected offer cost the task
    // nothing, and refusing the next because of it would punish the target for saying no.
    alreadyForTask: accepted.length - 1,
  });
  if (budget !== undefined) {
    return { reason: 'handoff_budget_exhausted', detail: budget.action };
  }

  const excluded = eligible(latest.to);
  if (excluded !== undefined) {
    return {
      reason: 'handoff_refused_capability',
      detail:
        `${latest.to} accepted ${input.task.id} and is not eligible for it (${excluded}). ` +
        'The task stays with the role the router chose.',
    };
  }

  return {
    agentId: latest.to,
    reason: 'handoff_admitted',
    previousAgentId: latest.from,
    detail: `${latest.from} handed ${input.task.id} to ${latest.to}: ${latest.reason}`,
  };
}

/**
 * Whether some *other* member holds one of this task's files exclusively.
 *
 * An `exclusive` claim is the one ownership mode with teeth: it says this area takes one
 * writer, so a candidate that is not the holder is not eligible for work inside it. The
 * holder itself is unaffected — owning an area exclusively is a reason to get the work,
 * not a reason to be refused it.
 *
 * **A claim the candidate also makes is not a claim against it.** Two members declaring
 * `src/db/**` exclusive means "this area takes one writer, and we are who may be it" —
 * which is how a team covers one area across two roles. Reading it as two rival claims
 * excluded *both* of them and left the area with no eligible member at all; the dogfood
 * hit that the moment a second database member was declared, and the fallback hid it
 * behind a task that still ran.
 *
 * The wave constraint is what keeps it to one writer at a time; this only decides who may
 * be that writer.
 */
function heldExclusivelyByAnother(
  agentId: AgentId,
  ownershipOf: ReadonlyMap<AgentId, OwnershipRule>,
  files: readonly string[],
): boolean {
  const own = ownershipOf.get(agentId)?.exclusive ?? [];

  for (const [owner, rule] of ownershipOf) {
    if (owner === agentId) continue;
    for (const pattern of rule.exclusive) {
      if (own.includes(pattern)) continue;
      if (files.some((file) => patternCovers(pattern, file))) return true;
    }
  }
  return false;
}

/**
 * Which skills each owned area implies.
 *
 * The inference that makes an ownership map worth more than a routing preference: an area
 * owned by a member declaring `vue` implies `vue` for anything written there, so a task
 * touching `apps/web/**` asks for `vue` without anybody writing that down twice.
 */
function areaSkillsOf(
  members: ReturnType<typeof teamMembers>,
): ReadonlyMap<string, readonly SkillId[]> {
  const areas = new Map<string, SkillId[]>();

  for (const { member } of members) {
    const skills = normaliseSkills(member.skills);
    if (skills.length === 0) continue;

    for (const pattern of [...member.ownership.preferred, ...member.ownership.exclusive]) {
      const existing = areas.get(pattern) ?? [];
      areas.set(pattern, [...new Set([...existing, ...skills])]);
    }
  }

  return areas;
}

/** Why this member, in the words an operator asked the question in. */
function explain(best: CandidateScore, required: readonly SkillId[]): string {
  const skills =
    required.length === 0
      ? 'no skills required'
      : `skills ${best.matchedSkills.join(', ') || 'none'} of ${required.join(', ')}`;

  return (
    `${best.agentId} scored ${best.score.toFixed(2)} — ${skills}; ` +
    `ownership ${best.ownership.toFixed(2)}; ` +
    `role ${best.riskFit === 1 ? 'is' : 'is not'} the one the router would have chosen`
  );
}

/**
 * Why nobody was eligible, naming each filter that fired.
 *
 * The reasons are spelled out rather than pasted in. `excludedBy` is an enum, and an enum
 * in the middle of an English sentence — `1 role_mismatch` — is an implementation detail
 * leaking onto a screen an operator reads. The screenshot is where that showed.
 */
function summarise(ranked: readonly CandidateScore[]): string {
  const counts = new Map<string, number>();
  for (const candidate of ranked) {
    const reason = candidate.excludedBy ?? 'eligible';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }

  return [...counts]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([reason, count]) => `${String(count)} ${reason.replace(/_/g, ' ')}`)
    .join(', ');
}
