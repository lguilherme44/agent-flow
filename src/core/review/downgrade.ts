import { severityAtLeast, type Finding, type FindingSeverity } from '../../contracts/index.js';

/**
 * What a finding may block, decided before anything weighs it (ported from the Smart Place
 * kit's `lib/verdict.ts`, itself a port of SmartCore's `.review/aggregate.mjs`).
 *
 * **A reviewer proposes severity; this decides what that severity is allowed to stop.**
 * `decision.ts` already refuses to take a reviewer's `approve` as a gate. The other half is
 * the reverse: a review that *blocks* for nothing is just as expensive, and two ways of doing
 * it were measured in the kit's benchmark — a `high` that named no failure anyone could
 * reproduce, and a `high` about prose: a doc page, the run's own plan.
 *
 * ```text
 * names only documentation          -> at most medium, marked `documentation`
 * would block and has no evidence   -> medium,          marked `no-evidence`
 * ```
 *
 * **Downgraded findings are kept, never dropped.** They are still true observations and
 * still become corrective work; they only stop blocking.
 *
 * Pure: findings in, findings out. Nothing here reads a file or runs a command.
 */

/** Why a finding stopped blocking. Ours to set: a reviewer that marked its own marked nothing. */
export type DowngradeReason = 'documentation' | 'no-evidence';

export interface Downgraded {
  readonly finding: Finding;
  /** Absent when the finding was left exactly as the reviewer proposed it. */
  readonly downgraded?: DowngradeReason;
}

/**
 * What is under review. `code` (the default): the run's product, where its own artifacts are
 * prose about it. `plan`: the round where the plan and the SDD *are* the product — the kit's
 * audit of 22/10/2026 found a `high` citing `plan.json` line 14, with a real failure, coming
 * out downgraded as documentation, and the plan passing.
 */
export type ReviewSubject = 'code' | 'plan';

/** What a reviewer writes when it has no failure to name. Not evidence. */
const PLACEHOLDER = /^(?:n\/?a|none|unknown|-+|tbd|null|undefined)\.?$/i;

/**
 * `src/a.ts:42` — a repository path with an extension, then a line.
 *
 * The extension starts with a letter, so `v1.2:3` and `10.30:00` are not citations.
 */
const PATH_LINE = /(?:^|[\s\x60\x27\x22(])[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z][A-Za-z0-9]*:\d+\b/;

/** The prose files a repository keeps for people, wherever they sit. */
const PROSE_FILE = /^(?:readme|changelog|contributing|license|code_of_conduct|security|history|notice)\.mdx?$/;

/** The run's own workspace: its plan, its SDD, its reviews. Prose about the run, not product. */
const RUN_ARTIFACTS = '.agent-flow/';

const normalise = (raw: string): string => raw.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

/**
 * `docs/`, the conventional prose files, or the run's own artifacts.
 *
 * **Not every `.md`.** A Markdown file in `prompts/`, an `AGENTS.md` or a `CLAUDE.md` is what
 * an agent reads and acts on — in this repository the prompts *are* product code. Reading
 * `*.md` as prose would make every review of a prompt change unable to fail, which is exactly
 * the change most worth reviewing.
 */
export function isDocumentationPath(raw: string): boolean {
  const path = normalise(raw);
  const basename = path.slice(path.lastIndexOf('/') + 1);
  return path.startsWith('docs/') || PROSE_FILE.test(basename) || path.startsWith(RUN_ARTIFACTS);
}

/** `.agent-flow/**\/plan.json` or `sdd.md`: what a plan review is actually about. */
function isPlanArtifact(raw: string): boolean {
  const path = normalise(raw);
  const basename = path.slice(path.lastIndexOf('/') + 1);
  return path.startsWith(RUN_ARTIFACTS) && (basename === 'plan.json' || basename === 'sdd.md');
}

/**
 * Every path the finding names is documentation, and it names at least one.
 *
 * A finding that names nothing is **not** documentation-only: there is no way to tell, and
 * guessing "prose" from the wording would be a second model's opinion standing in for a fact.
 */
export function isDocumentationOnly(finding: Finding, subject: ReviewSubject = 'code'): boolean {
  if (finding.file === undefined) return false;
  if (subject === 'plan' && isPlanArtifact(finding.file)) return false;
  return isDocumentationPath(finding.file);
}

/**
 * A file and a line, a `path:line` citation in the description, or a file reference the
 * reviewer attached as evidence.
 *
 * A file alone is not evidence: it says where to look, not what goes wrong.
 */
export function hasFailureEvidence(finding: Finding): boolean {
  if (finding.location !== undefined && finding.file !== undefined) return true;
  if (PATH_LINE.test(finding.description)) return true;
  return finding.evidence.some(
    (reference) =>
      reference.kind === 'file' && reference.id.trim().length > 0 && !PLACEHOLDER.test(reference.id),
  );
}

/**
 * The evidence rule applies to every finding that would block — not to critical/high alone.
 *
 * Applied only to the top two, a review at a `medium` threshold let an unproven `high` through
 * while an unproven `medium` blocked, which is the rule standing on its head.
 */
export function downgradeFinding(
  finding: Finding,
  blockAt: FindingSeverity = 'high',
  subject: ReviewSubject = 'code',
): Downgraded {
  if (isDocumentationOnly(finding, subject) && severityAtLeast(finding.severity, 'medium')) {
    return { finding: { ...finding, severity: 'medium' }, downgraded: 'documentation' };
  }
  const evidenceRequiredAt: FindingSeverity = severityAtLeast(blockAt, 'high') ? 'high' : blockAt;
  if (severityAtLeast(finding.severity, evidenceRequiredAt) && !hasFailureEvidence(finding)) {
    return { finding: { ...finding, severity: 'medium' }, downgraded: 'no-evidence' };
  }
  return { finding };
}

/** Every finding, adjusted, with the ones that still block separated out. */
export function downgradeFindings(
  findings: readonly Finding[],
  blockAt: FindingSeverity = 'high',
  subject: ReviewSubject = 'code',
): { readonly all: readonly Downgraded[]; readonly blocking: readonly Finding[] } {
  const all = findings.map((finding) => downgradeFinding(finding, blockAt, subject));
  return {
    all,
    blocking: all
      .filter((entry) => entry.downgraded === undefined && severityAtLeast(entry.finding.severity, blockAt))
      .map((entry) => entry.finding),
  };
}
