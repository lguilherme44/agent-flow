import { describe, it, expect } from 'vitest';
import { generateRemediations } from '../../src/app/diagnostics.js';
import type { ObservedRunner } from '../../src/core/health.js';

describe('Doctor Remediation (UX-06 / UX-07)', () => {
  it('generates concrete install commands when tools or runners are missing', () => {
    const observed: ObservedRunner[] = [
      { id: 'claude', installed: false, executable: false, auth: 'not_configured' },
      { id: 'codex', installed: true, executable: true, auth: 'not_configured' },
    ];

    const remediations = generateRemediations(observed, { name: 'node', present: false }, {
      name: 'git',
      present: true,
    });

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

    const remediations = generateRemediations(observed, { name: 'node', present: true }, {
      name: 'git',
      present: true,
    });

    expect(remediations).toHaveLength(0);
  });
});
