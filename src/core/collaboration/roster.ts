import {
  ALL_WORKFLOW_ROLES,
  HUMAN_AGENT_ID,
  ORCHESTRATOR_AGENT_ID,
  normaliseSkills,
  roleConfigOf,
  type AgentId,
  type AgentIdentity,
  type GlobalConfig,
  type TeamMemberConfig,
  type WorkflowRole,
} from '../../contracts/index.js';

/**
 * Who the agents on this run are (M4-01).
 *
 * **Derived, not configured.** A project's `config.yaml` says which runner serves each
 * role; this turns that into one identity per role, and that is the whole of M4's
 * backward compatibility — a configuration written before this milestone existed yields
 * nine agents and needs no migration, no new block and no edit.
 *
 * The alternative was a `teams:` block agents had to be declared in, which would have
 * made collaboration a feature only new projects could have. Deriving instead means the
 * *first* run after an upgrade already has a roster.
 *
 * Pure: it reads configuration and answers questions about it. No filesystem, no runner,
 * no registry — an identity is a description of a slot in the configuration, and
 * discovering whether the CLI behind it is installed is `doctor`'s job.
 *
 * **`id` and `role` are equal here and are not the same field.** M5's teams introduce a
 * member whose id is `frontend` and whose role is `executor.normal`; every message,
 * handoff and blackboard entry written under M4 keeps resolving, because none of them was
 * ever keyed on the role.
 */

export interface AgentRoster {
  /** Every derived agent, in `WORKFLOW_ROLES` order. Stable across calls. */
  readonly agents: readonly AgentIdentity[];
  /**
   * One agent by id, or `undefined`.
   *
   * The reserved ids answer here too: a message from `orchestrator` has to resolve to
   * *something* when a reader renders "who said this", and forcing every caller to
   * special-case two strings is how one of them forgets.
   */
  byId(id: AgentId): AgentIdentity | undefined;
  /** Every agent serving a role. One in M4; more once teams exist. */
  byRole(role: WorkflowRole): readonly AgentIdentity[];
  has(id: AgentId): boolean;
}

/**
 * How a role reads to a person.
 *
 * Written out rather than derived from the role string, because `executor.normal` →
 * "Executor Normal" is a transformation that reads like a bug, and a name is the one
 * field whose whole purpose is being read.
 */
const DISPLAY_NAMES: Readonly<Record<WorkflowRole, string>> = {
  architect: 'Architect',
  sdd: 'Specification Author',
  planner: 'Planner',
  planReviewer: 'Plan Reviewer',
  'executor.trivial': 'Executor (trivial)',
  'executor.normal': 'Executor (normal)',
  'executor.complex': 'Executor (complex)',
  verification: 'Verifier',
  finalReviewer: 'Final Reviewer',
};

/**
 * The two participants that are not derived from configuration.
 *
 * They carry a role because every other reader of an identity expects one, and the role
 * they carry is the closest true statement rather than an invented tenth entry in
 * `WORKFLOW_ROLES`: extending that enum for two participants that run no stage would put
 * a display concern into the vocabulary the state machine is built on — the mistake
 * `PIPELINE_STAGES` was split from `RUN_STAGES` to avoid.
 *
 * Their `runner` is the literal `'none'`, because neither is executed by one. A reader
 * that renders a runner name gets a word that is true instead of a blank that looks like
 * missing data.
 */
const RESERVED: readonly AgentIdentity[] = [
  {
    id: HUMAN_AGENT_ID,
    displayName: 'Human operator',
    role: 'planReviewer',
    runner: 'none',
    skills: [],
    specializations: [],
  },
  {
    id: ORCHESTRATOR_AGENT_ID,
    displayName: 'Agent Flow',
    role: 'verification',
    runner: 'none',
    skills: [],
    specializations: [],
  },
];

/**
 * Whether this configuration describes a team, or only the nine roles (M5).
 *
 * The one discriminator, asked in one place, so "is this a legacy run" has a single
 * answer. An empty `teams:` block is legacy: a record with no members describes nobody.
 */
export function hasTeam(config: GlobalConfig): boolean {
  return Object.values(config.teams ?? {}).some(
    (team) => Object.keys(team.members).length > 0,
  );
}

/**
 * Every configured member, flattened across teams, with the team each came from.
 *
 * Flattened because assignment is per *task* and a task belongs to a run rather than to
 * a team; the team id is carried so a projection can group by it. Two teams declaring the
 * same member id is a configuration mistake, and the first wins rather than the last —
 * so the answer does not depend on object key order.
 */
export function teamMembers(
  config: GlobalConfig,
): { readonly teamId: string; readonly agentId: AgentId; readonly member: TeamMemberConfig }[] {
  const seen = new Set<AgentId>();
  const members: { teamId: string; agentId: AgentId; member: TeamMemberConfig }[] = [];

  for (const [teamId, team] of Object.entries(config.teams ?? {})) {
    for (const [agentId, member] of Object.entries(team.members)) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      members.push({ teamId, agentId, member });
    }
  }

  return members;
}

export function deriveAgentRoster(config: GlobalConfig): AgentRoster {
  // **One roster, two sources** (M5). Every M4 consumer — the harvest, the context
  // builder, the read model, the CLI — is untouched by this branch, because none of them
  // ever asked where the roster came from. A second roster type for teams would have
  // meant a second `byId`, and the two would answer differently the first time a member
  // was renamed.
  if (hasTeam(config)) return teamRoster(config);
  return legacyRoster(config);
}

/**
 * The nine roles, exactly as M4 derived them.
 *
 * Unchanged and kept callable on its own, because M5-ACC-01 compares a team run's
 * assignment against this path's answer rather than against a remembered expectation.
 */
function legacyRoster(config: GlobalConfig): AgentRoster {
  const derived: AgentIdentity[] = ALL_WORKFLOW_ROLES.map((role) => {
    const roleConfig = roleConfigOf(config.roles, role);
    return {
      id: role,
      displayName: DISPLAY_NAMES[role],
      role,
      runner: roleConfig.runner,
      ...(roleConfig.model === undefined ? {} : { model: roleConfig.model }),
      // Empty, and empty is honest. Nothing configures a skill in M4, and a derived list
      // of plausible ones — "the complex executor probably knows architecture" — would be
      // read as a measurement by the assignment logic M5 builds on top of it.
      skills: [],
      specializations: [],
    };
  });

  const all = [...derived, ...RESERVED];
  const index = new Map(all.map((agent) => [agent.id, agent]));

  return {
    agents: derived,
    byId: (id) => index.get(id),
    // Only the derived agents: a `byRole` that returned the human because it is nominally
    // a plan reviewer would let a role-addressed message reach a participant that cannot
    // be dispatched. The reserved two are addressable by id and by nothing else.
    byRole: (role) => derived.filter((agent) => agent.role === role),
    has: (id) => index.has(id),
  };
}

/**
 * One agent per configured team member (M5).
 *
 * **Produces `AgentIdentity`, and nothing else.** A `TeamMember` is the configuration an
 * identity is derived *from*; making it a second identity type would give every consumer
 * two shapes to handle and one of them would eventually be handled wrong.
 *
 * Skills are normalised here, at the single boundary where a string a person typed
 * becomes a `SkillId`. `TypeScript`, `typescript` and ` Type Script ` are one skill, and
 * a matcher that thought otherwise would silently score zero.
 *
 * The reserved participants are appended exactly as in the legacy path: `human` and
 * `orchestrator` are addressable on every run, whether or not a team is configured.
 */
function teamRoster(config: GlobalConfig): AgentRoster {
  const derived: AgentIdentity[] = teamMembers(config).map(({ agentId, member }) => ({
    id: agentId,
    displayName: member.displayName ?? agentId,
    role: member.role,
    runner: member.runner,
    ...(member.model === undefined ? {} : { model: member.model }),
    skills: normaliseSkills(member.skills),
    specializations: normaliseSkills(member.specializations),
  }));

  const all = [...derived, ...RESERVED];
  const index = new Map(all.map((agent) => [agent.id, agent]));

  return {
    agents: derived,
    byId: (id) => index.get(id),
    byRole: (role) => derived.filter((agent) => agent.role === role),
    has: (id) => index.has(id),
  };
}
