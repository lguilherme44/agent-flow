import { CircleDashed, Loader2, PauseCircle, Users } from 'lucide-react';
import type {
  TaskAssignmentView,
  TeamMemberView,
  TeamView,
  WaveDeferralView,
} from '@contracts/index.js';
import { Badge, Card, Empty, cx } from '../components/ui';
import { configuredModelLabel, hasModel } from '../lib/model-label';

/**
 * Who is doing the work, and what the run would not start (§37).
 *
 * **A projection of the server's projection.** Nothing here ranks a candidate, decides
 * who should hold a task or works out whether a member is busy — every answer arrives
 * from `core/team/view.ts`, the same fold `af status` prints. A component that computed
 * an assignment would be a second assignment authority, and it would be the one that
 * drifts, because the real answer is not on screen (I-33).
 *
 * Deliberately not a roster directory. A list of everyone with their skills is a
 * configuration file rendered in HTML; what a person needs from this card is **who is
 * loaded, who is idle, and what is waiting** — the three facts that decide whether to
 * change the configuration or leave the run alone.
 */

const STATUS_TONE = { full: 'warning', working: 'primary', idle: 'muted' } as const;
const STATUS_ICON = { full: PauseCircle, working: Loader2, idle: CircleDashed };

export function TeamPanel(props: { team: TeamView | undefined; className?: string }): JSX.Element {
  const view = props.team;
  const members = view?.members ?? [];
  const totals = view?.totals;

  // Only what somebody might still act on. A deferral from four waves ago describes a
  // task that has since run, and this row is read to decide what happens next.
  const waiting = (view?.deferrals ?? []).slice(-2);
  const refused = (view?.assignments ?? []).filter(
    (assignment) => assignment.reason === 'no_eligible_member',
  );

  return (
    <Card
      title="Team"
      {...(props.className === undefined ? {} : { className: props.className })}
      footer={
        totals === undefined ? null : (
          <span>
            {String(totals.assignments)} assignment(s), {String(totals.candidatesConsidered)}{' '}
            candidate(s) considered
            {totals.reassignments === 0
              ? null
              : ` · ${String(totals.reassignments)} reassignment(s)`}
            {/* Which filter fired and how often (§41). In the footer rather than the
                body: it is a fact about the configuration's shape, read after the
                members rather than instead of them. */}
            {Object.keys(totals.exclusions).length === 0
              ? null
              : ` · ruled out ${Object.entries(totals.exclusions)
                  .map(([reason, count]) => `${String(count)} ${reason.replace(/_/g, ' ')}`)
                  .join(', ')}`}
          </span>
        )
      }
    >
      {members.length === 0 ? (
        <Empty
          title="No team configured."
          // "Unconfigured" and "configured but idle" are different states and the hint
          // depends on which. Sending somebody to edit a `teams:` block they already
          // wrote would be the screen misreading its own data.
          hint="Add a teams: block to assign tasks by skill, ownership and capacity."
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          {refused.length === 0 ? null : <Refusals total={refused.length} first={refused[0]?.detail} />}
          <ul className="flex flex-col divide-y divide-border/70">
            {/* Four, which is what fits before the fifth is sliced. Beyond that the
                footer's totals are the honest summary — a card is not a directory. */}
            {members.slice(0, 4).map((member) => (
              <Member key={member.id} member={member} />
            ))}
          </ul>
          {members.length > 4 ? (
            <p className="text-micro text-faint">
              … and {String(members.length - 4)} more member(s)
            </p>
          ) : null}
          {waiting.length === 0 ? null : <Waiting deferrals={waiting} />}
        </div>
      )}
    </Card>
  );
}

/**
 * One member: who they are, how loaded, and what they hold.
 *
 * The load is a fraction rather than a bar, because the denominator is the fact that
 * matters — `2/2` says "change the capacity or wait" and a full bar says neither.
 */
function Member(props: { member: TeamMemberView }): JSX.Element {
  const { member } = props;
  const Icon = STATUS_ICON[member.status];

  return (
    <li className="flex items-start justify-between gap-2 py-1">
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon
            className={cx(
              'h-3.5 w-3.5 shrink-0',
              member.status === 'working' && 'animate-spin text-primary-bright',
              member.status === 'full' && 'text-warning',
              member.status === 'idle' && 'text-faint',
            )}
            aria-hidden
          />
          <span className="truncate text-label font-medium text-text">{member.displayName}</span>
          {/* §97: status is never colour alone. The word rides with the glyph. */}
          <Badge tone={STATUS_TONE[member.status]} caps>
            {member.status}
          </Badge>
        </span>
        {/* **This model is intent, and it is labelled as intent** (Issue #21).
            `TeamMemberView.model` comes from `loadConfig` at read time — the contract says
            so in its own words: "a view of what the run would resolve rather than of a
            record". Rendering it in the same visual language as a task's *persisted*
            model would recreate exactly the confusion the model-identity work exists to
            remove, so the word `configured` rides with it and it is never `not reported`. */}
        <span className="mt-0.5 flex min-w-0 items-baseline gap-1">
          <span
            className={cx(
              'truncate text-micro',
              hasModel(member) ? 'text-muted' : 'italic text-faint',
            )}
            title={`Configured: ${configuredModelLabel(member)}`}
          >
            {configuredModelLabel(member)}
          </span>
          {/* **The qualifier rides on a value and not on an absence.** The first draft
              printed it unconditionally, and the reviewer row read `no model pinned
              configured` — two words arguing with each other, which the screenshot showed
              and no assertion would have. There is nothing to qualify when nothing is
              pinned: the phrase already says it is talking about configuration. */}
          {hasModel(member) ? (
            <span className="shrink-0 text-micro text-faint">configured</span>
          ) : null}
        </span>
        <span className="mt-0.5 truncate text-micro text-faint">
          {member.role} · {member.runner}
          {member.skills.length === 0 ? null : ` · ${member.skills.join(' ')}`}
        </span>
        {member.assigned.length === 0 ? null : (
          <span className="mt-0.5 truncate text-micro text-muted">
            {member.assigned.join(', ')}
          </span>
        )}
      </span>
      <span className="tabular shrink-0 text-micro text-muted">
        {String(member.assigned.length)}/{String(member.maxConcurrentTasks)}
      </span>
    </li>
  );
}

/**
 * The one outcome that means the team was consulted and could not answer.
 *
 * Pinned above the list, because a task that fell back to the router ran on a role rather
 * than on a member — and the reason is always something in the configuration, which is
 * the thing this card exists to make legible.
 */
function Refusals(props: { total: number; first: string | undefined }): JSX.Element {
  return (
    <div className="rounded-md border border-warning/40 bg-warning/5 p-2">
      <p className="flex items-center gap-1.5 text-label font-semibold text-warning">
        <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {String(props.total)} task(s) no member could take
      </p>
      <p className="mt-0.5 text-micro text-muted">
        {props.first ?? 'They ran on the role the router chose.'}
      </p>
    </div>
  );
}

function Waiting(props: { deferrals: readonly WaveDeferralView[] }): JSX.Element {
  return (
    <div className="rounded-md border border-border/70 bg-surface-2/40 p-2">
      <p className="text-label font-medium text-text">Held a wave</p>
      <ul className="mt-1 flex flex-col gap-1">
        {props.deferrals.map((deferral) => (
          <li key={`${deferral.taskId}-${deferral.reason}`} className="text-micro leading-snug">
            <span className="tabular font-medium text-text">{deferral.taskId}</span>{' '}
            <Badge tone={deferral.reason === 'capacity' ? 'info' : 'warning'}>
              {deferral.reason}
            </Badge>{' '}
            <span className="text-muted">{deferral.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Why this task went to this agent (§38).
 *
 * **Progressive disclosure, and the summary is the answer.** The closed state is one
 * line — who has it, and the one-sentence reason the policy recorded — because that is
 * what a person reading a task wants. The ranking is behind the disclosure, because
 * "why not the other one" is a real question and a rare one, and putting a table of every
 * candidate in a header is how an inspector becomes an airport departures board.
 *
 * Every number here was computed by `core/team/policy.ts` at the instant the task started
 * and read back out of the audit log. Nothing is recomputed: a browser that re-scored the
 * candidates would eventually disagree with the run, and the screen would be describing a
 * decision nobody made (I-33, I-34).
 */
/**
 * The assignment in force for one task, or nothing.
 *
 * The last one wins: a reassignment appends to the log rather than rewriting it, so the
 * log keeps the history and this keeps the answer.
 *
 * **Exported so the inspector's identity row and this note share one fold.** They render
 * the same assignment two ways — a metadata cell and a disclosure — and two folds over
 * one list is two chances to disagree about which assignment is current, on the same
 * screen, at the same time.
 */
export function assignmentInForce(
  team: TeamView | undefined,
  taskId: string,
): TaskAssignmentView | undefined {
  return [...(team?.assignments ?? [])].reverse().find((held) => held.taskId === taskId);
}

export function TaskAssignmentNote(props: {
  team: TeamView | undefined;
  taskId: string;
}): JSX.Element | null {
  const assignment = assignmentInForce(props.team, props.taskId);

  if (assignment === undefined) return null;

  const refused = assignment.reason === 'no_eligible_member';

  return (
    // `pb-1.5` rather than `py-1`: the open state ends in a table whose last row carries
    // no bottom border — `divide-y` draws between rows — and 4px under it read as a cut
    // edge in the screenshot. Measured before it was believed: `scrollHeight` equalled
    // `clientHeight`, so nothing was ever clipped and this is a legibility change, not a
    // bug fix. 7px is enough for the row to end rather than stop.
    <details className="group rounded-sm border border-border/70 bg-surface-2/40 px-2 pb-1.5 pt-1">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-label">
        <Users className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
        <span className="text-faint">Assigned to</span>
        <span className="font-medium text-text">{assignment.agentName}</span>
        <Badge tone={refused ? 'warning' : 'muted'}>{assignment.reason.replace(/_/g, ' ')}</Badge>
        {assignment.previousAgentId === undefined ? null : (
          <span className="text-micro text-faint">from {assignment.previousAgentId}</span>
        )}
        <span className="ml-auto text-micro text-faint group-open:hidden">why?</span>
      </summary>

      {assignment.detail === undefined ? null : (
        <p className="mt-1 text-micro leading-snug text-muted">{assignment.detail}</p>
      )}

      {assignment.candidates.length === 0 ? (
        // A run from before the ranking was recorded. Saying so beats an empty table
        // that reads as "nobody was considered".
        <p className="mt-1 text-micro text-faint">No candidate ranking was recorded.</p>
      ) : (
        <table className="mt-1.5 w-full text-micro">
          <thead>
            <tr className="text-faint">
              <th className="py-0.5 text-left font-normal">Candidate</th>
              <th className="py-0.5 text-right font-normal">Skills</th>
              <th className="py-0.5 text-right font-normal">Owns</th>
              <th className="py-0.5 text-right font-normal">Role</th>
              <th className="py-0.5 text-right font-normal">Score</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {assignment.candidates.map((candidate) => (
              <tr
                key={candidate.agentId}
                className={cx(candidate.excludedBy !== undefined && 'text-faint')}
              >
                <td className="py-0.5 text-left">
                  <span
                    className={cx(
                      candidate.agentId === assignment.agentId && 'font-medium text-text',
                    )}
                  >
                    {candidate.agentName}
                  </span>
                  {candidate.excludedBy === undefined ? null : (
                    // The reason the candidate is out, in the row it is out of. A
                    // strikethrough alone says "not this one" and never says why, and
                    // why is the whole question this table exists to answer.
                    <span className="ml-1 text-faint">— {candidate.excludedBy.replace(/_/g, ' ')}</span>
                  )}
                </td>
                <td className="tabular py-0.5 text-right">{percent(candidate.skillMatch)}</td>
                <td className="tabular py-0.5 text-right">{percent(candidate.ownership)}</td>
                <td className="py-0.5 text-right">{candidate.riskFit === 1 ? 'fits' : '—'}</td>
                <td className="tabular py-0.5 text-right">{candidate.score.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

function percent(value: number): string {
  return `${String(Math.round(value * 100))}%`;
}
