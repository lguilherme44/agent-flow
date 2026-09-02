import { describe, it, expect } from 'vitest';
import {
  patternCovers,
  verdictFor,
  ownershipScore,
  exclusiveContention,
} from '../../../src/core/team/ownership.js';
import { OwnershipRuleSchema, type OwnershipRule } from '../../../src/contracts/index.js';

/**
 * Who is expected to touch what (M5-06, I-37).
 *
 * Two properties are worth more than the rest of this file. The first is that matching is
 * **segment-aware**: `src/auth` must not own `src/authz.ts`, because that file is somebody
 * else's and a prefix comparison would hand it over. The second is that an unmatchable
 * path owns **nothing** — the fail-closed direction, and the one a traversal attempt
 * would try to invert.
 */

function rule(overrides: Partial<OwnershipRule> = {}): OwnershipRule {
  return OwnershipRuleSchema.parse(overrides);
}

describe('patternCovers', () => {
  it('covers everything under an explicit /**', () => {
    expect(patternCovers('src/server/**', 'src/server/routes/run.ts')).toBe(true);
  });

  it('covers the directory itself, not only what is under it', () => {
    // `src/server/**` reading as "under src/server but not src/server" would leave the
    // directory's own files owned by nobody, which is never what an operator meant.
    expect(patternCovers('src/server/**', 'src/server/index.ts')).toBe(true);
  });

  it('treats a bare directory as that directory and everything under it', () => {
    // Otherwise every ownership map is a wall of `/**` and the one somebody forgot to
    // write owns exactly nothing, silently.
    expect(patternCovers('src/server', 'src/server/routes/run.ts')).toBe(true);
  });

  it('does not let a directory own a sibling that merely starts the same way', () => {
    // The property. `src/auth` and `src/authz.ts` are two people's work.
    expect(patternCovers('src/auth', 'src/authz.ts')).toBe(false);
    expect(patternCovers('src/auth/**', 'src/authz.ts')).toBe(false);
  });

  it('keeps a single star inside one segment', () => {
    expect(patternCovers('src/*.ts', 'src/a.ts')).toBe(true);
    expect(patternCovers('src/*.ts', 'src/deep/a.ts')).toBe(false);
  });

  it('matches a star inside a name without spilling across a separator', () => {
    expect(patternCovers('docs/run-*.md', 'docs/run-01.md')).toBe(true);
    expect(patternCovers('docs/run-*.md', 'docs/run/01.md')).toBe(false);
  });

  it('does not let a pattern smuggle a regular expression through a path', () => {
    // `.` and `+` are escaped, so `a.ts` is a literal and not "any character then ts".
    expect(patternCovers('src/a.ts', 'src/axts')).toBe(false);
  });

  it('owns nothing when the path is one the repository rejects', () => {
    // Delegated to `validateAndNormalizeRepositoryPath`, and fail-closed: an ownership
    // rule that matched a traversal would be a policy file granting reach outside the
    // workspace.
    for (const path of ['../outside.ts', '/etc/passwd', 'src/%2e%2e/a.ts', '.git/config']) {
      expect(patternCovers('**', path), path).toBe(false);
    }
  });
});

describe('verdictFor', () => {
  const mixed = rule({
    exclusive: ['src/db/**'],
    preferred: ['src/server/**'],
    shared: ['docs/**'],
  });

  it('reports the mode the rule declared', () => {
    expect(verdictFor(mixed, 'src/db/schema.ts')).toBe('exclusive');
    expect(verdictFor(mixed, 'src/server/routes.ts')).toBe('preferred');
    expect(verdictFor(mixed, 'docs/readme.md')).toBe('shared');
  });

  it('says none for a file nobody mentioned, which is most files', () => {
    expect(verdictFor(mixed, 'src/core/router.ts')).toBe('none');
  });

  it('reports the most constraining mode when two patterns both cover a path', () => {
    // An overlap is an operator's mistake, and the safe reading of a mistake about
    // exclusivity is the exclusive one.
    const overlapping = rule({ exclusive: ['src/**'], preferred: ['src/server/**'] });
    expect(verdictFor(overlapping, 'src/server/routes.ts')).toBe('exclusive');
  });
});

describe('ownershipScore', () => {
  const owner = rule({ preferred: ['src/server/**'] });

  it('scores a member that owns every declared file at 1', () => {
    expect(ownershipScore({ rule: owner, files: ['src/server/a.ts', 'src/server/b.ts'] })).toBe(1);
  });

  it('scores the fraction when a task spans two areas', () => {
    // Neither owner wins by accident, which is the point of a fraction over a boolean.
    expect(ownershipScore({ rule: owner, files: ['src/server/a.ts', 'apps/web/b.vue'] })).toBe(0.5);
  });

  it('counts exclusive as owned, since it is the stronger claim', () => {
    const exclusive = rule({ exclusive: ['src/db/**'] });
    expect(ownershipScore({ rule: exclusive, files: ['src/db/schema.ts'] })).toBe(1);
  });

  it('does not count shared, which says explicitly that anyone may', () => {
    const shared = rule({ shared: ['docs/**'] });
    expect(ownershipScore({ rule: shared, files: ['docs/readme.md'] })).toBe(0);
  });

  it('scores a task that declares no files at 0 for everybody', () => {
    // A constant across candidates changes no ranking. Scoring it 1 would turn every
    // ownerless task into a tie the tie-break has to settle.
    expect(ownershipScore({ rule: owner, files: [] })).toBe(0);
  });
});

describe('exclusiveContention', () => {
  const rules = [rule({ exclusive: ['src/db/**'] })];

  it('names the area two tasks both write into', () => {
    expect(exclusiveContention(rules, ['src/db/a.ts'], ['src/db/b.ts'])).toEqual(['src/db/**']);
  });

  it('catches a directory two different files sit under, which overlap cannot', () => {
    // The reason this exists beside `core/file-overlap.ts`: those two tasks name no file
    // in common, so overlap sees nothing, and somebody said this area takes one writer.
    expect(exclusiveContention(rules, ['src/db/schema.ts'], ['src/db/migrations/001.sql'])).toEqual([
      'src/db/**',
    ]);
  });

  it('is silent when only one of the two touches the area', () => {
    expect(exclusiveContention(rules, ['src/db/a.ts'], ['src/core/b.ts'])).toEqual([]);
  });

  it('is silent about an area declared preferred rather than exclusive', () => {
    // Preferred ranks; it does not narrow a wave. A preference with teeth would be an
    // exclusive claim an operator did not know they were making.
    const preferred = [rule({ preferred: ['src/db/**'] })];
    expect(exclusiveContention(preferred, ['src/db/a.ts'], ['src/db/b.ts'])).toEqual([]);
  });

  it('is deterministic and sorted', () => {
    const many = [rule({ exclusive: ['src/z/**', 'src/a/**'] })];
    expect(exclusiveContention(many, ['src/z/1.ts', 'src/a/1.ts'], ['src/a/2.ts', 'src/z/2.ts'])).toEqual([
      'src/a/**',
      'src/z/**',
    ]);
  });
});
