import { describe, it, expect } from 'vitest';
import { assessHealth, isUsable, referencedRunners } from '../../src/core/health.js';
import { GlobalConfigSchema } from '../../src/contracts/index.js';
import type { ObservedRunner } from '../../src/core/health.js';

const healthy = (id: string): ObservedRunner => ({
  id,
  installed: true,
  executable: true,
  auth: 'configured',
});

/** The real Codex failure: npm package present, native binary gone. */
const installedNotExecutable = (id: string): ObservedRunner => ({
  id,
  installed: true,
  executable: false,
  auth: 'unknown',
});

const notInstalled = (id: string): ObservedRunner => ({
  id,
  installed: false,
  executable: false,
  auth: 'unknown',
});

function config(options: { split?: boolean; fallback?: Record<string, string> } = {}) {
  const claude = { runner: 'claude', effort: 'high' };
  const codex = { runner: 'codex', effort: 'high' };
  const reviewer = options.split ? claude : claude;
  const planner = options.split ? codex : claude;

  return GlobalConfigSchema.parse({
    runners: { claude: { type: 'claude-code-cli' }, codex: { type: 'codex-cli' } },
    roles: {
      architect: claude,
      sdd: claude,
      planner,
      planReviewer: reviewer,
      executors: { trivial: planner, normal: planner, complex: planner },
      verification: planner,
      finalReviewer: reviewer,
    },
    ...(options.fallback
      ? {
          fallback: {
            enabled: true,
            roles: Object.fromEntries(
              Object.entries(options.fallback).map(([role, runner]) => [
                role,
                { runner, effort: 'high' },
              ]),
            ),
          },
        }
      : {}),
  });
}

describe('isUsable', () => {
  it('accepts a runner that is installed, executable and configured', () => {
    expect(isUsable(healthy('claude'))).toBe(true);
  });

  it('rejects a runner whose binary is missing even though it is installed', () => {
    expect(isUsable(installedNotExecutable('codex'))).toBe(false);
  });

  it('treats unverified auth as usable, since the shallow check does not probe', () => {
    // Probing auth costs quota on every doctor run (R-14). Treating "not
    // checked" as broken would make the default invocation useless.
    expect(isUsable({ ...healthy('claude'), auth: 'unknown' })).toBe(true);
  });

  it('rejects a runner known to have no credentials', () => {
    expect(isUsable({ ...healthy('claude'), auth: 'not_configured' })).toBe(false);
  });
});

describe('OK', () => {
  it('reports OK when every role runs on a healthy primary and two providers exist', () => {
    const verdict = assessHealth(config({ split: true }), [healthy('claude'), healthy('codex')]);

    expect(verdict.status).toBe('OK');
    expect(verdict.degradations).toEqual([]);
    expect(verdict.orphanRoles).toEqual([]);
  });

  it('does not treat a single configured runner as degraded', () => {
    // The shipped default enables one runner. A fresh install must not be told
    // its environment is degraded for following the defaults (C-4).
    const single = GlobalConfigSchema.parse({
      runners: { claude: { type: 'claude-code-cli' } },
      roles: {
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
        finalReviewer: { runner: 'claude', effort: 'very_high' },
      },
    });

    expect(assessHealth(single, [healthy('claude')]).status).toBe('OK');
  });
});

describe('DEGRADED — work is still possible, but something was lost', () => {
  it('degrades rather than fails when a fallback covers the broken runner', () => {
    // The change this whole model exists for: one broken CLI must not stop a
    // pipeline that can still run.
    const verdict = assessHealth(
      config({
        split: true,
        fallback: {
          planner: 'claude',
          verification: 'claude',
          'executor.trivial': 'claude',
          'executor.normal': 'claude',
          'executor.complex': 'claude',
        },
      }),
      [healthy('claude'), installedNotExecutable('codex')],
    );

    expect(verdict.status).toBe('DEGRADED');
    expect(verdict.orphanRoles).toEqual([]);
    expect(verdict.degradations.map((d) => d.kind)).toContain('runner_unavailable_with_fallback');
  });

  it('names the concrete substitution, not just "degraded"', () => {
    const verdict = assessHealth(
      config({ split: true, fallback: { planner: 'claude', verification: 'claude',
        'executor.trivial': 'claude', 'executor.normal': 'claude', 'executor.complex': 'claude' } }),
      [healthy('claude'), installedNotExecutable('codex')],
    );

    const degradation = verdict.degradations.find(
      (d) => d.kind === 'runner_unavailable_with_fallback',
    );
    expect(degradation?.reason).toContain('codex');
    expect(degradation?.impact).toContain('claude');
  });

  it('reports the loss of cross-provider review when only one provider survives', () => {
    // The degradation that actually costs something: §3.2 says cross-provider
    // review exists to stop one model confirming its own wrong hypothesis.
    const verdict = assessHealth(
      config({ split: true, fallback: { planner: 'claude', verification: 'claude',
        'executor.trivial': 'claude', 'executor.normal': 'claude', 'executor.complex': 'claude' } }),
      [healthy('claude'), installedNotExecutable('codex')],
    );

    const degradation = verdict.degradations.find((d) => d.kind === 'single_provider');
    expect(degradation).toBeDefined();
    expect(degradation?.impact).toMatch(/cross-provider/i);
    expect(degradation?.impact).toMatch(/same-provider/i);
  });

  it('routes the affected roles through the fallback', () => {
    const verdict = assessHealth(
      config({ split: true, fallback: { planner: 'claude', verification: 'claude',
        'executor.trivial': 'claude', 'executor.normal': 'claude', 'executor.complex': 'claude' } }),
      [healthy('claude'), installedNotExecutable('codex')],
    );

    const planner = verdict.routes.find((route) => route.role === 'planner');
    expect(planner?.effective).toBe('claude');
    expect(planner?.viaFallback).toBe(true);
  });

  it('does not degrade merely because auth was not probed', () => {
    // The shallow check never probes auth, so this holds on every healthy
    // machine. A DEGRADED that is always on is worth nothing — and diluting the
    // signal would recreate the very problem the ternary model exists to avoid.
    const verdict = assessHealth(config(), [
      { ...healthy('claude'), auth: 'unknown' },
      { ...healthy('codex'), auth: 'unknown' },
    ]);

    expect(verdict.status).toBe('OK');
    expect(verdict.degradations).toEqual([]);
  });

  it('still mentions unverified auth as a note', () => {
    const verdict = assessHealth(config(), [
      { ...healthy('claude'), auth: 'unknown' },
      { ...healthy('codex'), auth: 'unknown' },
    ]);

    expect(verdict.notes.join(' ')).toMatch(/not verified/i);
    expect(verdict.notes.join(' ')).toContain('claude');
  });

  it('reports no notes when authentication is known to be configured', () => {
    expect(assessHealth(config(), [healthy('claude'), healthy('codex')]).notes).toEqual([]);
  });
});

describe('FAIL — a role has nowhere to run', () => {
  it('fails when a broken runner has no fallback', () => {
    const verdict = assessHealth(config({ split: true }), [
      healthy('claude'),
      installedNotExecutable('codex'),
    ]);

    expect(verdict.status).toBe('FAIL');
    expect(verdict.orphanRoles).toContain('planner');
  });

  it('names every orphaned role', () => {
    const verdict = assessHealth(config({ split: true }), [
      healthy('claude'),
      notInstalled('codex'),
    ]);

    expect(verdict.orphanRoles).toEqual(
      expect.arrayContaining(['planner', 'verification', 'executor.normal']),
    );
  });

  it('fails when nothing is usable at all', () => {
    const verdict = assessHealth(config(), [notInstalled('claude'), notInstalled('codex')]);
    expect(verdict.status).toBe('FAIL');
  });

  it('does not use a fallback that is itself broken', () => {
    const verdict = assessHealth(
      config({ split: true, fallback: { planner: 'codex' } }),
      [healthy('claude'), notInstalled('codex')],
    );

    expect(verdict.status).toBe('FAIL');
    expect(verdict.orphanRoles).toContain('planner');
  });

  it('ignores fallback entirely when it is disabled', () => {
    const withDisabledFallback = GlobalConfigSchema.parse({
      ...config({ split: true }),
      fallback: { enabled: false, roles: { planner: { runner: 'claude', effort: 'high' } } },
    });

    const verdict = assessHealth(withDisabledFallback, [
      healthy('claude'),
      notInstalled('codex'),
    ]);
    expect(verdict.status).toBe('FAIL');
  });
});

describe('routes', () => {
  it('covers every workflow role', () => {
    const verdict = assessHealth(config(), [healthy('claude'), healthy('codex')]);
    expect(verdict.routes).toHaveLength(9);
  });
});

describe('referencedRunners', () => {
  it('lists runners named by roles and by fallbacks', () => {
    const runners = referencedRunners(config({ split: true, fallback: { planner: 'claude' } }));
    expect([...runners].sort()).toEqual(['claude', 'codex']);
  });
});
