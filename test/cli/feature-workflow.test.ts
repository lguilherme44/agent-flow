import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classificationLines, operatorVerificationLines, runFeatureCommand } from '../../src/cli/feature.js';
import { classifyWorkflow } from '../../src/core/adaptive-workflow.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { PlanSchema } from '../../src/contracts/index.js';

describe('CLI feature workflow validation & high-risk protection', () => {
  let tempDir: string;
  let globalConfigFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'af-feature-test-'));
    globalConfigFile = join(tempDir, 'global-config.yaml');
    await mkdir(join(tempDir, '.git'), { recursive: true });
    await writeFile(
      globalConfigFile,
      'runners:\n  claude:\n    type: claude-code-cli\nroles:\n  planner:\n    runner: claude\n',
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('rejects invalid --workflow string with CONFIG_ERROR before planning', async () => {
    const code = await runFeatureCommand(
      'some feature request',
      { workflow: 'banana' },
      {
        cwd: tempDir,
        globalConfigPath: globalConfigFile,
        verbose: false,
        dryRun: false,
        json: false,
        strict: false,
      },
    );
    expect(code).toBe(ExitCode.CONFIG_ERROR);
  });

  it('lists each operator verification on its own line, and nothing when there are none (FR-020)', () => {
    const task = {
      id: 'TASK-001',
      title: 'Add the button',
      description: 'Add it.',
      complexity: 'normal',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['It renders.'],
      validation: [],
    };
    const without = PlanSchema.parse({ feature: 'f', tasks: [task] });
    const withChecks = PlanSchema.parse({
      feature: 'f',
      tasks: [task],
      operatorVerifications: [
        { check: 'Build the release branch\nwith the change cherry-picked.', reason: 'The executor has one branch.' },
        { check: 'Run the device matrix.', reason: 'The executor has no device.' },
      ],
    });

    expect(operatorVerificationLines(without)).toEqual([]);

    const lines = operatorVerificationLines(withChecks);
    expect(lines.filter((line) => line.startsWith('  - '))).toEqual([
      '  - Build the release branch with the change cherry-picked. (The executor has one branch.)',
      '  - Run the device matrix. (The executor has no device.)',
    ]);
  });

  describe('the classification it prints (FR-015)', () => {
    it('prints the class, its origin, the deciding excerpt and the high-risk hint', () => {
      const lines = classificationLines(
        classifyWorkflow('Corrigir a expiração no token JWT. Não usa session.'),
      );
      const text = lines.join('\n');

      expect(lines[0]).toBe('Workflow: high-risk — detected from the request.');
      expect(text).toContain('Decided by token: "Corrigir a expiração no token JWT"');
      expect(text).toContain('Not counted (negated) — session: "Não usa session"');
      expect(text).toContain('cannot be lowered with --workflow');
      expect(text).toContain('rephrase the request and start a new run');
      // A class `--workflow` cannot lower is not offered `--workflow` as the way to lower it.
      expect(text).not.toContain('--workflow <class>');
      expect(text).not.toContain('--escalate');
    });

    it('prints an operator class with what the request alone decides, and both corrections', () => {
      const lines = classificationLines(
        classifyWorkflow('Change the button color', { explicitOverride: 'standard' }),
      );
      const text = lines.join('\n');

      expect(lines[0]).toBe('Workflow: standard — set by the operator; the request alone classifies as simple.');
      expect(text).toContain('Decided by color: "Change the button color"');
      expect(text).toContain('agent-flow feature "<description>" --workflow <class>');
      expect(text).toContain('agent-flow revise --escalate "<why>"');
      expect(text).not.toContain('cannot be lowered');
    });

    it('says a carried class was carried, and an override the signals raised was raised', () => {
      const carried = classificationLines(
        classifyWorkflow('Add customer feedback form', { explicitOverride: 'standard', overrideOrigin: 'carried' }),
      );
      expect(carried[0]).toBe('Workflow: standard — carried over from the earlier classification.');

      const raised = classificationLines(
        classifyWorkflow('Rotate the JWT token', { explicitOverride: 'simple' }),
      );
      expect(raised[0]).toBe('Workflow: high-risk — the operator asked for simple, raised by high-risk signals.');
      expect(raised.join('\n')).toContain('cannot be lowered with --workflow');
    });

    it('offers a chosen high-risk class a new run, and not an escalation past the ceiling', () => {
      const lines = classificationLines(
        classifyWorkflow('Add customer feedback form', { explicitOverride: 'high-risk' }),
      );
      const text = lines.join('\n');
      expect(text).toContain('--workflow <class>');
      expect(text).not.toContain('cannot be lowered');
      expect(text).not.toContain('--escalate');
    });
  });

  it('honors valid workflow string and verifies dry run with zero model calls', async () => {
    const code = await runFeatureCommand(
      'add some button',
      { workflow: 'simple' },
      {
        cwd: tempDir,
        globalConfigPath: globalConfigFile,
        verbose: false,
        dryRun: true,
        json: false,
        strict: false,
      },
    );
    expect(code).toBe(ExitCode.OK);
  });
});
