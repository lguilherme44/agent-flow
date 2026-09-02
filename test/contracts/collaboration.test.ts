import { describe, it, expect } from 'vitest';
import {
  AgentIdSchema,
  AgentIdentitySchema,
  AgentMessageSchema,
  AgentOutboxSchema,
  ARTIFACT_NAMES,
  BLACKBOARD_ENTRY_KINDS,
  BlackboardEntrySchema,
  CollaborationConfigSchema,
  CollaborationReferenceSchema,
  ENTRY_ID_PREFIX,
  GlobalConfigSchema,
  MESSAGE_TYPES,
  MessageRecipientSchema,
  ProposedMessageSchema,
  RESERVED_AGENT_IDS,
} from '../../src/contracts/index.js';

const NOW = '2026-09-01T12:00:00.000Z';

function message(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'MSG-0001',
    runId: 'AF-2026-001',
    threadId: 'THR-0001',
    from: 'executor.normal',
    to: { kind: 'agent', id: 'architect' },
    type: 'question',
    subject: 'Which idempotency key does checkout use?',
    body: 'The SDD names one but does not say where it is generated.',
    createdAt: NOW,
    ...overrides,
  };
}

function entry(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'DEC-001',
    runId: 'AF-2026-001',
    kind: 'decision',
    subject: 'checkout-idempotency',
    author: 'architect',
    statement: 'The idempotency key is minted by the API and echoed by the client.',
    createdAt: NOW,
    ...overrides,
  };
}

describe('AgentId', () => {
  it('accepts the role vocabulary verbatim, dots and camelCase included', () => {
    // The derived roster uses role names as agent ids. A second spelling for
    // `planReviewer` would make the two disagree the first time somebody read one
    // and wrote the other — which is exactly what a lowercase-only rule forced in
    // the first draft of this schema.
    for (const id of [
      'architect',
      'executor.normal',
      'planReviewer',
      'finalReviewer',
      'plan-reviewer',
      'frontend',
    ]) {
      expect(AgentIdSchema.parse(id)).toBe(id);
    }
  });

  it('rejects anything that could express a path, a shell or a newline', () => {
    for (const hostile of [
      '../etc/passwd',
      'a/b',
      'agent id',
      'agent;rm -rf /',
      'agent\nid',
      '',
      '.hidden',
      '-leading',
      'trailing-',
    ]) {
      expect(AgentIdSchema.safeParse(hostile).success, hostile).toBe(false);
    }
  });

  it('rejects an id that only differs from another by its first letter’s case', () => {
    // `Architect` and `architect` must not both exist and mean one agent.
    expect(AgentIdSchema.safeParse('Architect').success).toBe(false);
  });

  it('reserves exactly two ids that are not derived from configuration', () => {
    expect([...RESERVED_AGENT_IDS]).toEqual(['human', 'orchestrator']);
    for (const id of RESERVED_AGENT_IDS) expect(AgentIdSchema.safeParse(id).success).toBe(true);
  });
});

describe('AgentIdentity', () => {
  it('carries id and role as separate fields', () => {
    // The whole of M5's forward compatibility. A member called `frontend` serving
    // `executor.normal` must be expressible before teams exist, or every message
    // written under M4 would have to be rewritten when they do.
    const parsed = AgentIdentitySchema.parse({
      id: 'frontend',
      displayName: 'Frontend',
      role: 'executor.normal',
      runner: 'claude',
    });

    expect(parsed.id).toBe('frontend');
    expect(parsed.role).toBe('executor.normal');
    expect(parsed.skills).toEqual([]);
  });
});

describe('CollaborationReference (I-29)', () => {
  it('accepts one shape per thing Agent Flow already knows about', () => {
    const accepted = [
      { kind: 'task', id: 'TASK-003' },
      { kind: 'task', id: 'FIX-001' },
      { kind: 'artifact', id: 'sdd' },
      { kind: 'file', id: 'src/core/dag.ts' },
      { kind: 'attempt', id: 'TASK-003#2' },
      { kind: 'entry', id: 'DEC-001' },
      { kind: 'message', id: 'MSG-0007' },
    ];

    for (const reference of accepted) {
      expect(CollaborationReferenceSchema.safeParse(reference).success, reference.id).toBe(true);
    }
  });

  it('validates a file reference with the ContextPacket path rule, not a second one', () => {
    // A second implementation of "reject absolute, `..`, percent-encoded traversal,
    // URL schemes, drive letters, UNC shares, control characters, .git and
    // .agent-flow" is a second chance to miss one of them.
    for (const hostile of [
      '/etc/passwd',
      '../../secrets.env',
      'src/../../outside.ts',
      'C:\\Windows\\System32',
      '//server/share/file',
      'file:///etc/passwd',
      '%2e%2e/%2e%2e/etc/passwd',
      '.git/config',
      '.agent-flow/config.yaml',
    ]) {
      const parsed = CollaborationReferenceSchema.safeParse({ kind: 'file', id: hostile });
      expect(parsed.success, hostile).toBe(false);
    }
  });

  it('accepts only artifact names the run can actually produce', () => {
    for (const name of ARTIFACT_NAMES) {
      expect(CollaborationReferenceSchema.safeParse({ kind: 'artifact', id: name }).success).toBe(
        true,
      );
    }
    expect(
      CollaborationReferenceSchema.safeParse({ kind: 'artifact', id: 'anything' }).success,
    ).toBe(false);
  });

  it('refuses a kind nobody declared', () => {
    expect(
      CollaborationReferenceSchema.safeParse({ kind: 'url', id: 'https://example.test' }).success,
    ).toBe(false);
  });
});

describe('MessageRecipient', () => {
  it('discriminates rather than reserving a string prefix', () => {
    expect(MessageRecipientSchema.safeParse({ kind: 'agent', id: 'architect' }).success).toBe(true);
    expect(MessageRecipientSchema.safeParse({ kind: 'role', role: 'planner' }).success).toBe(true);
    expect(MessageRecipientSchema.safeParse({ kind: 'everyone' }).success).toBe(true);
  });

  it('rejects a role that is not a workflow role', () => {
    expect(MessageRecipientSchema.safeParse({ kind: 'role', role: 'frontend' }).success).toBe(false);
  });
});

describe('AgentMessage', () => {
  it('round-trips a well-formed message', () => {
    const parsed = AgentMessageSchema.parse(message());
    expect(parsed.threadId).toBe('THR-0001');
    expect(parsed.references).toEqual([]);
    expect(parsed.truncated).toBe(false);
  });

  it('covers every declared type', () => {
    for (const type of MESSAGE_TYPES) {
      const directed = type.startsWith('handoff_');
      const parsed = AgentMessageSchema.safeParse(
        message({ type, ...(directed ? { taskId: 'TASK-001' } : {}) }),
      );
      expect(parsed.success, type).toBe(true);
    }
  });

  it('requires a handoff to name one agent and one task', () => {
    // Addressed to a role, a handoff is an announcement: the projection would have
    // to guess which agent it bound, and guessing is what §4.5 removes.
    for (const to of [{ kind: 'role', role: 'planner' }, { kind: 'everyone' }]) {
      const parsed = AgentMessageSchema.safeParse(
        message({ type: 'handoff_request', taskId: 'TASK-001', to }),
      );
      expect(parsed.success).toBe(false);
    }

    const noTask = AgentMessageSchema.safeParse(message({ type: 'handoff_request' }));
    expect(noTask.success).toBe(false);
  });

  it('rejects an empty body and an empty subject', () => {
    expect(AgentMessageSchema.safeParse(message({ body: '' })).success).toBe(false);
    expect(AgentMessageSchema.safeParse(message({ subject: '' })).success).toBe(false);
  });
});

describe('ProposedMessage — what an agent is allowed to write (I-28)', () => {
  it('has no sender field at all, so a forged one is discarded by the parse', () => {
    const parsed = ProposedMessageSchema.parse({
      from: 'architect',
      to: { kind: 'agent', id: 'architect' },
      type: 'question',
      subject: 'Which key?',
      body: 'asking',
    });

    expect(parsed).not.toHaveProperty('from');
  });

  it('has no id, thread, run or timestamp either', () => {
    const parsed = ProposedMessageSchema.parse({
      id: 'MSG-9999',
      threadId: 'THR-9999',
      runId: 'AF-2099-999',
      createdAt: '1999-01-01T00:00:00.000Z',
      truncated: true,
      to: { kind: 'everyone' },
      type: 'information',
      subject: 'note',
      body: 'body',
    });

    for (const stolen of ['id', 'threadId', 'runId', 'createdAt', 'truncated']) {
      expect(parsed, stolen).not.toHaveProperty(stolen);
    }
  });
});

describe('BlackboardEntry', () => {
  it('covers every kind, each with its own id prefix', () => {
    for (const kind of BLACKBOARD_ENTRY_KINDS) {
      const id = `${ENTRY_ID_PREFIX[kind]}-001`;
      expect(BlackboardEntrySchema.safeParse(entry({ kind, id })).success, kind).toBe(true);
    }
  });

  it('refuses an id whose prefix disagrees with its kind', () => {
    // `DEC-004` cited from a message would otherwise resolve to a risk, and nothing
    // downstream would notice.
    expect(BlackboardEntrySchema.safeParse(entry({ kind: 'risk', id: 'DEC-001' })).success).toBe(
      false,
    );
  });

  it('refuses an entry that supersedes itself', () => {
    expect(
      BlackboardEntrySchema.safeParse(entry({ id: 'DEC-002', supersedes: 'DEC-002' })).success,
    ).toBe(false);
  });

  it('defaults affects to empty, which means everyone', () => {
    expect(BlackboardEntrySchema.parse(entry()).affects).toEqual([]);
  });
});

describe('AgentOutbox', () => {
  it('accepts an outbox with nothing in it', () => {
    // An agent that had nothing to say should not get an error for saying so.
    const parsed = AgentOutboxSchema.parse({});
    expect(parsed.messages).toEqual([]);
    expect(parsed.entries).toEqual([]);
  });

  it('parses messages and entries together', () => {
    const parsed = AgentOutboxSchema.parse({
      messages: [{ to: { kind: 'everyone' }, type: 'finding', subject: 's', body: 'b' }],
      entries: [{ kind: 'discovery', subject: 'retry-backoff', statement: 'it is exponential' }],
    });

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.entries).toHaveLength(1);
  });
});

describe('CollaborationConfig', () => {
  it('is entirely defaulted, and ships off', () => {
    const parsed = CollaborationConfigSchema.parse({});
    expect(parsed.enabled).toBe(false);
    expect(parsed.handoffsReassignExecution).toBe(false);
  });

  it('gives a run bounds even when the operator names none', () => {
    const parsed = CollaborationConfigSchema.parse({});
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'number') continue;
      expect(value, key).toBeGreaterThan(0);
    }
  });

  it('appears on a GlobalConfig that never mentioned it', () => {
    // M4's whole migration story: a config.yaml written before the milestone parses
    // unchanged and gains bounds it can then be trusted to honour.
    const global = GlobalConfigSchema.parse({
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
        finalReviewer: { runner: 'claude', effort: 'high' },
      },
    });

    expect(global.collaboration.enabled).toBe(false);
    expect(global.collaboration.maxMessagesPerTask).toBe(12);
  });
});
