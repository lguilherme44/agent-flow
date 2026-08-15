import { describe, it, expect } from 'vitest';
import { generateRemediations } from '../../src/cli/doctor.js';
import { assessHealth, type ObservedRunner } from '../../src/core/health.js';
import { GlobalConfigSchema } from '../../src/contracts/index.js';

const baseConfig = GlobalConfigSchema.parse({
  runners: {
    claude: { type: 'claude-code-cli' },
    codex: { type: 'codex-cli' },
  },
  roles: {
    architect: { runner: 'claude', effort: 'high' },
    sdd: { runner: 'claude', effort: 'high' },
    planner: { runner: 'claude', effort: 'high' },
    planReviewer: { runner: 'codex', effort: 'high' },
    executors: {
      trivial: { runner: 'claude', effort: 'low' },
      normal: { runner: 'claude', effort: 'medium' },
      complex: { runner: 'claude', effort: 'high' },
    },
    verification: { runner: 'claude', effort: 'medium' },
    finalReviewer: { runner: 'codex', effort: 'very_high' },
  },
});

describe('Doctor Remediation (UX-06 / UX-07)', () => {
  it('generates concrete install commands when tools or runners are missing', () => {
    const observed: ObservedRunner[] = [
      { id: 'claude', installed: false, executable: false, auth: 'not_configured' },
      { id: 'codex', installed: true, executable: true, auth: 'not_configured' },
    ];

    const verdict = assessHealth(baseConfig, observed);
    const remediations = generateRemediations(
      observed,
      verdict,
      { present: false },
      { present: true },
    );

    expect(remediations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          problem: 'Node.js is missing from PATH',
          fix: expect.stringContaining('Install Node.js'),
        }),
        expect.objectContaining({
          problem: 'Runner "claude" is not installed or executable',
          fix: 'npm install -g @anthropic-ai/claude-code',
        }),
        expect.objectContaining({
          problem: 'Runner "codex" is missing credentials',
          fix: expect.stringContaining('codex login'),
        }),
      ]),
    );
  });

  it('returns empty remediations when everything is healthy', () => {
    const observed: ObservedRunner[] = [
      { id: 'claude', installed: true, executable: true, auth: 'configured' },
      { id: 'codex', installed: true, executable: true, auth: 'configured' },
    ];

    const verdict = assessHealth(baseConfig, observed);
    const remediations = generateRemediations(
      observed,
      verdict,
      { present: true },
      { present: true },
    );

    expect(remediations).toHaveLength(0);
  });
});
