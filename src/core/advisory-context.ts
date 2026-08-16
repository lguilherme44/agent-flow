import {
  type ContextPacket,
  validateAndNormalizeRepositoryPath,
} from '../contracts/context-packet.schema.js';

/** The rendering of a validated packet, ready to append to a runner prompt. */
export interface RenderedAdvisory {
  readonly text: string;
  /** Character count of `text`, for telemetry. */
  readonly charCount: number;
}

/**
 * Renders a validated ContextPacket as an *advisory* block appended to the
 * primary runner's prompt (spec §18, §14.3).
 *
 * The block is framed as advisory and never as authority: the packet is a
 * selection/compression layer, while raw files, diffs and logs remain the
 * source of truth. It deliberately contains no claims of completion, validity
 * or pass/fail — those belong to agent-flow, never to the local model.
 *
 * Fail-closed by design: if any path in the packet is not a valid
 * repository-relative path, nothing is rendered. A packet whose paths could
 * cross the trust boundary must not reach a runner prompt at all — silently
 * rendering "ze most trusted nine files" from three invented paths would be
 * worse than rendering nothing.
 */
export function renderAdvisoryContext(
  packet: ContextPacket,
): RenderedAdvisory | undefined {
  const paths = [
    ...packet.relevantFiles.map((f) => f.path),
    ...packet.relevantSymbols.map((s) => s.path),
  ];

  for (const path of paths) {
    if (!validateAndNormalizeRepositoryPath(path).valid) return undefined;
  }

  const lines: string[] = [
    '---',
    '[ADVISORY CONTEXT]',
    'The block below was produced by a local utility model. It may contain errors',
    'and is NOT authoritative. Raw sources (files, diffs, logs) remain the source of',
    'truth — verify anything that matters against them. Nothing here was validated',
    'by agent-flow, and no decision about completion, validity or merge was made.',
    '',
  ];

  lines.push(`Objective: ${packet.objective ?? ''}`);
  lines.push('');

  if (packet.relevantFiles.length === 0) {
    lines.push('Relevant paths: none');
  } else {
    lines.push('Relevant paths:');
    for (const file of packet.relevantFiles) {
      lines.push(`  - ${file.path}${file.reason ? ` — ${file.reason}` : ''}`);
    }
  }
  lines.push('');

  if (packet.relevantSymbols.length > 0) {
    lines.push('Relevant symbols:');
    for (const symbol of packet.relevantSymbols) {
      lines.push(
        `  - ${symbol.symbol} (${symbol.path})${symbol.reason ? ` — ${symbol.reason}` : ''}`,
      );
    }
    lines.push('');
  }

  lines.push(`Constraints: ${packet.constraints.length === 0 ? 'none' : ''}`);
  for (const constraint of packet.constraints) {
    lines.push(`  - ${constraint}`);
  }
  lines.push('');

  if (packet.architectureNotes.length > 0) {
    lines.push('Architecture notes:');
    for (const note of packet.architectureNotes) {
      lines.push(`  - ${note}`);
    }
    lines.push('');
  }

  if (packet.risks.length > 0) {
    lines.push('Risks:');
    for (const risk of packet.risks) {
      lines.push(`  - ${risk}`);
    }
    lines.push('');
  }

  if (packet.evidence.length > 0) {
    lines.push('Evidence references (raw sources, not summaries):');
    for (const ref of packet.evidence) {
      lines.push(`  - ${ref.kind}: ${ref.id}`);
    }
    lines.push('');
  }

  lines.push('---');

  const text = lines.join('\n');
  return { text, charCount: text.length };
}