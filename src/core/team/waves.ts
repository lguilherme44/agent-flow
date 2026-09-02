import type {
  AgentId,
  AgentIdentity,
  GlobalConfig,
  Task,
  WorkflowRole,
} from '../../contracts/index.js';
import type { AgentRoster } from '../collaboration/roster.js';
import { teamMembers } from '../collaboration/roster.js';
import { exclusiveContention } from './ownership.js';
import { resolveTaskAgent } from './policy.js';

/**
 * What a team forbids a wave from holding (M5-07, §29–§33).
 *
 * **This is not a scheduler.** `app/scheduler.ts` remains the only authority on when a
 * task runs, in what order, in which wave and how wide that wave may be. M5 adds two
 * constraints to the admission step it already has, in the same shape the file-overlap
 * constraint has had since AD-43: a candidate, the tasks already admitted, and a verdict.
 *
 * Two questions, and they are not the same one:
 *
 *   **ownership** — has somebody declared this area takes one writer at a time? Distinct
 *   from `core/file-overlap.ts`, which asks whether two tasks name a file in common. Two
 *   migrations in `src/db/**` share no path and must still not share a wave; overlap sees
 *   nothing there, and only an ownership declaration does.
 *
 *   **capacity** — would this wave put every member who could take the task over its
 *   `maxConcurrentTasks`? Asked by running the assignment policy, never by a second copy
 *   of it: one answer to "who executes this task", including when the question is asked a
 *   wave early.
 *
 * A deferral costs one wave and no dependency edge. The approved plan is a document a
 * person read, and injecting an edge here would change what they approved.
 */

export interface WaveDeferral {
  readonly reason: 'capacity' | 'ownership';
  /** A sentence for a person, naming the area or the member that is full. */
  readonly detail: string;
  /** The admitted task this one waits behind, when one task in particular caused it. */
  readonly waitsFor?: string;
  /** The exclusive areas both tasks write into. Set on an `ownership` deferral. */
  readonly patterns?: readonly string[];
  /** The members that are full. Set on a `capacity` deferral. */
  readonly agents?: readonly AgentId[];
}

/**
 * Whether a candidate may join a wave that already holds `inWave`.
 *
 * `undefined` admits. Called with `inWave` empty for the first candidate, which is why no
 * plan can deadlock on either constraint: a wave of one is always admissible, so a run
 * always makes progress even when every member is full and every area is exclusive.
 */
export type WaveAdmission = (
  candidate: Task,
  inWave: readonly Task[],
) => WaveDeferral | undefined;

export interface TeamWaveInput {
  readonly config: GlobalConfig;
  readonly roster: AgentRoster;
  readonly canImplement: (agent: AgentIdentity) => boolean;
  /** What `core/router.ts` decided for a task. Carried, never recomputed differently. */
  readonly routedRole: (task: Task) => WorkflowRole;
  readonly now: string;
}

/**
 * The admission a configured team implies, or one that admits everything.
 *
 * A configuration with no `teams:` gets waves byte-identical to M4's, which is what
 * M5-ACC-01 compares against. The constraints are what a team buys.
 */
export function teamWaveAdmission(input: TeamWaveInput): WaveAdmission {
  const members = teamMembers(input.config);
  if (members.length === 0) return () => undefined;

  const rules = members.map(({ member }) => member.ownership);

  return (candidate, inWave) => {
    // Ownership first: it is a fact about the two tasks and about a declaration a person
    // wrote, and it does not depend on who would end up taking either of them.
    for (const held of inWave) {
      const contended = exclusiveContention(rules, candidate.files.likely, held.files.likely);
      const area = contended[0];
      if (area !== undefined) {
        return {
          reason: 'ownership',
          detail:
            `${candidate.id} and ${held.id} both write into ${area}, which is declared ` +
            'exclusive. One writer at a time was the point of declaring it.',
          waitsFor: held.id,
          patterns: contended,
        };
      }
    }

    return capacityDeferral(candidate, inWave, input);
  };
}

/**
 * Whether this wave has already taken everybody who could do this task.
 *
 * **In-flight is the wave itself.** The scheduler dispatches a batch and awaits all of it
 * before choosing the next, so nothing outside this wave is running when admission is
 * decided. If waves ever overlap, this becomes wrong and the count has to come from run
 * state instead — which is where `TaskExecutor.inFlightByAgent` already reads it.
 *
 * Deferred only when capacity is the whole of the problem. A member excluded for its role
 * or its runner stays excluded next wave too, so waiting would achieve nothing and the
 * router's fallback is the right answer — deferring there would be a deadlock spelled as
 * a policy.
 */
function capacityDeferral(
  candidate: Task,
  inWave: readonly Task[],
  input: TeamWaveInput,
): WaveDeferral | undefined {
  const inFlight = new Map<AgentId, number>();

  for (const held of inWave) {
    const assignment = resolveTaskAgent({
      task: held,
      routedRole: input.routedRole(held),
      config: input.config,
      roster: input.roster,
      handoffs: [],
      inFlight,
      canImplement: input.canImplement,
      now: input.now,
    });
    inFlight.set(assignment.agentId, (inFlight.get(assignment.agentId) ?? 0) + 1);
  }

  const assignment = resolveTaskAgent({
    task: candidate,
    routedRole: input.routedRole(candidate),
    config: input.config,
    roster: input.roster,
    handoffs: [],
    inFlight,
    canImplement: input.canImplement,
    now: input.now,
  });

  if (assignment.reason !== 'no_eligible_member') return undefined;

  const full = assignment.candidates.filter((held) => held.excludedBy === 'capacity');
  if (full.length === 0) return undefined;

  return {
    reason: 'capacity',
    detail:
      `Every member who could take ${candidate.id} is at its capacity in this wave ` +
      `(${full.map((held) => held.agentId).join(', ')}). It goes in the next one.`,
    agents: full.map((held) => held.agentId),
  };
}
