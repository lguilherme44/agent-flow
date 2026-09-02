import type { TeamView } from '../../contracts/index.js';

/**
 * Who is doing what, in a terminal (M5-08, M5-ACC-15).
 *
 * **Rendered from `core/team/view.ts` — the projection the API returns and the dashboard
 * draws.** A CLI that folded the audit log itself would be a second answer to "who has
 * this task", and the second one is the one that eventually disagrees.
 *
 * Deliberately terse, for the same reason the collaboration section is: `status` is read
 * before deciding whether a run can move forward, and a candidate ranking table in the
 * middle of it would bury the gate. So: who holds what, what is waiting and why, and the
 * one assignment that is worth a second look — the full ranking is one HTTP call away.
 */

/**
 * The section, or nothing at all.
 *
 * Nothing when no team is configured, which is every project that has not opted in.
 * Printing a heading there would add lines to `status` for a feature nobody turned on —
 * and would imply the run made assignment decisions it did not.
 */
export function renderTeam(team: TeamView): string | undefined {
  if (!team.configured) return undefined;

  const lines: string[] = ['Team:'];

  for (const member of team.members) {
    const mark = member.status === 'full' ? '●' : member.status === 'working' ? '◐' : '○';
    const load = `${String(member.assigned.length)}/${String(member.maxConcurrentTasks)}`;
    const holding = member.assigned.length === 0 ? '' : ` — ${member.assigned.join(', ')}`;
    const skills = member.skills.length === 0 ? '' : ` [${member.skills.join(' ')}]`;

    lines.push(`  ${mark} ${member.id} ${load}  ${member.role} · ${member.runner}${skills}${holding}`);
  }

  // A run whose members are all idle and whose tasks all fell back to the router is a
  // team that is configured and not being used — worth saying, because the likeliest
  // cause is a role or a runner nobody can serve.
  if (team.totals.assignments === 0) {
    lines.push('  · no task has been assigned through the team yet');
    return lines.join('\n');
  }

  lines.push(
    `  ${String(team.totals.assignments)} assignment(s), ` +
      `${String(team.totals.candidatesConsidered)} candidate(s) considered` +
      (team.totals.reassignments === 0
        ? ''
        : ` · ${String(team.totals.reassignments)} reassignment(s)`),
  );

  const refused = team.assignments.filter(
    (assignment) => assignment.reason === 'no_eligible_member',
  );
  for (const assignment of refused.slice(0, 3)) {
    // Loud, because it is the one outcome that means the team was consulted and could not
    // answer: the task ran on the router's role and the configuration is why.
    lines.push(`  ⚠ ${assignment.taskId} — ${assignment.detail ?? 'no eligible member'}`);
  }

  const deferrals = team.totals.capacityDeferrals + team.totals.ownershipDeferrals;
  if (deferrals > 0) {
    lines.push(
      `  ⏸ ${String(deferrals)} task(s) held a wave — ` +
        `${String(team.totals.capacityDeferrals)} for capacity, ` +
        `${String(team.totals.ownershipDeferrals)} for ownership`,
    );
    for (const deferral of team.deferrals.slice(-3)) {
      lines.push(`    ${deferral.taskId}: ${deferral.detail}`);
    }
  }

  return lines.join('\n');
}
