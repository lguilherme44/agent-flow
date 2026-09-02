import { describe, it, expect } from 'vitest';
import { hasReviewer, selectReviewer, REVIEW_SKILL } from '../../../src/core/review/reviewer.js';
import { deriveAgentRoster } from '../../../src/core/collaboration/roster.js';
import {
  GlobalConfigSchema,
  TaskSchema,
  type GlobalConfig,
  type Task,
} from '../../../src/contracts/index.js';

/**
 * Who reviews a change (M6-02, M6-ACC-01 … 03).
 *
 * **The property this file exists for is that authorship is a refusal, not a footnote.**
 * M5 already recorded independence as a field on the artifact, which described the
 * problem and prevented nothing: a single-provider setup could review its own work and
 * say so truthfully in a value nobody gated on. Here it is an exclusion in the same
 * policy that decides every other assignment — so a reviewer that wrote the code is
 * refused by the same code that refuses one which cannot run.
 */

const NOW = '2026-09-02T12:00:00.000Z';

const ROLES = {
  architect: { runner: 'claude', effort: 'high' },
  sdd: { runner: 'claude', effort: 'high' },
  planner: { runner: 'claude', effort: 'high' },
  planReviewer: { runner: 'claude', effort: 'high' },
  executors: {
    trivial: { runner: 'claude', effort: 'low' },
    normal: { runner: 'claude', effort: 'medium' },
    complex: { runner: 'claude', effort: 'high' },
  },
  verification: { runner: 'claude', effort: 'medium' },
  finalReviewer: { runner: 'claude', effort: 'high' },
};

function config(members?: Record<string, Record<string, unknown>>): GlobalConfig {
  return GlobalConfigSchema.parse({
    runners: { claude: { type: 'claude-code-cli' }, agy: { type: 'agy-cli' } },
    roles: ROLES,
    ...(members === undefined
      ? {}
      : {
          teams: {
            core: {
              members: Object.fromEntries(
                Object.entries(members).map(([id, member]) => [
                  id,
                  { roles: 'executor.normal', runner: 'claude', ...member },
                ]),
              ),
              policies: {},
            },
          },
        }),
  });
}

function task(): Task {
  return TaskSchema.parse({
    id: 'TASK-003',
    title: 'Wire the endpoint',
    description: 'Some work.',
    complexity: 'normal',
    risk: 'low',
    dependencies: [],
    requirements: ['FR-001'],
    files: { likely: ['src/server/a.ts'] },
    acceptanceCriteria: ['It compiles.'],
    validation: ['test'],
  });
}

function select(
  global: GlobalConfig,
  author = 'backend',
  inFlight: ReadonlyMap<string, number> = new Map(),
) {
  return selectReviewer({
    task: task(),
    author,
    config: global,
    roster: deriveAgentRoster(global),
    inFlight,
    canImplement: () => true,
    now: NOW,
  });
}

/** A member who reviews: the `finalReviewer` role plus the review skill. */
const REVIEWER = { roles: 'finalReviewer', skills: [REVIEW_SKILL] };

describe('whether anybody reviews is a fact the team already carries', () => {
  it('is nobody when no member declares the skill', () => {
    expect(hasReviewer(config({ backend: {} }))).toBe(false);
    expect(select(config({ backend: {} }))).toBeUndefined();
  });

  it('is nobody on a run with no team at all', () => {
    expect(hasReviewer(config())).toBe(false);
    expect(select(config())).toBeUndefined();
  });

  it('is somebody as soon as a member declares it', () => {
    expect(hasReviewer(config({ backend: {}, reviewer: REVIEWER }))).toBe(true);
  });
});

describe('M6-ACC-01 — implementation receives an independent reviewer', () => {
  it('chooses the member that reviews', () => {
    const selection = select(config({ backend: {}, reviewer: REVIEWER }));

    expect(selection?.reviewer).toBe('reviewer');
    expect(selection?.assignment.reason).toBe('team_match');
  });

  it('keeps the whole ranking, so “why this reviewer” is answerable', () => {
    const selection = select(
      config({ backend: {}, reviewer: REVIEWER, other: { roles: 'finalReviewer' } }),
    );

    expect(selection?.assignment.candidates.length).toBeGreaterThan(1);
  });
});

describe('M6-ACC-02 — the reviewer cannot be the author', () => {
  it('refuses the author outright, before any other filter', () => {
    // The author here is also the only member who reviews. Skill, capacity and ownership
    // all say yes; authorship says no, and no is the answer.
    const selection = select(
      config({ backend: { roles: 'finalReviewer', skills: [REVIEW_SKILL] } }),
      'backend',
    );

    expect(selection?.reviewer).toBeUndefined();
    const author = selection?.assignment.candidates.find((c) => c.agentId === 'backend');
    expect(author?.excludedBy).toBe('is_author');
  });

  it('names authorship rather than a reason a person could “fix”', () => {
    // Reporting `capacity` for an author would send somebody to raise a number.
    const selection = select(
      config({ backend: { roles: 'finalReviewer', skills: [REVIEW_SKILL] } }),
      'backend',
    );

    // Spelled out rather than pasted: the refusal is prose a person reads.
    expect(selection?.assignment.detail).toContain('1 is author');
    expect(selection?.assignment.detail).not.toContain('capacity');
  });

  it('still chooses somebody else when there is somebody else', () => {
    const selection = select(
      config({
        backend: { roles: 'finalReviewer', skills: [REVIEW_SKILL] },
        reviewer: REVIEWER,
      }),
      'backend',
    );

    expect(selection?.reviewer).toBe('reviewer');
  });
});

describe('M6-ACC-03 — provider independence is preferred, and degradation is recorded', () => {
  it('reports level 3 for a reviewer on another provider', () => {
    const selection = select(config({ backend: {}, reviewer: { ...REVIEWER, runner: 'agy' } }));

    expect(selection?.independence).toBe(3);
    expect(selection?.degraded).toBeUndefined();
  });

  it('reports level 2 for the same provider on another model', () => {
    const selection = select(
      config({
        backend: { model: 'a-model' },
        reviewer: { ...REVIEWER, model: 'another-model' },
      }),
    );

    expect(selection?.independence).toBe(2);
  });

  it('reports level 1 for the same provider and model', () => {
    expect(select(config({ backend: {}, reviewer: REVIEWER }))?.independence).toBe(1);
  });

  it('never reports level 0, because a review is always a fresh invocation', () => {
    for (const members of [
      { backend: {}, reviewer: REVIEWER },
      { backend: {}, reviewer: { ...REVIEWER, runner: 'agy' } },
    ]) {
      expect(select(config(members))?.independence).not.toBe(0);
    }
  });

  it('says so when the team had a cross-provider reviewer and this review did not get it', () => {
    // The degradation is a fact about this run, not a property of the product. Recording
    // it is what lets a reader weigh the verdict, which is why M5 made independence a
    // first-class field in the first place.
    // `remote` reviews on the other provider and is busy, so the review falls to the
    // same-provider member. That is a fact about this run, and the record says so.
    const selection = select(
      config({
        backend: {},
        reviewer: REVIEWER,
        remote: { ...REVIEWER, runner: 'agy', capacity: { maxConcurrentTasks: 1 } },
      }),
      'backend',
      new Map([['remote', 1]]),
    );

    expect(selection?.reviewer).toBe('reviewer');
    expect(selection?.independence).toBe(1);
    expect(selection?.degraded).toContain('same provider');
  });

  it('says nothing about degradation when the team has no better option', () => {
    expect(select(config({ backend: {}, reviewer: REVIEWER }))?.degraded).toBeUndefined();
  });
});

describe('when nobody can review', () => {
  it('answers with no reviewer rather than with the role', () => {
    // A review by a *role* has no identity to record and no independence to measure, so
    // it is not a review this milestone can promise anything about.
    const selection = select(
      config({ backend: { roles: 'finalReviewer', skills: [REVIEW_SKILL] } }),
      'backend',
    );

    expect(selection?.reviewer).toBeUndefined();
    expect(selection?.degraded).toBe('no configured member could review');
  });
});
