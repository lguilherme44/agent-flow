import { FINDING_SEVERITIES, type FindingSeverity } from '../contracts/index.js';

/**
 * What the planner is handed when a plan is planned again (D14).
 *
 * **Measured on AF-2026-004, a high-risk run.** The cross-provider plan review wrote
 * nine findings into `reviews/plan-review.json`, each anchored to a file and a line.
 * Neither `revise` nor `feature --from planning` forwarded one of them: `revise` built
 * the planner input from the request and the sentence the human typed, and nothing
 * else. The operator had to paste the nine findings into the description by hand, and
 * the three-cycle review loop that is supposed to converge replanned against the same
 * gap and was refused for the same reason each time.
 *
 * Pure on purpose. The decision "does this review reject the plan" and the shape of
 * the text the planner reads are both judgements that need no store, no clock and no
 * runner to test — so they live here, and the use cases only supply the artifact.
 */

/**
 * The delimiters, exported because they are a contract with two readers: the stripper
 * below, which must find a section a previous replan left behind, and the tests that
 * assert a section is present or absent.
 */
export const FINDINGS_SECTION_BEGIN = '--- BEGIN FINDINGS FROM THE PREVIOUS PLAN REVIEW ---';
export const FINDINGS_SECTION_END = '--- END FINDINGS FROM THE PREVIOUS PLAN REVIEW ---';

/**
 * How many findings are forwarded.
 *
 * Twelve, and bounded on purpose: the planner input also carries the feature request,
 * and the planning prompt then adds the SDD, the architecture impact, the project
 * configuration and the validation ids. The observed review wrote nine findings, so
 * twelve leaves headroom over what a real cross-provider review produces while keeping
 * a pathological reviewer from spending the whole planning budget on its own prose.
 * What is dropped is what the severity order puts last.
 */
export const MAX_FORWARDED_FINDINGS = 12;

/**
 * How much prose one finding may contribute, per field.
 *
 * A finding is an anchor plus an argument. Four hundred characters is roughly a
 * paragraph, which is what the anchored findings on the measured run actually were —
 * past that the reviewer is restating the plan, and the planner already has the plan.
 */
export const MAX_FINDING_CHARS = 400;

/** Where a finding points, when the reviewer could say. */
export interface ReplanLocation {
  readonly line: number;
  readonly endLine?: number;
}

/**
 * A finding, reduced to what a planner can act on.
 *
 * Structural rather than the persisted schema type, so this function is testable
 * without building a whole `ReviewResult` — and so a finding written before a field
 * existed still renders.
 */
export interface ReplanFinding {
  readonly severity: FindingSeverity;
  readonly type: string;
  readonly description: string;
  readonly suggestedAction?: string;
  readonly file?: string;
  readonly location?: ReplanLocation;
}

/** The part of a plan review this module reads. */
export interface ReplanReview {
  readonly verdict: 'PASS' | 'FAIL';
  readonly findings: readonly ReplanFinding[];
}

export interface ReplanInputRequest {
  /** The feature request, as the run recorded it. */
  readonly request: string;
  /** What a person typed, when a person asked. Absent for `--from planning`. */
  readonly instruction?: string;
  /** The last plan review, whatever its verdict. Absent when the run has none. */
  readonly review?: ReplanReview | null;
}

export interface ReplanInput {
  /** What the pipeline hands the planner. */
  readonly text: string;
  readonly findingsForwarded: number;
  readonly findingsOmitted: number;
}

/**
 * `file:line`, `file:line-endLine`, `file`, or nothing.
 *
 * The anchor is the reason forwarding a finding is worth anything: it tells the planner
 * which task to change rather than that something, somewhere, was wrong.
 */
export function anchorOf(finding: ReplanFinding): string | undefined {
  if (finding.file === undefined || finding.file.length === 0) return undefined;
  if (finding.location === undefined) return finding.file;

  const { line, endLine } = finding.location;
  return endLine === undefined || endLine === line
    ? `${finding.file}:${String(line)}`
    : `${finding.file}:${String(line)}-${String(endLine)}`;
}

/**
 * Removes any findings section a previous replan left in the text.
 *
 * `revise` reads the `request` artifact, and the pipeline overwrites that artifact with
 * whatever it was last handed — so without this, a second revision would carry the
 * first revision's findings verbatim, a third would carry both, and the cap above would
 * bound one round while the accumulated text grew without limit.
 */
export function stripFindingsSections(text: string): string {
  let out = text;

  for (;;) {
    const begin = out.indexOf(FINDINGS_SECTION_BEGIN);
    if (begin === -1) break;

    const end = out.indexOf(FINDINGS_SECTION_END, begin);
    // An unterminated section means the text was cut mid-render; dropping the tail is
    // the only safe reading, because everything after it is half a finding.
    out = end === -1 ? out.slice(0, begin) : out.slice(0, begin) + out.slice(end + FINDINGS_SECTION_END.length);
  }

  return out.trimEnd();
}

/**
 * Whether two requests are the same request, ignoring any findings section.
 *
 * `revise` reads the stored `request` artifact; `feature --from planning` is handed
 * whatever the operator retyped on the command line. A review's findings describe tasks
 * that answered one question, so a request that is no longer that question invalidates
 * them exactly the way a changed plan does — the anchors would point into a plan built
 * from something else. Compared after stripping, because the artifact carries the
 * section a previous replan left in it and the retyped description does not.
 */
export function sameReplanRequest(a: string, b: string | null | undefined): boolean {
  if (b === null || b === undefined) return false;
  return stripFindingsSections(a).trim() === stripFindingsSections(b).trim();
}

/** Renders the planner input for a replan, findings included when the plan was refused. */
export function renderReplanInput(input: ReplanInputRequest): ReplanInput {
  const request = stripFindingsSections(input.request.trim()).trim();
  const instruction = input.instruction?.trim() ?? '';

  // **Only a rejection.** A PASS review's remarks are observations, not reasons to
  // replan; forwarding them would teach the planner that every remark is a defect and
  // would make this a blanket paste rather than a guard.
  const rejected = input.review?.verdict === 'FAIL' ? (input.review.findings ?? []) : [];
  const ordered = [...rejected].sort(
    (a, b) => FINDING_SEVERITIES.indexOf(b.severity) - FINDING_SEVERITIES.indexOf(a.severity),
  );
  const forwarded = ordered.slice(0, MAX_FORWARDED_FINDINGS);
  const omitted = ordered.length - forwarded.length;

  const parts: string[] = [request];
  if (instruction.length > 0) {
    // The shape `revise` has always produced, kept verbatim so a replan without a
    // review reads exactly as it did before this existed.
    parts.push('---', `Revision requested by the reviewer:\n${instruction}`);
  }
  if (forwarded.length > 0) parts.push(renderSection(forwarded, omitted));

  return {
    text: parts.join('\n\n'),
    findingsForwarded: forwarded.length,
    findingsOmitted: omitted,
  };
}

function renderSection(findings: readonly ReplanFinding[], omitted: number): string {
  const lines: string[] = [
    FINDINGS_SECTION_BEGIN,
    'Findings from the previous plan review. The plan you are replacing was refused for',
    'these reasons. Address every one of them in the plan you return.',
    '',
  ];

  findings.forEach((finding, index) => {
    const anchor = anchorOf(finding) ?? 'no file anchor given';
    lines.push(`${String(index + 1)}. [${finding.severity}] ${finding.type} — ${anchor}`);
    lines.push(`   ${bound(finding.description)}`);
    const action = finding.suggestedAction?.trim() ?? '';
    if (action.length > 0) lines.push(`   Suggested action: ${bound(action)}`);
    lines.push('');
  });

  if (omitted > 0) {
    lines.push(
      `${String(omitted)} further finding${omitted === 1 ? ' was' : 's were'} omitted: at most ` +
        `${String(MAX_FORWARDED_FINDINGS)} are forwarded so the planner's request stays within ` +
        'its budget, and the least severe were dropped first.',
      '',
    );
  }

  lines.push(FINDINGS_SECTION_END);
  return lines.join('\n');
}

/** One finding may not swallow the request it is attached to. */
function bound(text: string): string {
  const collapsed = text.trim().replace(/\s*\n\s*/g, ' ');
  return collapsed.length <= MAX_FINDING_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_FINDING_CHARS)}… [truncated]`;
}
