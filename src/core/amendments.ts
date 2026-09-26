import type { Amendment, AttachedFinding, Finding, RunActor } from '../contracts/index.js';

/**
 * Operator amendments, read into the two prompts that have to honour them (P7.1, P7.4, P7.5).
 *
 * An amendment is recorded by a use case; this module only decides what a prompt says about
 * one. Every renderer returns `''` when there is nothing to say, because the value lands in
 * an existing template slot — `failureContext` for an implementation attempt, `sdd` for the
 * final review — and an empty value there is today's byte stream. Anything else, even a
 * lone heading, would change every prompt of every run that never recorded a decision.
 *
 * Operator and reviewer text is inserted verbatim and never interpreted. The renderer that
 * receives it does one pass, so a `{{sdd}}` inside an answer reaches the model literally.
 */

export interface FindingRoute {
  /** The finding's position in the list it was routed from. */
  readonly index: number;
  readonly tasks: readonly string[];
}

const TASK_ID = /\b(?:TASK|FIX)-\d{3}\b/g;

/**
 * Which plan tasks each finding is about (FR-017).
 *
 * A task counts only when its id appears in the finding's description or suggested action
 * **and** exists in the plan. A reviewer citing a task the plan no longer has is not
 * pointing at anything, and routing that finding nowhere would drop it; so a finding with
 * no existing citation goes to every task, which is where an unscoped concern belongs.
 *
 * Ids come back in plan order rather than citation order, so one plan routes one way
 * however a reviewer happened to phrase the finding.
 */
export function routeFindings(
  findings: readonly Finding[],
  planTaskIds: readonly string[],
): FindingRoute[] {
  const known = new Set(planTaskIds);
  return findings.map((finding, index) => {
    const cited = new Set<string>();
    for (const text of [finding.description, finding.suggestedAction]) {
      for (const [id] of text.matchAll(TASK_ID)) if (known.has(id)) cited.add(id);
    }
    const tasks = cited.size > 0 ? planTaskIds.filter((id) => cited.has(id)) : [...planTaskIds];
    return { index, tasks };
  });
}

const OPERATOR_PREAMBLE =
  'Operator decisions about this task. They override the plan where they contradict it; the SDD still applies everywhere else.';

/**
 * What an operator told this task, for its next implementation attempt (FR-004, FR-018).
 *
 * Only amendments recorded against `approvedPlanHash` apply. An answer is about the plan it
 * was given under; once a replan changes the hash, the question it answered may not exist
 * any more, and repeating it to the next attempt would be answering a question nobody
 * asked. With no approved plan there is nothing an amendment can be bound to, so nothing
 * applies.
 */
export function renderTaskOperatorContext(
  amendments: readonly Amendment[],
  taskId: string,
  approvedPlanHash: string | undefined,
): string {
  if (approvedPlanHash === undefined) return '';
  const current = amendments.filter((amendment) => amendment.planHash === approvedPlanHash);

  const answers = current.flatMap((amendment) =>
    amendment.kind === 'answer' && amendment.task === taskId && amendment.text !== undefined
      ? [{ at: amendment.at, text: amendment.text }]
      : [],
  );
  const findings = current
    .filter((amendment) => amendment.kind === 'attached_findings')
    .flatMap((amendment) => amendment.findings ?? [])
    .filter((attached) => attached.tasks.includes(taskId));

  const sections: string[] = [];

  if (answers.length > 0) {
    const lines = ['## Operator answers', '', OPERATOR_PREAMBLE];
    answers.forEach((answer, position) => {
      lines.push('', `### Answer ${String(position + 1)} (${answer.at})`, '', answer.text);
    });
    sections.push(lines.join('\n'));
  }

  if (findings.length > 0) {
    // Named for its source, because this text was written by a reviewing model and not by
    // the operator (SEC-005). The operator decided the task should see it; what it says is
    // still the reviewer's claim.
    const lines = [
      '## Attached review findings',
      '',
      'Findings from the plan review that an operator attached to this task when approving the plan over them. They were written by the reviewer, not by the operator.',
    ];
    for (const attached of findings) lines.push('', ...renderFinding(attached.finding));
    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}

function renderFinding(finding: Finding): string[] {
  const lines = [`### ${finding.severity} — ${finding.type}`];
  if (finding.requirement !== undefined) lines.push(`Requirement: ${finding.requirement}`);
  if (finding.file !== undefined) lines.push(`File: ${finding.file}`);
  lines.push(`Description: ${finding.description}`, `Suggested action: ${finding.suggestedAction}`);
  return lines;
}

/**
 * Every amendment, for the final reviewer (FR-011).
 *
 * Unfiltered by plan hash, unlike the task context: the final review judges the whole run,
 * and a decision that was retired from the prompts by a replan is still a decision the
 * code was built after.
 */
export function renderAmendmentsForReview(amendments: readonly Amendment[]): string {
  if (amendments.length === 0) return '';

  const lines = [
    '## Operator amendments',
    '',
    'Decisions an operator recorded on this run, in the order they were made.',
  ];
  for (const amendment of amendments) {
    lines.push('', `### ${amendment.id} — ${amendment.kind}`, '');
    lines.push(`- Actor: ${actorName(amendment.actor)}`, `- At: ${amendment.at}`);
    const subject = subjectOf(amendment);
    if (subject !== undefined) lines.push(`- Subject: ${subject}`);
    if (amendment.findingCount !== undefined) {
      lines.push(`- Findings in the review: ${String(amendment.findingCount)}`);
    }
    if (amendment.text !== undefined) lines.push(`- Text: ${amendment.text}`);
    for (const attached of amendment.findings ?? []) lines.push(findingSummary(attached));
  }
  return lines.join('\n');
}

function actorName(actor: RunActor): string {
  if (actor.kind === 'keyboard') return 'keyboard';
  // A label is the name a person gave the device and may be empty; the id is what the
  // pairing issued, so it still says which device it was rather than saying nothing.
  return actor.label.length > 0 ? actor.label : actor.deviceId;
}

function subjectOf(amendment: Amendment): string | undefined {
  if (amendment.fromWorkflow !== undefined && amendment.toWorkflow !== undefined) {
    return `${amendment.fromWorkflow} → ${amendment.toWorkflow}`;
  }
  return amendment.task ?? amendment.planHash;
}

/** One line per finding, however many lines the reviewer wrote. */
function findingSummary(attached: AttachedFinding): string {
  const { finding } = attached;
  const description = finding.description.replace(/\s+/g, ' ').trim();
  return `- Finding ${String(attached.index)} (${finding.severity}, ${finding.type}) → ${attached.tasks.join(', ')}: ${description}`;
}
