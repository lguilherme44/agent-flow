import { describe, expect, it } from 'vitest';
import { latestGateDecision } from '../../src/server/run-reader.js';
import type { RunEvent } from '../../src/contracts/index.js';

/**
 * The run view's `gateDecision`: the latest approve, reject or revise and who decided it.
 * What it must never do is put a name beside a gate move that recorded none.
 */

function op(at: string, detail: Record<string, unknown>): RunEvent {
  return { at, type: 'operator_action', detail };
}

const LUIS = { by: 'Luis', words: 'Go.', channel: 'cli' };

describe('latestGateDecision', () => {
  it('reads the latest gate move, skipping actions that are not gate moves', () => {
    const events = [
      op('2026-10-07T10:00:00.000Z', { action: 'approve', actor: { kind: 'keyboard' }, decidedBy: LUIS }),
      op('2026-10-07T10:05:00.000Z', { action: 'start', actor: { kind: 'keyboard' } }),
      { at: '2026-10-07T10:06:00.000Z', type: 'run_started', detail: {} },
    ];

    expect(latestGateDecision(events)).toEqual({ action: 'approve', ...LUIS, at: '2026-10-07T10:00:00.000Z' });
  });

  it('answers nothing when the latest gate move recorded no decision, never an older one', () => {
    const events = [
      op('2026-10-07T10:00:00.000Z', { action: 'approve', actor: { kind: 'keyboard' }, decidedBy: LUIS }),
      // Written by a build before `decidedBy`, or by hand: no name on this move.
      op('2026-10-07T11:00:00.000Z', { action: 'reject', actor: { kind: 'keyboard' } }),
    ];

    expect(latestGateDecision(events)).toBeUndefined();
  });

  it('answers nothing for a decision that does not parse, or a run with no gate move', () => {
    expect(
      latestGateDecision([
        op('2026-10-07T10:00:00.000Z', { action: 'revise', decidedBy: { by: '', words: 'x', channel: 'cli' } }),
      ]),
    ).toBeUndefined();
    expect(
      latestGateDecision([op('2026-10-07T10:00:00.000Z', { action: 'start', actor: { kind: 'keyboard' } })]),
    ).toBeUndefined();
    expect(latestGateDecision([])).toBeUndefined();
  });
});
