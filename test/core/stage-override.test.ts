import { describe, it, expect } from 'vitest';
import { GlobalConfigSchema, roleConfigForStage, roleConfigOf } from '../../src/contracts/index.js';

/**
 * One role, stages with different needs.
 *
 * `architect` serves `discovery`, which reads the repository, and
 * `architecture-impact`, which reads nothing. Runner is chosen per role, so the
 * first forced the second onto a coding CLI — measured on one run, 22 kB of
 * context through a frontier CLI that an inference endpoint would have absorbed
 * at no quota cost.
 */
const config = (architect: Record<string, unknown>) =>
  GlobalConfigSchema.parse({
    runners: { claude: { type: 'claude-code-cli' }, local: { type: 'openai-compatible', baseUrl: 'http://x/v1' } },
    roles: {
      architect: { runner: 'claude', effort: 'high', timeoutSeconds: 900, ...architect },
      sdd: { runner: 'claude', effort: 'high' },
      planner: { runner: 'claude', effort: 'high' },
      planReviewer: { runner: 'claude', effort: 'high' },
      executors: {
        trivial: { runner: 'claude', effort: 'low' },
        normal: { runner: 'claude', effort: 'high' },
        complex: { runner: 'claude', effort: 'high' },
      },
      verification: { runner: 'claude', effort: 'medium' },
      finalReviewer: { runner: 'claude', effort: 'high' },
    },
  }).roles;

describe('a stage may be routed away from the runner its role uses', () => {
  it('sends the named stage elsewhere', () => {
    const roles = config({ stages: { 'architecture-impact': { runner: 'local' } } });
    expect(roleConfigForStage(roles, 'architect', 'architecture-impact').runner).toBe('local');
  });

  it('leaves the sibling stage on the role runner', () => {
    const roles = config({ stages: { 'architecture-impact': { runner: 'local' } } });
    expect(roleConfigForStage(roles, 'architect', 'discovery').runner).toBe('claude');
  });

  it('merges rather than replaces — an override naming only the runner keeps the rest', () => {
    // The case an operator actually writes: moving one stage to a cheaper runner,
    // not re-describing the role.
    const roles = config({ stages: { 'architecture-impact': { runner: 'local' } } });
    const resolved = roleConfigForStage(roles, 'architect', 'architecture-impact');
    expect(resolved.effort).toBe('high');
    expect(resolved.timeoutSeconds).toBe(900);
  });

  it('can override effort and timeout too', () => {
    const roles = config({
      stages: { 'architecture-impact': { effort: 'low', timeoutSeconds: 2700 } },
    });
    const resolved = roleConfigForStage(roles, 'architect', 'architecture-impact');
    expect(resolved.effort).toBe('low');
    expect(resolved.timeoutSeconds).toBe(2700);
    expect(resolved.runner).toBe('claude');
  });

  it('resolves identically to the role when no override exists', () => {
    const roles = config({});
    expect(roleConfigForStage(roles, 'architect', 'discovery')).toEqual(
      roleConfigOf(roles, 'architect'),
    );
  });

  it('ignores an override for a stage that is not running', () => {
    const roles = config({ stages: { sdd: { runner: 'local' } } });
    // `sdd` is served by its own role; naming it under `architect` changes nothing
    // for architect's stages.
    expect(roleConfigForStage(roles, 'architect', 'discovery').runner).toBe('claude');
  });
});
