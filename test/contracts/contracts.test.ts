import { describe, it, expect } from 'vitest';
import {
  ReasoningLevelSchema,
  REASONING_ORDER,
  WorkflowRoleSchema,
  WORKFLOW_ROLES,
  ALL_WORKFLOW_ROLES,
  roleConfigOf,
  roleConfigKeys,
  RunnerConfigSchema,
  RoleConfigSchema,
  GlobalConfigSchema,
  ProjectConfigSchema,
  TaskSchema,
  PlanSchema,
  RunStateSchema,
  DegradationSchema,
  DEGRADATION_KINDS,
  TaskResultSchema,
  TaskAttemptResultSchema,
  type TaskAttemptResult,
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

  it('publishes a config path that reaches exactly what roleConfigOf reads', () => {
    const roles = GlobalConfigSchema.parse({
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
    }).roles;

    // Two translations of one rule — `executor.trivial` is `roles.executors.trivial` —
    // and this is what stops them drifting apart in opposite directions.
    for (const role of ALL_WORKFLOW_ROLES) {
      const path = roleConfigKeys(role);
      expect(path[0]).toBe('roles');
      let node: unknown = { roles };
      for (const segment of path) node = (node as Record<string, unknown>)[segment];
      expect(node).toBe(roleConfigOf(roles, role));
    }
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
    validation: ['test'],
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

  describe('validation holds ids, never commands (V-01 regression)', () => {
    // Was a defect: `validation` was a free string list that the orchestrator
    // handed to `/bin/sh -c`. A plan is model output, and repository content
    // feeds the prompt that produces it — so this put untrusted text on a shell
    // outside the runner sandbox, which is the only containment there is.
    //
    // The character set is the first of two defences; `checkPlan` requiring the
    // id to exist is the second.

    it('accepts a plain id', () => {
      expect(TaskSchema.parse({ ...valid, validation: ['test'] }).validation).toEqual(['test']);
    });

    it('accepts dashed and numbered ids', () => {
      expect(TaskSchema.safeParse({ ...valid, validation: ['e2e-smoke', 'test2'] }).success).toBe(
        true,
      );
    });

    for (const payload of [
      'npm test',
      'echo MALICIOUS > /tmp/x',
      'npm test && curl evil.example',
      'test; rm -rf /',
      'test | sh',
      '$(whoami)',
      '`id`',
      './script.sh',
      '../../etc/passwd',
      'TEST',
      '-rf',
    ]) {
      it(`rejects ${JSON.stringify(payload)}`, () => {
        expect(TaskSchema.safeParse({ ...valid, validation: [payload] }).success).toBe(false);
      });
    }

    it('explains what was expected instead', () => {
      const result = TaskSchema.safeParse({ ...valid, validation: ['npm test'] });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(formatValidationError(result.error)).toMatch(/not a shell command/i);
    });
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

  it('adds no degradation kind for MVP 2 (§25.1)', () => {
    // The whole isolation milestone is covered by `parallelism_clamped`, which
    // already exists. A new kind would be a contract change for a run that
    // behaves exactly as before, and every reader of the channel would have to
    // learn a word for something that is not new.
    expect([...DEGRADATION_KINDS]).toEqual([
      'runner_unavailable_with_fallback',
      'single_provider',
      'auth_unverified',
      'reasoning_clamped',
      'forced_approval',
      'parallelism_clamped',
    ]);
  });
});

describe('the run carries its Git identity, and only optionally (MVP 2 §6.1)', () => {
  const LEGACY = {
    runId: 'AF-2026-001',
    feature: 'recurring-bookings',
    stage: 'sdd',
    status: 'running',
    createdAt: '2026-08-09T20:00:00.000Z',
    updatedAt: '2026-08-09T20:00:00.000Z',
  } as const;

  const OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

  it('loads a state file written before any of the four fields existed (§25.2)', () => {
    // Not a nicety — it is what a legacy run *is*. The fields being absent is the
    // shape that says this run predates the question, and it must keep parsing,
    // displaying and resuming exactly as it did.
    const parsed = RunStateSchema.parse(LEGACY);

    expect(parsed.planningBase).toBeUndefined();
    expect(parsed.gitRunKey).toBeUndefined();
    expect(parsed.isolationMode).toBeUndefined();
    expect(parsed.integrationHead).toBeUndefined();
  });

  it('carries all four when a run was born with them', () => {
    const parsed = RunStateSchema.parse({
      ...LEGACY,
      planningBase: OID,
      gitRunKey: 'AF-2026-001-0f3a91c4bd27e615',
      isolationMode: 'worktree',
      integrationHead: OID,
    });

    expect(parsed.planningBase).toBe(OID);
    expect(parsed.gitRunKey).toBe('AF-2026-001-0f3a91c4bd27e615');
    expect(parsed.isolationMode).toBe('worktree');
    expect(parsed.integrationHead).toBe(OID);
  });

  it('accepts the sequential mode, which is not the same as absent', () => {
    expect(RunStateSchema.parse({ ...LEGACY, isolationMode: 'none' }).isolationMode).toBe('none');
  });

  it('refuses an object id that is not a full lowercase SHA', () => {
    for (const field of ['planningBase', 'integrationHead'] as const) {
      for (const bad of [OID.toUpperCase(), OID.slice(0, 39), `${OID}0`, 'HEAD', '']) {
        expect(RunStateSchema.safeParse({ ...LEGACY, [field]: bad }).success, `${field}=${bad}`).toBe(
          false,
        );
      }
    }
  });

  it('refuses a run key that could be injected into a ref (S-2)', () => {
    for (const bad of [
      'AF-2026-001',
      'AF-2026-001-0F3A91C4BD27E615',
      'AF-2026-001-0f3a91c4bd27e61',
      'AF-2026-001-0f3a91c4bd27e615 --exec=sh',
      '../AF-2026-001-0f3a91c4bd27e615',
    ]) {
      expect(RunStateSchema.safeParse({ ...LEGACY, gitRunKey: bad }).success, bad).toBe(false);
    }
  });

  it('refuses an isolation mode nobody implements', () => {
    for (const bad of ['worktrees', 'container', 'true', '']) {
      expect(RunStateSchema.safeParse({ ...LEGACY, isolationMode: bad }).success, bad).toBe(false);
    }
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

describe('TaskAttemptResult is one execution, never an outcome (MVP 2 §10)', () => {
  const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const BASE = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
  const NONCE = '9f8e7d6c5b4a39281706f5e4d3c2b1a0';

  const RECEIPT = {
    nonce: NONCE,
    validatedTree: TREE,
    issuedAt: '2026-08-09T20:01:00.000Z',
  };

  const ATTEMPT = {
    run: 'AF-2026-001',
    task: 'TASK-003',
    attempt: 1,
    base: BASE,
    branch: 'agent-flow/AF-2026-001-0f3a91c4bd27e615/TASK-003/attempt-1',
    workspace: 'agent-flow-0f3a91c4bd27/AF-2026-001-0f3a91c4bd27e615/TASK-003/attempt-1',
    runner: 'claude',
    reasoning: 'high',
    startedAt: '2026-08-09T20:00:00.000Z',
    finishedAt: '2026-08-09T20:01:00.000Z',
    agentReport: { status: 'COMPLETED' },
    validation: { expectation: 'pass', passed: true },
    validationJudgement: 'satisfied',
    receipt: RECEIPT,
  } as const;

  const withJudgement = (
    judgement: string,
    receipt: typeof RECEIPT | undefined,
  ): Record<string, unknown> => {
    const { receipt: _dropped, ...rest } = ATTEMPT;
    return {
      ...rest,
      validationJudgement: judgement,
      ...(receipt === undefined ? {} : { receipt }),
    };
  };

  it('records what ran, where, and what the validation found', () => {
    const parsed = TaskAttemptResultSchema.parse(ATTEMPT);

    expect(parsed.task).toBe('TASK-003');
    expect(parsed.attempt).toBe(1);
    expect(parsed.receipt?.validatedTree).toBe(TREE);
    // The workspace is relative, so the artifact says nothing about this machine.
    expect(parsed.workspace.startsWith('/')).toBe(false);
    expect(parsed.filesChanged).toEqual([]);
    expect(parsed.reasoningClamped).toBe(false);
  });

  it('has no status field, so nothing here can be read as a task outcome (I-3)', () => {
    // `TaskResult` carries `status: TaskState`. Reusing it would put
    // `"status": "completed"` on disk for work that has not been integrated —
    // and recovery would believe it. The word is absent from this artifact by
    // construction, not by convention.
    const parsed = TaskAttemptResultSchema.parse({ ...ATTEMPT, status: 'completed' });

    expect('status' in parsed).toBe(false);

    // @ts-expect-error — TaskAttemptResult carries no TaskState, and the type
    // says so. If this line ever compiles, the artifact grew an outcome.
    const forbidden: unknown = (parsed satisfies TaskAttemptResult).status;
    expect(forbidden).toBeUndefined();
  });

  it('pairs a receipt with a satisfied judgement, in both directions', () => {
    expect(TaskAttemptResultSchema.safeParse(withJudgement('satisfied', RECEIPT)).success).toBe(
      true,
    );
    expect(TaskAttemptResultSchema.safeParse(withJudgement('unsatisfied', undefined)).success).toBe(
      true,
    );
    expect(TaskAttemptResultSchema.safeParse(withJudgement('not_reached', undefined)).success).toBe(
      true,
    );
  });

  it('refuses every other combination of the two', () => {
    // The `.refine` is what makes "a receipt means validation passed here" a
    // property of the data. A convention would be re-argued by every reader.
    expect(TaskAttemptResultSchema.safeParse(withJudgement('satisfied', undefined)).success).toBe(
      false,
    );
    expect(TaskAttemptResultSchema.safeParse(withJudgement('unsatisfied', RECEIPT)).success).toBe(
      false,
    );
    expect(TaskAttemptResultSchema.safeParse(withJudgement('not_reached', RECEIPT)).success).toBe(
      false,
    );
  });

  it('refuses a judgement outside the three', () => {
    expect(TaskAttemptResultSchema.safeParse(withJudgement('passed', RECEIPT)).success).toBe(false);
    expect(TaskAttemptResultSchema.safeParse(withJudgement('completed', RECEIPT)).success).toBe(
      false,
    );
  });

  it('holds the receipt to exact widths', () => {
    for (const nonce of [NONCE.slice(0, 31), `${NONCE}0`, NONCE.toUpperCase(), '']) {
      expect(
        TaskAttemptResultSchema.safeParse({ ...ATTEMPT, receipt: { ...RECEIPT, nonce } }).success,
        nonce,
      ).toBe(false);
    }

    for (const tree of [TREE.slice(0, 39), `${TREE}0`, TREE.toUpperCase(), 'HEAD']) {
      expect(
        TaskAttemptResultSchema.safeParse({
          ...ATTEMPT,
          receipt: { ...RECEIPT, validatedTree: tree },
        }).success,
        tree,
      ).toBe(false);
    }
  });

  it('counts attempts from one', () => {
    expect(TaskAttemptResultSchema.safeParse({ ...ATTEMPT, attempt: 0 }).success).toBe(false);
    expect(TaskAttemptResultSchema.safeParse({ ...ATTEMPT, attempt: -1 }).success).toBe(false);
    expect(TaskAttemptResultSchema.safeParse({ ...ATTEMPT, attempt: 1.5 }).success).toBe(false);
    expect(TaskAttemptResultSchema.parse({ ...ATTEMPT, attempt: 7 }).attempt).toBe(7);
  });

  it('records provenance, including a fallback that actually fired', () => {
    const parsed = TaskAttemptResultSchema.parse({
      ...ATTEMPT,
      model: 'a-model',
      reasoningClamped: true,
      fallback: { from: 'codex', errorCode: 'quota_exceeded' },
      filesChanged: ['src/a.ts', 'src/b.ts'],
    });

    expect(parsed.fallback?.from).toBe('codex');
    expect(parsed.fallback?.errorCode).toBe('quota_exceeded');
    expect(parsed.reasoningClamped).toBe(true);
    expect(parsed.filesChanged).toHaveLength(2);
  });

  it('refuses a fallback triggered by something a fallback may not react to', () => {
    expect(
      TaskAttemptResultSchema.safeParse({
        ...ATTEMPT,
        fallback: { from: 'codex', errorCode: 'vibes' },
      }).success,
    ).toBe(false);
  });

  it('keeps the three validation expectations, including a test-first task', () => {
    for (const expectation of ['pass', 'fail', 'none'] as const) {
      const parsed = TaskAttemptResultSchema.parse({
        ...ATTEMPT,
        validation: { expectation, passed: expectation !== 'fail', ids: ['unit'], commands: [] },
      });

      expect(parsed.validation.expectation).toBe(expectation);
      expect(parsed.validation.ids).toEqual(['unit']);
    }
  });

  it('refuses an absolute workspace, an empty one, and a task id it cannot place', () => {
    expect(TaskAttemptResultSchema.safeParse({ ...ATTEMPT, workspace: '' }).success).toBe(false);
    expect(TaskAttemptResultSchema.safeParse({ ...ATTEMPT, branch: '' }).success).toBe(false);
    expect(TaskAttemptResultSchema.safeParse({ ...ATTEMPT, task: '../../etc' }).success).toBe(
      false,
    );
    expect(TaskAttemptResultSchema.safeParse({ ...ATTEMPT, base: 'HEAD' }).success).toBe(false);
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
