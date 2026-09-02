import { describe, it, expect } from 'vitest';
import { resolveTaskAgent } from '../../src/core/team/policy.js';
import { teamWaveAdmission } from '../../src/core/team/waves.js';
import { patternCovers } from '../../src/core/team/ownership.js';
import { deriveTaskRequirements } from '../../src/core/team/requirements.js';
import { projectHandoffs } from '../../src/core/collaboration/handoffs.js';
import { deriveAgentRoster } from '../../src/core/collaboration/roster.js';
import {
  AgentMessageSchema,
  GlobalConfigSchema,
  ProposedMessageSchema,
  TaskSchema,
  TeamConfigSchema,
  normaliseSkill,
  type AgentMessage,
  type GlobalConfig,
  type Task,
} from '../../src/contracts/index.js';

/**
 * M5's threat model, exercised (§42).
 *
 * **The new attack surface is one sentence: a model can now write text that, if believed,
 * would change who does the work.** M4's surface was speech — a message could lie about
 * what it found. M5's is authority — a message could claim an area, name an assignee, or
 * ask to be moved to a better provider. Every row below is one of those, and every
 * defence is structural rather than a check somebody has to remember.
 *
 * Two rows are not about a model at all. An ownership pattern and a skill string come
 * from a configuration file, and a configuration file is written by a person who may be
 * pasting something they were handed.
 */

const NOW = '2026-08-09T21:00:00.000Z';

const ROLES = {
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
  finalReviewer: { runner: 'claude', effort: 'high' },
};

function config(
  members?: Record<string, Record<string, unknown>>,
  collaboration: Record<string, unknown> = {},
): GlobalConfig {
  return GlobalConfigSchema.parse({
    runners: { claude: { type: 'claude-code-cli' } },
    roles: ROLES,
    collaboration: { enabled: true, ...collaboration },
    ...(members === undefined
      ? {}
      : {
          teams: {
            core: {
              members: Object.fromEntries(
                Object.entries(members).map(([id, member]) => [
                  id,
                  { role: 'executor.normal', runner: 'claude', ...member },
                ]),
              ),
              policies: { admitHandoffs: true },
            },
          },
        }),
  });
}

function task(id: string, files: readonly string[] = ['src/server/a.ts']): Task {
  return TaskSchema.parse({
    id,
    title: `Task ${id}`,
    description: 'Some work.',
    complexity: 'normal',
    risk: 'low',
    dependencies: [],
    requirements: ['FR-001'],
    files: { likely: [...files] },
    acceptanceCriteria: ['It compiles.'],
    validation: ['test'],
  });
}

function message(overrides: Partial<AgentMessage>): AgentMessage {
  return AgentMessageSchema.parse({
    id: 'MSG-0001',
    runId: 'AF-2026-001',
    threadId: 'THR-0001',
    from: 'backend',
    to: { kind: 'everyone' },
    type: 'question',
    subject: 'a subject',
    body: 'a body',
    createdAt: '2026-08-09T20:00:00.000Z',
    ...overrides,
  });
}

function assign(input: {
  config: GlobalConfig;
  task?: Task;
  handoffs?: ReturnType<typeof projectHandoffs>;
  inFlight?: Map<string, number>;
  canImplement?: () => boolean;
}) {
  return resolveTaskAgent({
    task: input.task ?? task('TASK-001'),
    routedRole: 'executor.normal',
    config: input.config,
    roster: deriveAgentRoster(input.config),
    handoffs: input.handoffs ?? [],
    inFlight: input.inFlight ?? new Map(),
    canImplement: input.canImplement ?? (() => true),
    now: NOW,
  });
}

/* ─── 1. An agent that says it owns something ───────────────────────────────── */

describe('an agent that claims a resource', () => {
  it('has no field to claim it in', () => {
    // The defence is the absence of the field, not a check. Zod strips unknown keys, so
    // the claim is gone before anything could read it — and nothing has to remember.
    const parsed = ProposedMessageSchema.parse({
      to: { kind: 'everyone' },
      type: 'decision',
      subject: 'src/db is mine',
      body: 'claiming it',
      ownership: { exclusive: ['**'] },
      capacity: { maxConcurrentTasks: 99 },
      skills: ['everything'],
      agentId: 'somebody-else',
    });

    expect(JSON.stringify(parsed)).not.toContain('exclusive');
    expect(JSON.stringify(parsed)).not.toContain('maxConcurrentTasks');
    expect(JSON.stringify(parsed)).not.toContain('somebody-else');
  });

  it('changes no ownership by saying so in a body', () => {
    // A body is text. The ownership map is configuration, and the two never meet: the
    // policy reads `config.teams`, and no code path writes it.
    const global = config({
      dba: { ownership: { exclusive: ['src/db/**'] } },
      backend: {},
    });

    const claim = message({
      from: 'backend',
      type: 'decision',
      subject: 'src/db is mine now',
      body: 'ownership: { exclusive: ["src/db/**"] }',
    });

    const before = assign({ config: global, task: task('TASK-001', ['src/db/a.sql']) });
    // The message exists and is read by nobody who assigns.
    expect(claim.body).toContain('src/db');
    const after = assign({ config: global, task: task('TASK-001', ['src/db/a.sql']) });

    expect(after).toEqual(before);
    expect(after.agentId).toBe('dba');
  });
});

/* ─── 2. A handoff towards a better provider ────────────────────────────────── */

describe('an agent that asks to be moved somewhere more capable', () => {
  const escalation = projectHandoffs([
    message({
      id: 'MSG-0001',
      type: 'handoff_request',
      from: 'backend',
      to: { kind: 'agent', id: 'expensive' },
      taskId: 'TASK-001',
    }),
    message({
      id: 'MSG-0002',
      type: 'handoff_accepted',
      from: 'expensive',
      to: { kind: 'agent', id: 'backend' },
      taskId: 'TASK-001',
    }),
  ]);

  it('is refused when the team did not grant the permission', () => {
    const global = GlobalConfigSchema.parse({
      runners: { claude: { type: 'claude-code-cli' } },
      roles: ROLES,
      collaboration: { enabled: true },
      teams: {
        core: {
          members: {
            backend: { role: 'executor.normal', runner: 'claude' },
            expensive: { role: 'executor.normal', runner: 'claude' },
          },
          policies: { admitHandoffs: false },
        },
      },
    });

    const assignment = assign({ config: global, handoffs: escalation });
    expect(assignment.reason).toBe('handoff_not_admitted');
    expect(assignment.agentId).toBe('executor.normal');
  });

  it('is still filtered by every rule the ordinary path applies, once granted', () => {
    // Permission to *consider* is not permission to *have*. An escalation to a member
    // that is out of capacity is refused, whatever the two agents agreed between them.
    const assignment = assign({
      config: config({ backend: {}, expensive: {} }),
      handoffs: escalation,
      inFlight: new Map([['expensive', 1]]),
    });

    expect(assignment.reason).toBe('handoff_refused_capability');
    expect(assignment.detail).toContain('capacity');
  });

  it('cannot escalate to a role the plan did not ask for', () => {
    // A task routed to `executor.normal` cannot be handed to a member serving
    // `finalReviewer`, however willing both are. The plan is written in roles.
    const assignment = assign({
      config: config({ backend: {}, expensive: { role: 'finalReviewer' } }),
      handoffs: escalation,
    });

    expect(assignment.reason).toBe('handoff_refused_capability');
    expect(assignment.detail).toContain('role_mismatch');
  });
});

/* ─── 3. A message that spoofs an assignment ────────────────────────────────── */

describe('a message that tries to be an assignment', () => {
  it('cannot name its own sender', () => {
    // I-28, and the reason it matters more in M5: a forged `from` on a handoff
    // acceptance would be a third party taking a task off the agent it was offered to.
    const parsed = ProposedMessageSchema.parse({
      to: { kind: 'everyone' },
      type: 'finding',
      subject: 's',
      body: 'b',
      from: 'architect',
    });

    expect(JSON.stringify(parsed)).not.toContain('architect');
  });

  it('cannot settle a handoff it was not the target of', () => {
    // A response from anyone but the target is not a transition. It stays in the thread,
    // where a reader sees it, and it moves nothing.
    const forged = projectHandoffs([
      message({
        id: 'MSG-0001',
        type: 'handoff_request',
        from: 'backend',
        to: { kind: 'agent', id: 'frontend' },
        taskId: 'TASK-001',
      }),
      message({
        id: 'MSG-0002',
        type: 'handoff_accepted',
        from: 'interloper',
        to: { kind: 'agent', id: 'backend' },
        taskId: 'TASK-001',
      }),
    ]);

    expect(forged[0]?.status).toBe('requested');
    expect(assign({ config: config({ backend: {}, frontend: {} }), handoffs: forged }).reason).toBe(
      'team_match',
    );
  });

  it('cannot assign a task that is not the one it names', () => {
    const other = projectHandoffs([
      message({
        id: 'MSG-0001',
        type: 'handoff_request',
        from: 'backend',
        to: { kind: 'agent', id: 'frontend' },
        taskId: 'TASK-009',
      }),
      message({
        id: 'MSG-0002',
        type: 'handoff_accepted',
        from: 'frontend',
        to: { kind: 'agent', id: 'backend' },
        taskId: 'TASK-009',
      }),
    ]);

    expect(assign({ config: config({ backend: {}, frontend: {} }), handoffs: other }).reason).toBe(
      'team_match',
    );
  });
});

/* ─── 4. A skill string built to do damage ──────────────────────────────────── */

describe('a skill string that is not a skill', () => {
  it('bounds what a configuration file may declare', () => {
    // 60 characters, 32 of them. A skill list is matched against a task's requirements on
    // every assignment; an unbounded one is an unbounded loop paid for on every task.
    expect(() =>
      TeamConfigSchema.parse({
        members: { backend: { role: 'executor.normal', runner: 'claude', skills: ['x'.repeat(61)] } },
      }),
    ).toThrow();

    expect(() =>
      TeamConfigSchema.parse({
        members: {
          backend: {
            role: 'executor.normal',
            runner: 'claude',
            skills: Array.from({ length: 33 }, (_, i) => `s${String(i)}`),
          },
        },
      }),
    ).toThrow();
  });

  it('normalises a string with markup or control characters into a plain id', () => {
    // Matched exactly on both sides after normalisation, so whatever survives is a token
    // that can only ever fail to match. Nothing here is interpolated into a command, a
    // path or a regular expression.
    for (const hostile of [
      '<script>alert(1)</script>',
      'type\u0000script',
      '../../etc/passwd',
      'Type Script',
      '  TYPESCRIPT  ',
    ]) {
      const normalised = normaliseSkill(hostile);
      if (normalised === undefined) continue;
      expect(normalised, hostile).toMatch(/^[a-z0-9][a-z0-9.+-]*$/);
    }
  });

  it('matches a skill exactly, so a crafted one cannot match everything', () => {
    // No fuzzy matching, no substring, no regular expression. `vue` and `vuex` are two
    // skills, and a skill of `*` matches nothing at all.
    // The area implies the skill, which is where a task's requirement comes from — so
    // the configuration below is what produces the requirement, not a map written here.
    const global = config({
      honest: { skills: ['typescript'], ownership: { preferred: ['src/server/**'] } },
      // Not `typescript-`: that is a typo, and normalising it to `typescript` is the
      // schema being forgiving rather than a match being smuggled. These are the shapes
      // a wildcard matcher would have accepted and an exact one must not.
      greedy: { skills: ['*', '.*', 'type', 'typescriptx'], ownership: { preferred: ['apps/web/**'] } },
    });

    const requirements = deriveTaskRequirements({
      task: task('TASK-001'),
      role: 'executor.normal',
      areaSkills: new Map([['src/server/**', ['typescript']]]),
    });

    const ranked = assign({ config: global, task: task('TASK-001') }).candidates;
    expect(requirements.skills).toEqual(['typescript']);
    expect(ranked.find((c) => c.agentId === 'greedy')?.matchedSkills).toEqual([]);
    expect(ranked.find((c) => c.agentId === 'honest')?.matchedSkills).toEqual(['typescript']);
  });
});

/* ─── 5, 6. A pattern or a path that tries to leave the repository ──────────── */

describe('an ownership pattern that tries to reach outside the workspace', () => {
  it('refuses a pattern the schema will not accept', () => {
    // The character class is the first gate: a pattern is a repository-relative path, and
    // a scheme, a drive letter or a backslash is not one.
    for (const hostile of ['../../etc/**', '/etc/**', 'C:\\windows\\**', 'file:///etc', '**\u0000']) {
      expect(
        () =>
          TeamConfigSchema.parse({
            members: {
              backend: { role: 'executor.normal', runner: 'claude', ownership: { exclusive: [hostile] } },
            },
          }),
        hostile,
      ).toThrow();
    }
  });

  it('owns nothing when the path being matched is one the repository rejects', () => {
    // Fail-closed, and delegated: `validateAndNormalizeRepositoryPath` already holds the
    // list of what a path may not be, and a second copy here is a second chance to miss
    // one of them.
    for (const hostile of [
      '../outside.ts',
      '/etc/passwd',
      'src/%2e%2e/a.ts',
      'src/../../a.ts',
      '.git/config',
      '.agent-flow/config.yaml',
      'C:\\windows\\system32',
      '\\\\server\\share\\a.ts',
    ]) {
      expect(patternCovers('**', hostile), hostile).toBe(false);
    }
  });

  it('does not let a normalisation difference hand one member another’s area', () => {
    // The two spellings must agree. `src/./server/a.ts` and `src/server/a.ts` are one
    // file, and a matcher that saw them as two would put a second writer in an exclusive
    // area without anybody noticing.
    expect(patternCovers('src/server/**', 'src/./server/a.ts')).toBe(
      patternCovers('src/server/**', 'src/server/a.ts'),
    );
  });

  it('gives an unmatchable path no ownership rather than universal ownership', () => {
    // The direction of the failure is the whole point. A rejected path that matched
    // everything would make one bad entry in the plan hand the run to one member.
    const global = config({ greedy: { ownership: { preferred: ['**'] } }, other: {} });
    const ranked = assign({ config: global, task: task('TASK-001', ['../outside.ts']) }).candidates;

    expect(ranked.find((c) => c.agentId === 'greedy')?.ownership).toBe(0);
  });
});

/* ─── 7. Starving the team ──────────────────────────────────────────────────── */

describe('a wave that could starve the team', () => {
  const admission = (global: GlobalConfig) =>
    teamWaveAdmission({
      config: global,
      roster: deriveAgentRoster(global),
      canImplement: () => true,
      routedRole: () => 'executor.normal',
      now: NOW,
    });

  it('always admits the first task, so a full team slows a run and never stalls it', () => {
    // **The invariant that makes starvation impossible.** Both constraints are relations
    // to the tasks already in the wave, and the first candidate faces neither.
    const global = config({ solo: { ownership: { exclusive: ['**'] } } });

    expect(admission(global)(task('TASK-001'), [])).toBeUndefined();
  });

  it('does not defer a task no member could ever take', () => {
    // Waiting for a role nobody serves is waiting forever. The router's fallback runs it.
    const global = config({ reviewer: { role: 'finalReviewer' } });

    expect(admission(global)(task('TASK-002'), [task('TASK-001')])).toBeUndefined();
  });

  it('assigns a task the whole team is excluded from rather than dropping it', () => {
    const assignment = assign({ config: config({ backend: {} }), canImplement: () => false });

    expect(assignment.agentId).toBe('executor.normal');
    expect(assignment.reason).toBe('no_eligible_member');
  });

  it('cannot be made to consider more candidates than a team has members', () => {
    // The ranking is bounded by the configuration, not by anything a run produces. A
    // message cannot add a candidate, so the per-task cost is fixed when the file is
    // written.
    const global = config({ a: {}, b: {}, c: {} });
    expect(assign({ config: global }).candidates).toHaveLength(3);
  });
});

/* ─── 8. Passing a task around forever ──────────────────────────────────────── */

describe('a task being passed around', () => {
  function chain(hops: number): ReturnType<typeof projectHandoffs> {
    const messages: AgentMessage[] = [];
    for (let hop = 0; hop < hops; hop += 1) {
      const from = hop === 0 ? 'backend' : `m${String(hop)}`;
      const to = `m${String(hop + 1)}`;
      messages.push(
        message({
          id: `MSG-${String(hop * 2 + 1).padStart(4, '0')}`,
          threadId: `THR-${String(hop).padStart(4, '0')}`,
          type: 'handoff_request',
          from,
          to: { kind: 'agent', id: to },
          taskId: 'TASK-001',
        }),
        message({
          id: `MSG-${String(hop * 2 + 2).padStart(4, '0')}`,
          threadId: `THR-${String(hop).padStart(4, '0')}`,
          type: 'handoff_accepted',
          from: to,
          to: { kind: 'agent', id: from },
          taskId: 'TASK-001',
        }),
      );
    }
    return projectHandoffs(messages);
  }

  it('stops at the budget, and the budget is the one that already existed', () => {
    // `collaboration.maxHandoffsPerTask`. A second budget on the team object would be one
    // concept with two names, and the two would eventually disagree about how many is
    // too many.
    const global = config(
      { backend: {}, m1: {}, m2: {}, m3: {} },
      { handoffsReassignExecution: true, maxHandoffsPerTask: 2 },
    );

    expect(assign({ config: global, handoffs: chain(2) }).reason).toBe('handoff_admitted');
    expect(assign({ config: global, handoffs: chain(3) }).reason).toBe('handoff_budget_exhausted');
  });

  it('falls back to the router rather than looping when the budget is spent', () => {
    const global = config(
      { backend: {}, m1: {}, m2: {} },
      { handoffsReassignExecution: true, maxHandoffsPerTask: 1 },
    );

    const assignment = assign({ config: global, handoffs: chain(2) });
    expect(assignment.agentId).toBe('executor.normal');
  });

  it('is decided in one pass, however long the chain', () => {
    // The policy reads the *last* accepted handoff and counts the rest. It does not walk
    // the chain, so a thousand hops cost what two do and no input length is a hang.
    const global = config(
      { backend: {}, ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`m${String(i + 1)}`, {}])) },
      { handoffsReassignExecution: true, maxHandoffsPerTask: 1000 },
    );

    const started = Date.now();
    const assignment = assign({ config: global, handoffs: chain(60) });

    expect(assignment.reason).toBe('handoff_admitted');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
