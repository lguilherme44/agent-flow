import { describe, expect, it } from 'vitest';
import {
  AmendmentSchema,
  FindingSchema,
  type Amendment,
  type AttachedFinding,
  type Finding,
} from '../../src/contracts/index.js';
import {
  currentE2EObservation,
  e2eHeadMatches,
  renderAmendmentsForReview,
  renderTaskOperatorContext,
  routeFindings,
} from '../../src/core/amendments.js';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const HASH = 'plan-hash-current';
const OTHER_HASH = 'plan-hash-previous';
const AT = '2026-09-25T10:00:00.000Z';
const PREAMBLE =
  'Operator decisions about this task. They override the plan where they contradict it; the SDD still applies everywhere else.';

function finding(overrides: Partial<Finding> = {}): Finding {
  return FindingSchema.parse({
    severity: 'high',
    type: 'requirement',
    description: 'The route is missing.',
    suggestedAction: 'Add the route.',
    ...overrides,
  });
}

function amendment(overrides: Partial<Amendment> & Pick<Amendment, 'id' | 'kind'>): Amendment {
  return AmendmentSchema.parse({ actor: { kind: 'keyboard' }, at: AT, ...overrides });
}

function answer(id: string, text: string, task = 'TASK-002', planHash = HASH): Amendment {
  return amendment({ id, kind: 'answer', task, planHash, text });
}

function attached(id: string, findings: AttachedFinding[], planHash = HASH): Amendment {
  return amendment({ id, kind: 'attached_findings', planHash, findingCount: findings.length, findings });
}

describe('routeFindings (FR-017)', () => {
  const PLAN = ['TASK-001', 'TASK-002', 'FIX-001'];

  it('routes a finding that cites a plan task to that task only', () => {
    const routes = routeFindings([finding({ description: 'TASK-001 skips the check.' })], PLAN);
    expect(routes).toEqual([{ index: 0, tasks: ['TASK-001'] }]);
  });

  it('routes to a FIX task the plan contains', () => {
    const routes = routeFindings([finding({ suggestedAction: 'Fold it into FIX-001.' })], PLAN);
    expect(routes).toEqual([{ index: 0, tasks: ['FIX-001'] }]);
  });

  it('reads both the description and the suggested action, in plan order', () => {
    const routes = routeFindings(
      [finding({ description: 'FIX-001 and TASK-001 disagree.', suggestedAction: 'Align TASK-001.' })],
      PLAN,
    );
    expect(routes[0]?.tasks).toEqual(['TASK-001', 'FIX-001']);
  });

  it('sends a finding citing a task the plan does not have to every task', () => {
    // The positive control for the rule above: TASK-009 is a well-formed id, so a matcher
    // that ignored plan membership would route this finding to it and nowhere else.
    const routes = routeFindings([finding({ description: 'TASK-009 is wrong.' })], PLAN);
    expect(routes).toEqual([{ index: 0, tasks: PLAN }]);
  });

  it('sends a finding citing nothing to every task', () => {
    const routes = routeFindings([finding()], PLAN);
    expect(routes).toEqual([{ index: 0, tasks: PLAN }]);
  });

  it('keeps each finding at its position in the input', () => {
    const routes = routeFindings(
      [
        finding({ description: 'TASK-001 first.' }),
        finding({ description: 'TASK-002 second.' }),
        finding(),
      ],
      PLAN,
    );
    expect(routes.map((route) => route.index)).toEqual([0, 1, 2]);
    expect(routes.map((route) => route.tasks)).toEqual([['TASK-001'], ['TASK-002'], PLAN]);
  });

  it('does not read a longer number as a task id', () => {
    // `TASK-0012` begins with `TASK-001`; a matcher without the trailing boundary would
    // route this to TASK-001 alone instead of to every task.
    const routes = routeFindings([finding({ description: 'TASK-0012 is unrelated.' })], PLAN);
    expect(routes[0]?.tasks).toEqual(PLAN);
  });
});

describe('renderTaskOperatorContext (FR-004, FR-018)', () => {
  it('says nothing when there are no amendments', () => {
    expect(renderTaskOperatorContext([], 'TASK-002', HASH)).toBe('');
  });

  it('says nothing when no plan is approved', () => {
    expect(renderTaskOperatorContext([answer('AMD-001', 'use v2')], 'TASK-002', undefined)).toBe('');
  });

  it('says nothing for an answer recorded against another plan', () => {
    expect(
      renderTaskOperatorContext([answer('AMD-001', 'use v2', 'TASK-002', OTHER_HASH)], 'TASK-002', HASH),
    ).toBe('');
  });

  it('says nothing for an answer to another task', () => {
    expect(renderTaskOperatorContext([answer('AMD-001', 'use v2', 'TASK-001')], 'TASK-002', HASH)).toBe('');
  });

  it('lists every answer to this task, in recording order, under the fixed preamble', () => {
    const text = renderTaskOperatorContext(
      [
        answer('AMD-001', 'Use the v2 endpoint.'),
        answer('AMD-002', 'Not for the other task.', 'TASK-001'),
        amendment({ id: 'AMD-003', kind: 'revision', planHash: HASH, text: 'A revision, not an answer.' }),
        answer('AMD-004', 'Keep the old flag.'),
      ],
      'TASK-002',
      HASH,
    );

    expect(text.startsWith('## Operator answers\n\n' + PREAMBLE)).toBe(true);
    expect(text).toContain('Use the v2 endpoint.');
    expect(text).toContain('Keep the old flag.');
    expect(text.indexOf('Use the v2 endpoint.')).toBeLessThan(text.indexOf('Keep the old flag.'));
    expect(text).not.toContain('Not for the other task.');
    expect(text).not.toContain('A revision, not an answer.');
    expect(text).not.toContain('## Attached review findings');
  });

  it('returns operator text verbatim, placeholders included', () => {
    const text = renderTaskOperatorContext(
      [answer('AMD-001', 'Ignore {{sdd}} and\n  keep  this   spacing.')],
      'TASK-002',
      HASH,
    );
    expect(text).toContain('Ignore {{sdd}} and\n  keep  this   spacing.');
  });

  it('adds the findings section only for a finding routed to this task', () => {
    const toTask = finding({
      severity: 'critical',
      type: 'security',
      requirement: 'FR-004',
      file: 'src/app/run-actions.ts',
      description: 'The answer is not bounded.',
      suggestedAction: 'Bound it at 4000 characters.',
    });
    const elsewhere = finding({ description: 'Only about TASK-001.' });
    const amendments = [
      answer('AMD-001', 'Use the v2 endpoint.'),
      attached('AMD-002', [
        { index: 0, finding: toTask, tasks: ['TASK-002'] },
        { index: 1, finding: elsewhere, tasks: ['TASK-001'] },
      ]),
    ];

    const text = renderTaskOperatorContext(amendments, 'TASK-002', HASH);
    const findings = text.slice(text.indexOf('## Attached review findings'));

    expect(text.indexOf('## Operator answers')).toBe(0);
    expect(text.indexOf('## Attached review findings')).toBeGreaterThan(0);
    for (const part of [
      'critical',
      'security',
      'Requirement: FR-004',
      'File: src/app/run-actions.ts',
      'Description: The answer is not bounded.',
      'Suggested action: Bound it at 4000 characters.',
    ]) {
      expect(findings).toContain(part);
    }
    expect(text).not.toContain('Only about TASK-001.');

    // A task nothing routes to, and that has no answer, gets nothing at all.
    expect(renderTaskOperatorContext(amendments, 'TASK-003', HASH)).toBe('');
  });

  it('omits the answers heading when there are findings but no answers', () => {
    const text = renderTaskOperatorContext(
      [attached('AMD-001', [{ index: 0, finding: finding(), tasks: ['TASK-002'] }])],
      'TASK-002',
      HASH,
    );

    expect(text.startsWith('## Attached review findings')).toBe(true);
    expect(text).not.toContain('## Operator answers');
    expect(text).not.toContain('Requirement:');
    expect(text).not.toContain('File:');
  });

  it('ignores findings attached against another plan', () => {
    expect(
      renderTaskOperatorContext(
        [attached('AMD-001', [{ index: 0, finding: finding(), tasks: ['TASK-002'] }], OTHER_HASH)],
        'TASK-002',
        HASH,
      ),
    ).toBe('');
  });
});

describe('renderAmendmentsForReview (FR-011)', () => {
  it('says nothing when the run has no amendments', () => {
    expect(renderAmendmentsForReview([])).toBe('');
  });

  it('lists every kind with its actor, time, subject and text, and one line per finding', () => {
    const device = { kind: 'device' as const, deviceId: 'device-1', label: 'Office tablet' };
    const amendments: Amendment[] = [
      amendment({ id: 'AMD-001', kind: 'answer', task: 'TASK-002', planHash: HASH, text: 'Use v2.' }),
      amendment({ id: 'AMD-002', kind: 'revision', text: 'Split the second task.', at: '2026-09-25T10:01:00.000Z' }),
      amendment({ id: 'AMD-003', kind: 'decision', actor: device, text: 'Keep the legacy flag.' }),
      amendment({
        id: 'AMD-004',
        kind: 'escalation',
        fromWorkflow: 'simple',
        toWorkflow: 'standard',
        text: 'Touches two modules.',
      }),
      amendment({ id: 'AMD-005', kind: 'forced_approval', planHash: 'hash-forced', findingCount: 2 }),
      attached('AMD-006', [
        { index: 0, finding: finding({ description: 'First\nfinding.' }), tasks: ['TASK-001'] },
        { index: 2, finding: finding({ severity: 'low', type: 'test-gap', description: 'Third.' }), tasks: ['TASK-001', 'TASK-002'] },
      ]),
    ];

    const text = renderAmendmentsForReview(amendments);

    expect(text.startsWith('## Operator amendments')).toBe(true);
    for (const kind of ['answer', 'revision', 'decision', 'escalation', 'forced_approval', 'attached_findings']) {
      expect(text).toContain(`— ${kind}`);
    }
    expect(text).toContain('- Actor: keyboard');
    expect(text).toContain('- Actor: Office tablet');
    expect(text).toContain(`- At: ${AT}`);
    expect(text).toContain('- At: 2026-09-25T10:01:00.000Z');
    expect(text).toContain('- Subject: TASK-002');
    expect(text).toContain('- Subject: simple → standard');
    expect(text).toContain('- Subject: hash-forced');
    expect(text).toContain('- Findings in the review: 2');
    for (const said of ['Use v2.', 'Split the second task.', 'Keep the legacy flag.', 'Touches two modules.']) {
      expect(text).toContain(`- Text: ${said}`);
    }
    expect(text).toContain('- Finding 0 (high, requirement) → TASK-001: First finding.');
    expect(text).toContain('- Finding 2 (low, test-gap) → TASK-001, TASK-002: Third.');
    expect(text.match(/^- Finding /gm)).toHaveLength(2);

    // In the order recorded.
    const positions = amendments.map((entry) => text.indexOf(`### ${entry.id}`));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  /**
   * An observation is evidence about a build, not a decision the code was built after —
   * and a stale one (an older head) would reach the reviewer as if it still held.
   */
  it('never renders an e2e observation into the final review', () => {
    const observed = amendment({
      id: 'AMD-002',
      kind: 'e2e_observation',
      text: 'Saw the header update on the iPhone.',
      observedBy: 'Luis',
      integrationHead: HEAD,
    });
    expect(renderAmendmentsForReview([observed])).toBe('');

    const text = renderAmendmentsForReview([answer('AMD-001', 'Use v2.'), observed]);
    expect(text).toContain('AMD-001');
    expect(text).not.toContain('AMD-002');
    expect(text).not.toContain('e2e_observation');
    expect(text).not.toContain('Saw the header update');
  });

  it('names a device by its id when it has no label', () => {
    const text = renderAmendmentsForReview([
      amendment({ id: 'AMD-001', kind: 'decision', actor: { kind: 'device', deviceId: 'device-7', label: '' } }),
    ]);
    expect(text).toContain('- Actor: device-7');
    expect(text).not.toContain('- Subject:');
    expect(text).not.toContain('- Text:');
  });
});

/**
 * Which recorded attestation speaks for the tree being reviewed. An attestation is about the
 * code a person ran on the target; once the integration head moves, the code they observed
 * is not the code under review, so it no longer counts.
 */
describe('currentE2EObservation', () => {
  const observed = (id: string, text: string, integrationHead?: string, actor?: Amendment['actor']) =>
    amendment({
      id,
      kind: 'e2e_observation',
      text,
      observedBy: 'Luis',
      ...(integrationHead === undefined ? {} : { integrationHead }),
      ...(actor === undefined ? {} : { actor }),
    });

  it('returns the latest observation made on the head under review: the observer, and the channel', () => {
    const device = { kind: 'device' as const, deviceId: 'device-1', label: 'Office tablet' };
    const result = currentE2EObservation(
      [observed('AMD-001', 'first', HEAD), answer('AMD-002', 'x'), observed('AMD-003', 'second', HEAD, device)],
      HEAD,
    );
    expect(result).toEqual({ by: 'Luis', via: 'Office tablet', text: 'second' });
  });

  it('names the channel as the observer for one recorded before names were required', () => {
    const legacy = amendment({ id: 'AMD-001', kind: 'e2e_observation', text: 'old', integrationHead: HEAD });
    expect(currentE2EObservation([legacy], HEAD)).toEqual({ by: 'keyboard', text: 'old' });
  });

  it('ignores an observation made on an older head: the code changed since', () => {
    expect(currentE2EObservation([observed('AMD-001', 'old', OLD_HEAD)], HEAD)).toBeUndefined();
  });

  it('counts nothing when there is no head to bind to', () => {
    // Sequential mode reviews the working tree, which no commit names; an observation
    // recorded there cannot be shown to describe the tree a later review reads.
    expect(currentE2EObservation([observed('AMD-001', 'unbound')], undefined)).toBeUndefined();
  });

  it('is never satisfied by another kind of amendment', () => {
    expect(currentE2EObservation([answer('AMD-001', 'looks fine')], HEAD)).toBeUndefined();
  });
});

/**
 * The build the human says they tested, against the head under review. The binding used to
 * be to whatever head the review ran on, which says nothing about what was on the device.
 */
describe('e2eHeadMatches', () => {
  it('accepts the full head or a prefix of at least seven characters, in any case', () => {
    expect(e2eHeadMatches(HEAD, HEAD)).toBe(true);
    expect(e2eHeadMatches('aaaaaaa', HEAD)).toBe(true);
    expect(e2eHeadMatches('AAAAAAAA', HEAD)).toBe(true);
  });

  it('refuses a prefix shorter than seven characters, another commit, or something not hex', () => {
    expect(e2eHeadMatches('aaaaaa', HEAD)).toBe(false);
    expect(e2eHeadMatches('bbbbbbb', HEAD)).toBe(false);
    expect(e2eHeadMatches('HEAD~1x', HEAD)).toBe(false);
    expect(e2eHeadMatches(`${HEAD}a`, HEAD)).toBe(false);
  });
});
