import { describe, it, expect } from 'vitest';
import { runBranchFor, isRunOwnedBranch, refuseDestination } from '../../../src/core/forge/remote-ref.js';

/**
 * M7-ACC-08 and M7-ACC-09: the destination is derived, and the branches that matter are
 * refused by name.
 *
 * A push is the one Git command that can destroy work on a machine this process does not
 * own, so the destination is not something a caller passes — it is something this computes.
 */

const RUN = 'AF-2026-001';

describe('the branch a run owns', () => {
  it('is derived from the run id', () => {
    expect(runBranchFor(RUN)).toBe('agent-flow/AF-2026-001');
  });

  it('is the only branch that run owns', () => {
    expect(isRunOwnedBranch('agent-flow/AF-2026-001', RUN)).toBe(true);
    expect(isRunOwnedBranch('agent-flow/AF-2026-002', RUN)).toBe(false);
    expect(isRunOwnedBranch('feature/whatever', RUN)).toBe(false);
  });
});

describe('M7-ACC-08 — an integration branch is never a destination', () => {
  it.each(['main', 'master', 'trunk', 'develop', 'HEAD', 'MAIN'])('refuses %s', (branch) => {
    expect(refuseDestination(branch, RUN)).toMatch(/never publishes to one/);
  });
});

describe('what else it refuses', () => {
  it.each([
    ['a branch belonging to another run', 'agent-flow/AF-2026-002'],
    ['a branch a person named', 'feature/login'],
    ['empty', ''],
    ['padded', ' agent-flow/AF-2026-001 '],
  ])('refuses %s', (_why, branch) => {
    expect(refuseDestination(branch, RUN)).toBeDefined();
  });

  it.each([
    ['a leading dash, which Git would read as an option', '-delete'],
    ['a double dot, which is a range', 'agent-flow/a..b'],
    ['a reflog selector', 'agent-flow/x@{1}'],
    ['a colon, which is a refspec separator', 'agent-flow/a:b'],
    ['a glob', 'agent-flow/*'],
    ['a lock suffix', 'agent-flow/AF-2026-001.lock'],
    ['a newline', 'agent-flow/a\nb'],
  ])('refuses %s', (_why, branch) => {
    expect(refuseDestination(branch, RUN)).toBeDefined();
  });

  it('allows exactly the run-owned branch', () => {
    expect(refuseDestination('agent-flow/AF-2026-001', RUN)).toBeUndefined();
  });
});
