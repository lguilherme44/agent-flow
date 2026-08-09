/**
 * Structural validation of the SDD (§11, §40).
 *
 * The SDD is the contract every later stage is judged against, so "the model
 * produced something that looks like a design document" is not good enough. A
 * missing section here becomes a blind spot in planning and, later, a gap
 * nobody notices in review.
 *
 * Deliberately structural only: whether the content is *good* is what the plan
 * review and the human checkpoint are for. This catches the failures that can
 * be caught for free.
 */

/** The twenty-one sections §11 mandates, in order. */
export const REQUIRED_SDD_SECTIONS = [
  'Context',
  'Problem',
  'Current Behavior',
  'Desired Behavior',
  'Functional Requirements',
  'Non-Functional Requirements',
  'Architecture',
  'Components Affected',
  'Database Changes',
  'API Changes',
  'Frontend Changes',
  'Domain Changes',
  'Contracts and Interfaces',
  'Security',
  'Observability',
  'Migration Strategy',
  'Testing Strategy',
  'Edge Cases',
  'Risks',
  'Alternatives Considered',
  'Acceptance Criteria',
] as const;

const REQUIREMENT_ID = /\b(FR|NFR|SEC)-\d{3}\b/g;

/** Sorted, deduplicated requirement ids appearing anywhere in the text. */
export function extractRequirementIds(text: string): string[] {
  const found = new Set(text.match(REQUIREMENT_ID) ?? []);
  return [...found].sort();
}

/** Markdown headings, normalised for comparison. */
function headings(document: string): Set<string> {
  const found = new Set<string>();
  for (const match of document.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    if (match[1]) found.add(match[1].trim().toLowerCase());
  }
  return found;
}

/**
 * Returns every problem at once. Repairing one section per round trip would
 * cost several model calls for something a single pass can report.
 */
export function validateSdd(document: string): string[] {
  const problems: string[] = [];
  const present = headings(document);

  const missing = REQUIRED_SDD_SECTIONS.filter(
    (section) => !present.has(section.toLowerCase()),
  );

  if (missing.length > 0) {
    problems.push(`missing required section(s): ${missing.join(', ')}`);
  }

  const functional = extractRequirementIds(document).filter((id) => id.startsWith('FR-'));
  if (functional.length === 0) {
    // Without a functional requirement there is nothing for the coverage check
    // to verify and no way to tie a task back to a decision.
    problems.push(
      'no functional requirements found — each must carry an id such as FR-001',
    );
  }

  return problems;
}
