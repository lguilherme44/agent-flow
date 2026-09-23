import type { StageRoutingRow, UnusedRunnerRow } from '../../app/diagnostics.js';
import { en, type Phrases } from '../../core/phrases/index.js';

/**
 * Two questions `doctor` did not answer, and an operator has to.
 *
 * The capability report is by **role**, which is how configuration is written.
 * Routing decisions are by **stage**, which is what actually runs — and the two
 * do not line up, because one role can serve stages with different needs.
 *
 * **Rendering only.** The judgement — which stage is served by more than it needs,
 * which runner is configured and routed nowhere — is made in `app/diagnostics.ts`,
 * so the terminal and the Deck report the same finding rather than two opinions
 * that agree until one of them is edited. What is left here is the shape of the
 * line, and the sentences that make a finding actionable in a terminal.
 */
export function renderStageRouting(
  rows: readonly StageRoutingRow[],
  say: Phrases = en,
): string[] {
  const lines: string[] = [say.doctor.stageRoutingHeading];

  for (const row of rows) {
    const nature = row.readsRepository ? say.doctor.readsRepository : say.doctor.textInTextOut;
    lines.push(`  ${row.stage.padEnd(20)} ${row.runner.padEnd(12)} ${nature}`);

    if (row.overpowered) {
      lines.push(`    · ${say.doctor.stageOpensNoFile}`);
    }
  }

  return lines;
}

/**
 * Runners that exist in configuration and serve no role.
 *
 * Information, never a failure: an operator may keep a runner configured for a
 * profile they switch to. What it is not is invisible, which is what it was.
 */
export function renderUnusedRunners(
  rows: readonly UnusedRunnerRow[],
  say: Phrases = en,
): string[] {
  if (rows.length === 0) return [];

  return [
    say.doctor.configuredAndUnrouted,
    ...rows.map((row) => `  ${row.id.padEnd(20)} ${row.type} — ${say.doctor.noRolePointsAtIt}`),
    `  ${say.doctor.pointARoleAtOne}`,
  ];
}
