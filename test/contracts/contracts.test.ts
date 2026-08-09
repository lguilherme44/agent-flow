import { describe, it, expect } from 'vitest';
import {
  ReasoningLevelSchema,
  REASONING_ORDER,
  WorkflowRoleSchema,
  WORKFLOW_ROLES,
  RunnerConfigSchema,
  RoleConfigSchema,
  GlobalConfigSchema,
  ProjectConfigSchema,
  TaskSchema,
  PlanSchema,
  RunStateSchema,
  DegradationSchema,
  TaskResultSchema,
  ReviewResultSchema,
  FindingSchema,
  HealthReportSchema,
  toJsonSchema,
  formatValidationError,
} from '../../src/contracts/index.js';

describe('ReasoningLevel (§3.1, R-09)', () => {
  it('accepts the four logical levels', () => {
    for (const level of ['low', 'medium', 'high', 'very_high']) {
      expect(ReasoningLevelSchema.parse(level)).toBe(level);
    }
  });

  it('rejects physical CLI values — those belong to adapters', () => {
    // `xhigh` and `max` are Claude Code's wire format. If the core ever accepts
    // them, provider vocabulary has leaked past the adapter boundary.
    for (const physical of ['xhigh', 'max', 'minimal', '']) {
      expect(ReasoningLevelSchema.safeParse(physical).success).toBe(false);
    }
  });

  it('orders levels low → very_high so clamping is well defined (R-15)', () => {
    expect(REASONING_ORDER).toEqual(['low', 'medium', 'high', 'very_high']);
  });
});

describe('WorkflowRole (§3)', () => {
  it('covers every role the spec names', () => {
    expect([...WORKFLOW_ROLES].sort()).toEqual(
      [
        'architect',
        'sdd',
        'planner',
        'planReviewer',
        'executor.trivial',
        'executor.normal',
        'executor.complex',
        'verification',
        'finalReviewer',
      ].sort(),
    );
  });

  it('rejects unknown roles', () => {
    expect(WorkflowRoleSchema.safeParse('executor.gigantic').success).toBe(false);
  });
});

describe('RoleConfig (AD-13)', () => {
  it('treats model as optional so pinned names cannot rot', () => {
    const parsed = RoleConfigSchema.parse({ runner: 'claude', effort: 'high' });
    expect(parsed.model).toBeUndefined();
    expect(parsed.runner).toBe('claude');
  });

  it('keeps model when given', () => {
    expect(RoleConfigSchema.parse({ runner: 'claude', model: 'opus', effort: 'high' }).model).toBe(
      'opus',
    );
  });

  it('defaults the timeout so a hung runner cannot stall forever (R-11)', () => {
    expect(RoleConfigSchema.parse({ runner: 'claude', effort: 'low' }).timeoutSeconds).toBe(900);
  });

  it('requires a runner', () => {
    expect(RoleConfigSchema.safeParse({ effort: 'high' }).success).toBe(false);
  });
});

describe('RunnerConfig', () => {
  it('is enabled by default', () => {
    expect(RunnerConfigSchema.parse({ type: 'claude-code-cli' }).enabled).toBe(true);
  });

  it('allows overriding the executable path', () => {
    const parsed = RunnerConfigSchema.parse({ type: 'codex-cli', command: '/usr/local/bin/codex' });
    expect(parsed.command).toBe('/usr/local/bin/codex');
  });
});

describe('GlobalConfig (§6)', () => {
  const minimal = {
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
  };

  it('parses a single-runner config — the alpha checkpoint shape (C-4)', () => {
    const parsed = GlobalConfigSchema.parse(minimal);
    expect(parsed.version).toBe(1);
    expect(parsed.parallelism.maxTasks).toBe(1);
  });

  it('restricts fallback triggers to infrastructure causes (§55)', () => {
    const parsed = GlobalConfigSchema.parse({
      ...minimal,
      fallback: { enabled: true, on: ['quota_exceeded', 'auth_required'] },
    });
    expect(parsed.fallback.on).toEqual(['quota_exceeded', 'auth_required']);
  });

  it('refuses quality-driven fallback triggers (§55)', () => {
    // Retrying a bad implementation on another model hides a quality failure.
    // The config layer is where that has to be impossible, not a convention.
    for (const forbidden of ['execution_failed', 'invalid_output', 'blocked', 'timeout']) {
      const result = GlobalConfigSchema.safeParse({
        ...minimal,
        fallback: { enabled: true, on: [forbidden] },
      });
      expect(result.success, `${forbidden} must not be a fallback trigger`).toBe(false);
    }
  });

  it('requires every role to be present', () => {
    const { architect: _dropped, ...rest } = minimal.roles;
    expect(GlobalConfigSchema.safeParse({ ...minimal, roles: rest }).success).toBe(false);
  });

  it('defaults approval to required before implementation (§17)', () => {
    expect(GlobalConfigSchema.parse(minimal).approval.requiredBeforeImplementation).toBe(true);
  });
});

describe('ProjectConfig (§6)', () => {
  it('accepts a project with no commands at all', () => {
    // init on an unrecognised stack must produce something usable, not a crash.
    const parsed = ProjectConfigSchema.parse({ project: { name: 'x', type: 'unknown' } });
    expect(parsed.commands).toEqual({});
    expect(parsed.rules.architecture).toEqual([]);
  });

  it('keeps declared validation commands verbatim', () => {
    const parsed = ProjectConfigSchema.parse({
      project: { name: 'api', type: 'node' },
      commands: { test: 'npm test', lint: 'npm run lint' },
    });
    expect(parsed.commands.test).toBe('npm test');
  });
});

describe('Task (§12, §46)', () => {
  const valid = {
    id: 'TASK-003',
    title: 'Implement recurring booking generation',
    description: 'Generate occurrences from a recurrence rule.',
    complexity: 'complex',
    risk: 'high',
    dependencies: ['TASK-001'],
    requirements: ['FR-001'],
    flags: {
      databaseChange: false,
      crossModule: true,
      architectureDecision: true,
      externalIntegration: false,
    },
    acceptanceCriteria: ['Occurrences are generated for weekly rules'],
    validation: ['npm test -- booking'],
  };

  it('parses a well formed task', () => {
    expect(TaskSchema.parse(valid).id).toBe('TASK-003');
  });

  it('requires at least one requirement id (§40, §41)', () => {
    // Coverage checking is only possible if every task points at a requirement.
    expect(TaskSchema.safeParse({ ...valid, requirements: [] }).success).toBe(false);
  });

  it('requires at least one acceptance criterion (§13)', () => {
    expect(TaskSchema.safeParse({ ...valid, acceptanceCriteria: [] }).success).toBe(false);
  });

  it('enforces the TASK-nnn id format', () => {
    for (const bad of ['task-003', 'TASK-3', 'TASK_003', '3']) {
      expect(TaskSchema.safeParse({ ...valid, id: bad }).success, bad).toBe(false);
    }
  });

  it('enforces requirement id format', () => {
    expect(TaskSchema.safeParse({ ...valid, requirements: ['FR1'] }).success).toBe(false);
    expect(TaskSchema.safeParse({ ...valid, requirements: ['NFR-001'] }).success).toBe(true);
    expect(TaskSchema.safeParse({ ...valid, requirements: ['SEC-010'] }).success).toBe(true);
  });

  it('rejects a task that depends on itself', () => {
    expect(TaskSchema.safeParse({ ...valid, dependencies: ['TASK-003'] }).success).toBe(false);
  });

  it('defaults flags so planners may omit them', () => {
    const { flags: _omitted, ...withoutFlags } = valid;
    const parsed = TaskSchema.parse(withoutFlags);
    expect(parsed.flags).toEqual({
      databaseChange: false,
      crossModule: false,
      architectureDecision: false,
      externalIntegration: false,
    });
  });
});

describe('Plan', () => {
  const task = {
    id: 'TASK-001',
    title: 'Add types',
    description: 'Add recurrence domain types.',
    complexity: 'trivial',
    risk: 'low',
    dependencies: [],
    requirements: ['FR-001'],
    acceptanceCriteria: ['Types compile'],
    validation: [],
  };

  it('parses a plan', () => {
    const parsed = PlanSchema.parse({ feature: 'recurring-bookings', tasks: [task] });
    expect(parsed.tasks).toHaveLength(1);
  });

  it('rejects duplicate task ids', () => {
    const result = PlanSchema.safeParse({ feature: 'f', tasks: [task, task] });
    expect(result.success).toBe(false);
  });

  it('rejects an empty plan', () => {
    expect(PlanSchema.safeParse({ feature: 'f', tasks: [] }).success).toBe(false);
  });
});

describe('Degradation and RunState (R-16)', () => {
  it('records why a capability was lost, not just that it was', () => {
    const parsed = DegradationSchema.parse({
      kind: 'single_provider',
      reason: 'only claude is healthy',
      impact: 'cross-provider review unavailable',
      detectedAt: '2026-08-09T20:00:00.000Z',
    });
    expect(parsed.kind).toBe('single_provider');
  });

  it('rejects an unknown degradation kind', () => {
    expect(
      DegradationSchema.safeParse({
        kind: 'vibes',
        reason: 'r',
        impact: 'i',
        detectedAt: '2026-08-09T20:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('carries degradations on the run so they survive resume', () => {
    const parsed = RunStateSchema.parse({
      runId: 'AF-2026-001',
      feature: 'recurring-bookings',
      stage: 'sdd',
      status: 'running',
      createdAt: '2026-08-09T20:00:00.000Z',
      updatedAt: '2026-08-09T20:00:00.000Z',
    });
    expect(parsed.approved).toBe(false);
    expect(parsed.degradations).toEqual([]);
  });

  it('enforces the AF-YYYY-NNN run id format', () => {
    const base = {
      feature: 'f',
      stage: 'sdd',
      status: 'running',
      createdAt: '2026-08-09T20:00:00.000Z',
      updatedAt: '2026-08-09T20:00:00.000Z',
    };
    expect(RunStateSchema.safeParse({ ...base, runId: 'AF-2026-1' }).success).toBe(false);
    expect(RunStateSchema.safeParse({ ...base, runId: 'AF-2026-001' }).success).toBe(true);
  });
});

describe('TaskResult (§21)', () => {
  it('records the runner actually used, including fallback and clamping', () => {
    const parsed = TaskResultSchema.parse({
      task: 'TASK-003',
      status: 'completed',
      runner: 'claude',
      reasoning: 'high',
      startedAt: '2026-08-09T20:00:00.000Z',
      finishedAt: '2026-08-09T20:01:00.000Z',
      filesChanged: ['src/a.ts'],
      validation: { passed: true, commands: [] },
      fallback: { from: 'codex', errorCode: 'runner_unavailable' },
      reasoningClamped: true,
    });
    expect(parsed.fallback?.errorCode).toBe('runner_unavailable');
    expect(parsed.reasoningClamped).toBe(true);
  });

  it('defaults reasoningClamped to false', () => {
    const parsed = TaskResultSchema.parse({
      task: 'TASK-001',
      status: 'completed',
      runner: 'claude',
      reasoning: 'low',
      startedAt: '2026-08-09T20:00:00.000Z',
      finishedAt: '2026-08-09T20:00:10.000Z',
      validation: { passed: true, commands: [] },
    });
    expect(parsed.reasoningClamped).toBe(false);
    expect(parsed.filesChanged).toEqual([]);
  });
});

describe('ReviewResult (§28, R-16)', () => {
  it('states on the artifact itself whether independence was real', () => {
    // A same-provider review that does not say so is omitting the main thing.
    const parsed = ReviewResultSchema.parse({
      verdict: 'PASS',
      independence: 'same-provider-fresh-context',
      reviewer: { runner: 'claude', reasoning: 'high' },
      findings: [],
    });
    expect(parsed.independence).toBe('same-provider-fresh-context');
  });

  it('requires independence to be declared', () => {
    expect(
      ReviewResultSchema.safeParse({
        verdict: 'PASS',
        reviewer: { runner: 'claude', reasoning: 'high' },
        findings: [],
      }).success,
    ).toBe(false);
  });

  it('requires findings when the verdict is FAIL (§16)', () => {
    const result = ReviewResultSchema.safeParse({
      verdict: 'FAIL',
      independence: 'cross-provider',
      reviewer: { runner: 'claude', reasoning: 'high' },
      findings: [],
    });
    expect(result.success).toBe(false);
  });

  it('parses a finding', () => {
    const parsed = FindingSchema.parse({
      severity: 'high',
      type: 'missing_requirement',
      requirement: 'FR-004',
      description: 'No task implements FR-004.',
      suggestedAction: 'Add a task covering FR-004.',
    });
    expect(parsed.requirement).toBe('FR-004');
  });
});

describe('HealthReport (C-2, AD-15)', () => {
  it('models health as ternary, not boolean', () => {
    for (const status of ['OK', 'DEGRADED', 'FAIL']) {
      const parsed = HealthReportSchema.parse({
        status,
        runners: [],
        degradations: [],
        orphanRoles: [],
      });
      expect(parsed.status).toBe(status);
    }
  });

  it('distinguishes installed from executable (the real Codex failure mode)', () => {
    const parsed = HealthReportSchema.parse({
      status: 'DEGRADED',
      runners: [{ id: 'codex', installed: true, executable: false, auth: 'unknown' }],
      degradations: [],
      orphanRoles: [],
    });
    expect(parsed.runners[0]?.installed).toBe(true);
    expect(parsed.runners[0]?.executable).toBe(false);
  });
});

describe('JSON Schema generation (AD-08)', () => {
  it('derives a JSON Schema from the plan contract', () => {
    // Feeds Claude Code's --json-schema so structured output is enforced by the
    // runtime rather than hoped for in the prompt.
    const schema = toJsonSchema(PlanSchema) as Record<string, unknown>;
    expect(schema['type']).toBe('object');
    expect(Object.keys(schema['properties'] as object)).toContain('tasks');
  });

  it('omits $schema, which a consuming CLI rejects rather than resolves', () => {
    // Found end-to-end: Claude Code fails the whole invocation with "no schema
    // with key or ref https://json-schema.org/draft/2020-12/schema". The
    // dialect declaration is useless when the schema is handed straight to a
    // tool instead of published as a document.
    expect(toJsonSchema(PlanSchema)).not.toHaveProperty('$schema');
  });
});

describe('formatValidationError', () => {
  it('names the failing path and what was received', () => {
    const result = TaskSchema.safeParse({ id: 'nope', title: 't' });
    expect(result.success).toBe(false);
    if (result.success) return;

    const message = formatValidationError(result.error, 'plan.json');
    expect(message).toContain('plan.json');
    expect(message).toContain('id');
  });
});
