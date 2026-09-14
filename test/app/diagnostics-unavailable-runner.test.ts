import { describe, it, expect } from 'vitest';
import { generateRemediations } from '../../src/app/diagnostics.js';
import { classifyUnavailability } from '../../src/core/health.js';
import { phrasesFor } from '../../src/core/phrases/index.js';
import { GlobalConfigSchema } from '../../src/contracts/index.js';
import type { ObservedRunnerReport } from '../../src/app/diagnostics.js';

/**
 * A runner configuration refuses is not a runner that is missing.
 *
 * Reported from a real machine: every planning and review role failed, `doctor` printed
 * `installed ✗ / executable ✗` and told the operator to run
 * `npm install -g @anthropic-ai/claude-code`. The CLI was installed and on PATH — the
 * global config had `enabled: false`, so the registry never built the runner and nothing
 * was ever spawned. The install succeeded and the report did not move, which is the
 * expensive shape of a wrong diagnosis: it is followed, it works, and it changes nothing.
 */

const say = phrasesFor('en');

const configWith = (
  claude: boolean | 'absent',
): ReturnType<typeof GlobalConfigSchema.parse> =>
  GlobalConfigSchema.parse({
    runners: {
      ...(claude === 'absent' ? {} : { claude: { type: 'claude-code-cli', enabled: claude } }),
      agy: { type: 'agy-cli', enabled: true },
    },
    roles: {
      architect: { runner: 'claude', effort: 'high' },
      sdd: { runner: 'claude', effort: 'high' },
      planner: { runner: 'claude', effort: 'high' },
      planReviewer: { runner: 'claude', effort: 'high' },
      executors: {
        trivial: { runner: 'agy', effort: 'low' },
        normal: { runner: 'agy', effort: 'high' },
        complex: { runner: 'agy', effort: 'high' },
      },
      verification: { runner: 'claude', effort: 'medium' },
      finalReviewer: { runner: 'claude', effort: 'high' },
    },
  });

const healthyAgy: ObservedRunnerReport = {
  id: 'agy',
  installed: true,
  executable: true,
  auth: 'unknown',
};

const remediationsFor = (
  runners: readonly ObservedRunnerReport[],
): ReturnType<typeof generateRemediations> =>
  generateRemediations(
    runners,
    { name: 'node', present: true },
    { name: 'git', present: true },
    say,
  );

describe('a runner configuration refuses is not a runner that is missing', () => {
  it('classifies a declared-but-disabled runner as disabled', () => {
    expect(classifyUnavailability(configWith(false), 'claude')).toBe('disabled');
  });

  it('classifies an id no `runners:` entry declares as undeclared', () => {
    expect(classifyUnavailability(configWith('absent'), 'claude')).toBe('undeclared');
  });

  it('remediates a disabled runner by naming the flag, not an install command', () => {
    const runners: ObservedRunnerReport[] = [
      {
        id: 'claude',
        installed: false,
        executable: false,
        auth: 'not_configured',
        unavailable: 'disabled',
      },
      healthyAgy,
    ];

    const claude = remediationsFor(runners).filter((entry) =>
      entry.problem.includes('"claude"'),
    );

    expect(claude).toHaveLength(1);
    expect(claude[0]?.fix).toContain('runners.claude.enabled: true');

    // The regression itself: before the fix this was `npm install -g
    // @anthropic-ai/claude-code`, and following it changed nothing.
    expect(claude[0]?.problem).not.toContain('not installed');
    expect(claude[0]?.fix).not.toContain('npm install');
  });

  it('remediates an undeclared runner by asking for a declaration', () => {
    const runners: ObservedRunnerReport[] = [
      {
        id: 'claude',
        installed: false,
        executable: false,
        auth: 'not_configured',
        unavailable: 'undeclared',
      },
      healthyAgy,
    ];

    const claude = remediationsFor(runners).filter((entry) => entry.problem.includes('"claude"'));

    expect(claude).toHaveLength(1);
    expect(claude[0]?.problem).toContain('never declared');
    expect(claude[0]?.fix).not.toContain('npm install');
  });

  it('still tells a genuinely missing runner how to install itself', () => {
    // `unavailable` is absent: the registry built this runner, the health check spawned
    // it, and found nothing. Narrowing the install guidance must not delete it.
    const runners: ObservedRunnerReport[] = [
      { id: 'claude', installed: false, executable: false, auth: 'unknown' },
      healthyAgy,
    ];

    expect(remediationsFor(runners)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          problem: say.doctor.runnerNotInstalled('claude'),
          fix: 'npm install -g @anthropic-ai/claude-code',
        }),
      ]),
    );
  });

  it('never points the agy install at the URL that stopped serving a script', () => {
    const runners: ObservedRunnerReport[] = [
      { id: 'agy', installed: false, executable: false, auth: 'unknown' },
    ];

    const agy = remediationsFor(runners).filter((entry) =>
      entry.problem.includes('"agy"'),
    );

    // `https://antigravity.run/install.sh` answers 200 with the site's HTML landing page
    // — as does any path, including one invented for the check. Piping that into a shell
    // installs nothing and reports success.
    expect(agy).toHaveLength(1);
    expect(agy[0]?.fix).not.toContain('antigravity.run');
    expect(agy[0]?.fix).not.toContain('| bash');
    expect(agy[0]?.fix).toContain('agy');
  });
});
