import { useState } from 'react';
import type { CandidateView, TaskAssignmentView, TeamMemberView, TeamView, WaveDeferralView } from '@contracts/index.js';
import { api, keys, type RunAddress } from '../../lib/api';
import { useResource } from '../../lib/store';
import { memberTone } from '../../lib/tone';
import { useT, word } from '../../lib/i18n';
import { Block, Chip, Empty, Notice, Skeleton, Stat } from '../../components/ui';

/**
 * Who did the work, and why this task went to this agent (7.8, §37, §38).
 *
 * `GET /runs/:id/team` has been served since M5 and nothing in Deck drew it, so the
 * question an operator actually asks — *why did Backend not get that task* — was
 * answerable only from `--classic`. The run page even had a hole shaped like this one:
 * an attention item focused on `team` landed nowhere, because there was no surface for
 * it to land on.
 *
 * **Nothing here ranks a candidate.** Every score, every exclusion and every member's
 * `status` arrives from `core/team/view.ts` — the same fold `af status` prints. A browser
 * that re-scored the ranking would be a second assignment authority, and the first time
 * it disagreed with the run the screen would be describing a decision nobody made
 * (I-33, I-34).
 *
 * Unlike the card this replaces, nothing is sliced. That card lived in a 288px box beside
 * three others and cut itself to four members; this is a full-width tab somebody opened
 * on purpose, and a member hidden behind "… and 3 more" is the one they came to look at.
 */
export function TeamTab({ address }: { readonly address: RunAddress }) {
  const t = useT();
  const team = useResource<TeamView>(keys.team(address), () => api.team(address));
  const data = team.data;

  if (team.error !== undefined) return <Empty error>{t.team.couldNotRead}</Empty>;
  if (data === undefined) return <Skeleton rows={5} />;

  /*
    `configured` is whether a `teams:` block exists — not whether anything was assigned.
    The contract is explicit about it, and the hint depends on which: sending somebody to
    write a block they already wrote is the screen misreading its own data.
  */
  if (!data.configured) {
    return (
      <Empty hint={t.team.notConfiguredHint}>
        {t.team.notConfigured}
      </Empty>
    );
  }

  const totals = data.totals;
  const exclusions = Object.entries(totals.exclusions);
  // The one outcome that means the team was consulted and could not answer: the task ran
  // on the role the router chose, and the reason is always something in the configuration.
  const refused = data.assignments.filter((assignment) => assignment.reason === 'no_eligible_member');

  return (
    <div className="outcome">
      <div className="telemetry__totals" aria-label={t.telemetry.totals}>
        <Stat label={t.team.members} value={String(data.members.length)} />
        <Stat label={t.team.assignments} value={String(totals.assignments)} />
        <Stat
          label={t.team.reassignments}
          value={String(totals.reassignments)}
          tone={totals.reassignments > 0 ? 'warn' : undefined}
        />
        <Stat label={t.team.candidatesWeighed} value={String(totals.candidatesConsidered)} />
        <Stat
          label={t.team.heldAWave}
          value={String(totals.capacityDeferrals + totals.ownershipDeferrals)}
          tone={totals.capacityDeferrals + totals.ownershipDeferrals > 0 ? 'warn' : undefined}
        />
      </div>

      {exclusions.length === 0 ? null : (
        <div className="outcome__chips" aria-label={t.team.ruledOut}>
          {/*
            Which filter fired and how often (§41) — the aggregate a per-candidate
            `excludedBy` cannot give. "Capacity fired forty times" is a configuration to
            change; forty rows each saying `capacity` is a list to count.
          */}
          {exclusions.map(([reason, count]) => (
            <Chip key={reason} tone="ghost" plain>
              {word(t, reason)} {count}
            </Chip>
          ))}
        </div>
      )}

      {refused.length === 0 ? null : (
        <Notice tone="warn" k={t.team.noMemberKey}>
          {t.team.fellBackToRole(refused.length)} {refused[0]?.detail ?? t.team.noMemberMatched}
        </Notice>
      )}

      <Block title={t.team.membersHeading} count={t.team.configuredCount(data.members.length)}>
        {data.members.length === 0 ? (
          // Configured and empty is a third state, and it is not the one above: somebody
          // wrote a `teams:` block that resolved to nobody.
          <p className="faint outcome__none">{t.team.configuredButEmpty}</p>
        ) : (
          <ul className="doctor-list">
            {data.members.map((member) => (
              <Member key={member.id} member={member} />
            ))}
          </ul>
        )}
      </Block>

      {data.deferrals.length === 0 ? null : (
        <Block title={t.team.heldAWaveHeading} count={t.events.taskCount(data.deferrals.length)}>
          <ul className="doctor-list">
            {data.deferrals.map((deferral) => (
              <Deferral key={`${deferral.taskId}:${deferral.reason}`} deferral={deferral} />
            ))}
          </ul>
        </Block>
      )}

      <Block title={t.team.whyHeading} count={t.team.assignmentCount(data.assignments.length)}>
        {data.assignments.length === 0 ? (
          <p className="faint outcome__none">{t.team.noAssignments}</p>
        ) : (
          data.assignments.map((assignment) => (
            <Assignment key={`${assignment.taskId}:${assignment.assignedAt}`} assignment={assignment} />
          ))
        )}
      </Block>
    </div>
  );
}

/**
 * One member: who they are, how loaded, and what they hold.
 *
 * The load is a fraction rather than a bar, because the denominator is the fact that
 * matters — `2/2` says "raise the capacity or wait" and a full bar says neither.
 */
function Member({ member }: { readonly member: TeamMemberView }) {
  const t = useT();
  // A role id and a runner id are configuration keys, and stay as written.
  const detail: string[] = [`${member.role} · ${member.runner}`];
  if (member.skills.length > 0) detail.push(member.skills.join(' '));
  if (member.specializations.length > 0) detail.push(t.team.specialisesIn(member.specializations.join(', ')));
  const owned = [...member.ownership.exclusive, ...member.ownership.preferred];
  if (owned.length > 0) detail.push(t.team.owns(owned.join(' ')));
  if (member.assigned.length > 0) detail.push(t.team.holds(member.assigned.join(', ')));

  return (
    <li className="doctor-row" data-member={member.id} data-status={member.status}>
      <span className="doctor-row__name">
        {member.displayName}
        {/*
          **This model is intent, and it is labelled as intent.** `TeamMemberView.model`
          is read from configuration at request time — the contract calls it "a view of
          what the run would resolve rather than of a record". Drawn in the same words as
          a task's *persisted* model, it would recreate the confusion Issue #21 removed.
        */}
        <small className="doctor-note">
          {member.model === undefined ? t.team.noModelPinned : t.team.modelConfigured(member.model)}
        </small>
      </span>
      <span className="doctor-row__value">{detail.join(' · ')}</span>
      <span className="team-load">
        <span className="mono">
          {member.assigned.length}/{member.maxConcurrentTasks}
        </span>
        <Chip tone={memberTone(member.status)}>{word(t, member.status)}</Chip>
      </span>
    </li>
  );
}

function Deferral({ deferral }: { readonly deferral: WaveDeferralView }) {
  const t = useT();
  const detail: string[] = [deferral.detail];
  if (deferral.waitsFor !== undefined) detail.push(t.team.waitsFor(deferral.waitsFor));
  if (deferral.patterns.length > 0) detail.push(deferral.patterns.join(' '));

  return (
    <li className="doctor-row" data-task={deferral.taskId} data-reason={deferral.reason}>
      <span className="doctor-row__name mono">{deferral.taskId}</span>
      <span className="doctor-row__value">{detail.join(' · ')}</span>
      <Chip tone={deferral.reason === 'capacity' ? 'idle' : 'warn'}>{word(t, deferral.reason)}</Chip>
    </li>
  );
}

/**
 * Why this task went to this agent (§38), folded until asked.
 *
 * The closed state is the answer: who holds it and the one-sentence reason the policy
 * recorded. The ranking is behind the disclosure because "why not the other one" is a
 * real question and a rare one — and a run with nine tasks is nine headers, not nine
 * tables. The same fold the review threads use, for the same reason.
 */
function Assignment({ assignment }: { readonly assignment: TaskAssignmentView }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const refused = assignment.reason === 'no_eligible_member';

  return (
    <div className="thread" data-task={assignment.taskId}>
      <button type="button" className="thread__head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="thread__task">{assignment.taskId}</span>
        <span>{assignment.agentName}</span>
        <Chip tone={refused ? 'warn' : 'idle'} plain>
          {word(t, assignment.reason)}
        </Chip>
        {assignment.previousAgentId === undefined ? null : (
          <Chip tone="warn" plain title={t.team.reassignmentTitle}>
            {t.team.from(assignment.previousAgentId)}
          </Chip>
        )}
        <span className="thread__meta">
          {t.team.candidateCount(assignment.candidates.length)} · {t.team.why}
        </span>
      </button>

      {!open ? null : (
        <div className="thread__body">
          {assignment.detail === undefined ? null : <p className="doctor-note">{assignment.detail}</p>}
          {assignment.candidates.length === 0 ? (
            // A run from before the ranking was recorded. Saying so beats an empty table,
            // which reads as "nobody was considered".
            <p className="faint outcome__none">{t.team.noRanking}</p>
          ) : (
            <table className="ranking">
              <thead>
                <tr>
                  <th scope="col">{t.team.candidate}</th>
                  <th scope="col">{t.team.skills}</th>
                  <th scope="col">{t.team.ownsColumn}</th>
                  <th scope="col">{t.team.riskColumn}</th>
                  <th scope="col">{t.team.score}</th>
                </tr>
              </thead>
              <tbody>
                {assignment.candidates.map((candidate) => (
                  <Candidate key={candidate.agentId} candidate={candidate} held={candidate.agentId === assignment.agentId} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function Candidate({ candidate, held }: { readonly candidate: CandidateView; readonly held: boolean }) {
  const t = useT();
  return (
    <tr data-agent={candidate.agentId} data-held={held ? 'true' : undefined} data-excluded={candidate.excludedBy === undefined ? undefined : 'true'}>
      <td>
        <b>{candidate.agentName}</b>
        {/*
          The reason the candidate is out, in the row it is out of. A greyed row says
          "not this one" and never says why, and why is the whole question this table
          exists to answer.
        */}
        {candidate.excludedBy === undefined ? null : <span className="faint"> — {word(t, candidate.excludedBy)}</span>}
      </td>
      <td className="mono">{percent(candidate.skillMatch)}</td>
      <td className="mono">{percent(candidate.ownership)}</td>
      <td>{candidate.riskFit === 1 ? t.team.fits : t.common.none}</td>
      <td className="mono">{candidate.score.toFixed(2)}</td>
    </tr>
  );
}

function percent(value: number): string {
  return `${String(Math.round(value * 100))}%`;
}

