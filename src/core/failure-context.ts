import type { FailureClass, RunnerErrorCode } from '../contracts/index.js';

/**
 * What a retry is told about the attempt before it (AD-40).
 *
 * `requeue` used to write `state: 'queued'` and nothing else, so the next attempt re-read
 * the same task description that had already failed once. The system held the failing
 * command, its exit code, its stderr, the previous diff and the acceptance criteria — and
 * asked the operator to explain the failure to the next attempt by hand.
 *
 * **Assembled by pure code from persisted artifacts.** `correctiveObjective` may be
 * phrased by a model; no other field may be, and a model's phrasing may not alter one.
 * The packet is appended to the implementation prompt exactly as MVP 3's advisory context
 * is — additive, never replacing what was rendered — and it carries **no patch**: handing
 * over the previous diff would make a rejected attempt a starting point and erode the
 * isolation that makes a validated tree mean anything. `--stat` conveys shape without
 * conveying content.
 */

export interface CommandSummary {
  readonly command: string;
  readonly exitCode: number;
  /** The end of the output, where a test runner puts its summary. */
  readonly tail: string;
}

export interface FailureContextPacket {
  readonly previousAttempt: number;
  readonly failureClass: FailureClass;
  readonly runnerErrorCode?: RunnerErrorCode;
  readonly rawExcerpt?: string;
  readonly failedChecks: readonly CommandSummary[];
  /** Ids only. What passed is context; what failed is the work. */
  readonly successfulChecks: readonly string[];
  readonly previousDiffStat?: string;
  readonly acceptanceCriteria: readonly string[];
  readonly correctiveObjective: string;
  readonly environmentRepairs: readonly string[];
  /**
   * Which optional fields the budget removed, in the order it removed them.
   *
   * §6.5: a budget is never applied silently. A reader seeing this list knows exactly
   * what is missing and why, rather than wondering whether the previous attempt simply
   * had no diff.
   */
  readonly truncated: readonly ('previousDiffStat' | 'successfulChecks' | 'rawExcerpt')[];
}

export interface PacketBudgets {
  readonly maxPacketBytes: number;
  readonly maxRawExcerptBytes: number;
  readonly maxDiffStatLines: number;
}

export interface FailureContextInput {
  readonly previousAttempt: number;
  readonly failureClass: FailureClass;
  readonly runnerErrorCode?: RunnerErrorCode;
  /** Already redacted by the boundary that persisted it (AD-35). */
  readonly rawExcerpt?: string;
  readonly failedChecks?: readonly CommandSummary[];
  readonly successfulChecks?: readonly string[];
  readonly previousDiffStat?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly correctiveObjective: string;
  readonly environmentRepairs?: readonly string[];
  readonly budgets: PacketBudgets;
}

/**
 * The packet, inside its budget (§6.5).
 *
 * **Truncation order is fixed and reverse-priority**: `previousDiffStat`, then
 * `successfulChecks`, then `rawExcerpt`. `failureClass`, `failedChecks` and
 * `acceptanceCriteria` are never touched — they are the evidence the retry exists to act
 * on, and a budget that ate them would leave a packet that says nothing.
 *
 * The budget is conservative because recovery context lands on a prompt that is already
 * large: a trivial call in the evidence environment reported ≈49 k input tokens before
 * Agent Flow contributed anything.
 */
export function buildFailureContextPacket(input: FailureContextInput): FailureContextPacket {
  const truncated: FailureContextPacket['truncated'][number][] = [];

  let packet: FailureContextPacket = {
    previousAttempt: input.previousAttempt,
    failureClass: input.failureClass,
    ...(input.runnerErrorCode === undefined ? {} : { runnerErrorCode: input.runnerErrorCode }),
    ...(input.rawExcerpt === undefined
      ? {}
      : { rawExcerpt: byBytes(input.rawExcerpt, input.budgets.maxRawExcerptBytes) }),
    failedChecks: input.failedChecks ?? [],
    successfulChecks: input.successfulChecks ?? [],
    ...(input.previousDiffStat === undefined
      ? {}
      : { previousDiffStat: byLines(input.previousDiffStat, input.budgets.maxDiffStatLines) }),
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    correctiveObjective: input.correctiveObjective,
    environmentRepairs: input.environmentRepairs ?? [],
    truncated: [],
  };

  // Dropped whole rather than shortened. A half a diff stat is not more useful than none,
  // and "this was omitted" is a statement a reader can act on where "this was cut off
  // somewhere" is not.
  const drops: {
    field: FailureContextPacket['truncated'][number];
    without: (p: FailureContextPacket) => FailureContextPacket;
  }[] = [
    {
      field: 'previousDiffStat',
      without: ({ previousDiffStat: _dropped, ...rest }) => rest,
    },
    { field: 'successfulChecks', without: (p) => ({ ...p, successfulChecks: [] }) },
    { field: 'rawExcerpt', without: ({ rawExcerpt: _dropped, ...rest }) => rest },
  ];

  for (const { field, without } of drops) {
    if (sizeOf({ ...packet, truncated }) <= input.budgets.maxPacketBytes) break;
    if (packet[field] === undefined) continue;

    packet = without(packet);
    truncated.push(field);
  }

  return { ...packet, truncated };
}

/**
 * The packet as a prompt block.
 *
 * Plain text rather than JSON, because it is read by a model *and* by whoever is looking
 * at the attempt log to find out what the retry was told. One rendering, both audiences.
 */
export function renderFailureContext(packet: FailureContextPacket): string {
  const lines: string[] = [
    '## Previous attempt',
    '',
    `Attempt ${String(packet.previousAttempt)} of this task failed: ${packet.failureClass}.`,
    '',
    `Objective for this attempt: ${packet.correctiveObjective}`,
  ];

  if (packet.failedChecks.length > 0) {
    lines.push('', 'What failed:');
    for (const check of packet.failedChecks) {
      lines.push(`- \`${check.command}\` exited ${String(check.exitCode)}`);
      if (check.tail.length > 0) lines.push('  ```', ...indent(check.tail), '  ```');
    }
  }

  if (packet.successfulChecks.length > 0) {
    lines.push('', `What already passed: ${packet.successfulChecks.join(', ')}`);
  }

  if (packet.acceptanceCriteria.length > 0) {
    lines.push('', 'This task is judged done by:');
    for (const criterion of packet.acceptanceCriteria) lines.push(`- ${criterion}`);
  }

  if (packet.previousDiffStat !== undefined) {
    lines.push(
      '',
      'The previous attempt changed (shape only — its code is not available to you,',
      'and you are starting from the integration head, not from its tree):',
      '```',
      packet.previousDiffStat,
      '```',
    );
  }

  if (packet.rawExcerpt !== undefined) {
    lines.push('', 'Runner output from that attempt:', '```', packet.rawExcerpt, '```');
  }

  if (packet.environmentRepairs.length > 0) {
    lines.push('', `Environment repairs already tried: ${packet.environmentRepairs.join(', ')}`);
  }

  if (packet.truncated.length > 0) {
    // Never silently. A reader has to be able to tell "there was no diff" from "the diff
    // did not fit".
    lines.push(
      '',
      `(Omitted to stay inside the context budget: ${packet.truncated.join(', ')}.)`,
    );
  }

  return lines.join('\n');
}

function indent(text: string): string[] {
  return text.split('\n').map((line) => `  ${line}`);
}

function sizeOf(packet: FailureContextPacket): number {
  return new TextEncoder().encode(JSON.stringify(packet)).length;
}

function byBytes(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) return text;

  const marker = '\n… [truncated]';
  const room = Math.max(0, maxBytes - new TextEncoder().encode(marker).length);
  return `${new TextDecoder('utf-8').decode(encoded.slice(0, room)).replace(/�$/, '')}${marker}`;
}

function byLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;

  return [...lines.slice(0, maxLines), `… [${String(lines.length - maxLines)} more lines]`].join('\n');
}
