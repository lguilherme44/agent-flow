import type { RuntimeEscalation } from '../../contracts/index.js';

/**
 * What an exhausted recovery loop tells the person who has to finish the job (C-22, AR-08).
 *
 * C-22's last line is a prohibition — **no surface renders the message "something failed,
 * inspect logs"** — and it is written that way because that sentence is what a surface
 * emits by default. The run knows the class, the counters, the evidence and every repair it
 * attempted; none of it reaches anybody unless something puts it there.
 *
 * The cost of not doing this is measured. Most of the evidence run's sixteen manual
 * operations were a person reconstructing, by hand and from `events.jsonl`, facts the run
 * was already holding.
 *
 * The action goes last, on its own line, because it is the only line that has to be read.
 */
export function renderEscalation(escalation: RuntimeEscalation): string {
  const lines: string[] = [
    `Automatic recovery stopped on ${escalation.task} — ${escalation.failureClass}.`,
    '',
  ];

  const counts = Object.entries(escalation.counts);
  if (counts.length > 0) {
    // Inline, one line: these are re-checkable numbers rather than a table to study.
    lines.push(`  Budgets spent   ${counts.map(([k, v]) => `${k} ${String(v)}`).join(' · ')}`);
  }

  lines.push(
    '',
    '  Repairs attempted',
    ...(escalation.attemptedRepairs.length === 0
      ? // Said plainly rather than left as an empty heading. "No automatic repair applied"
        // is a fact worth having: it means the class was never recoverable, not that a
        // repair was tried and failed.
        ['    no automatic repair applied']
      : escalation.attemptedRepairs.map((repair) => `    ${repair.step} → ${repair.outcome}`)),
  );

  if (escalation.evidence.length > 0) {
    lines.push('', '  Evidence', ...escalation.evidence.map((line) => `    ${line}`));
  }

  lines.push('', `Do this: ${escalation.humanAction}`);

  return lines.join('\n');
}
