import { describe, it, expect } from 'vitest';
import {
  ContextPacketSchema,
  validateContextPacket,
  validateAndNormalizeRepositoryPath,
  DEFAULT_CONTEXT_PACKET_BUDGET,
  type ContextPacketBudget,
  type ContextPacketTrustContext,
  toJsonSchema,
} from '../../src/contracts/index.js';

describe('ContextPacket Contract & Validator (M3-03)', () => {
  const minimalValid = {
    objective: 'Implement ContextPacket contract validation',
    relevantFiles: [],
    relevantSymbols: [],
    constraints: [],
    architectureNotes: [],
    risks: [],
    evidence: [],
  };

  const fullyPopulatedValid = {
    taskId: 'TASK-001',
    objective: 'Implement comprehensive context packing for compiler tasks',
    relevantFiles: [
      { path: 'src/contracts/context-packet.schema.ts', reason: 'Defines schema and validation' },
      { path: './src/contracts/index.ts', reason: 'Exports contract from barrel' },
    ],
    relevantSymbols: [
      {
        symbol: 'validateContextPacket',
        path: 'src/contracts/context-packet.schema.ts',
        reason: 'Main validator entry point',
      },
    ],
    constraints: ['Must be provider-neutral', 'Must not import shell or git'],
    architectureNotes: ['ContextPacket is advisory context, never truth'],
    risks: ['Untrusted model paths could attempt directory traversal'],
    evidence: [
      { kind: 'file' as const, id: 'src/contracts/context-packet.schema.ts' },
      { kind: 'log' as const, id: 'validation/task-1/test.log' },
    ],
  };

  describe('1. Valid Packet & Minimal Boundaries', () => {
    it('validates minimal valid packet without taskId', () => {
      const result = validateContextPacket(minimalValid);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.packet.taskId).toBeUndefined();
      expect(result.packet.objective).toBe('Implement ContextPacket contract validation');
      expect(result.packet.relevantFiles).toEqual([]);
      expect(result.packet.relevantSymbols).toEqual([]);
      expect(result.packet.constraints).toEqual([]);
      expect(result.packet.architectureNotes).toEqual([]);
      expect(result.packet.risks).toEqual([]);
      expect(result.packet.evidence).toEqual([]);
    });

    it('validates fully populated packet and normalizes relative paths', () => {
      const result = validateContextPacket(fullyPopulatedValid);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.packet.taskId).toBe('TASK-001');
      expect(result.packet.relevantFiles[0]?.path).toBe('src/contracts/context-packet.schema.ts');
      expect(result.packet.relevantFiles[1]?.path).toBe('src/contracts/index.ts');
      expect(result.packet.relevantSymbols[0]?.symbol).toBe('validateContextPacket');
      expect(result.packet.constraints).toHaveLength(2);
      expect(result.packet.evidence).toHaveLength(2);
    });

    it('validates JSON Schema derivation via toJsonSchema (AD-08)', () => {
      const jsonSchema = toJsonSchema(ContextPacketSchema);
      expect(jsonSchema['type']).toBe('object');
      expect(Object.keys(jsonSchema['properties'] as object)).toContain('objective');
      expect(Object.keys(jsonSchema['properties'] as object)).toContain('relevantFiles');
      expect(jsonSchema).not.toHaveProperty('$schema');
    });
  });

  describe('2. Shape & Type Invalidation', () => {
    it('rejects non-object inputs (null, undefined, primitives, arrays)', () => {
      for (const bad of [null, undefined, 'string', 123, true, [], [1, 2, 3]]) {
        const result = validateContextPacket(bad);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.issues[0]?.code).toBe('invalid_type');
      }
    });

    it('rejects missing objective', () => {
      const { objective: _dropped, ...rest } = minimalValid;
      const result = validateContextPacket(rest);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.some((i) => i.code === 'missing_field' && i.path === 'objective')).toBe(
        true,
      );
    });

    it('rejects missing required arrays', () => {
      for (const field of [
        'relevantFiles',
        'relevantSymbols',
        'constraints',
        'architectureNotes',
        'risks',
        'evidence',
      ] as const) {
        const copy = { ...minimalValid };
        delete (copy as Record<string, unknown>)[field];
        const result = validateContextPacket(copy);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.issues.some((i) => i.code === 'missing_field' && i.path === field)).toBe(
          true,
        );
      }
    });

    it('rejects invalid nested entry types in arrays', () => {
      const bad = {
        ...minimalValid,
        relevantFiles: ['not-an-object'],
        relevantSymbols: [123],
        constraints: [null],
        evidence: ['invalid'],
      };
      const result = validateContextPacket(bad);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.some((i) => i.code === 'invalid_type')).toBe(true);
    });

    it('rejects invalid evidence kind', () => {
      const bad = {
        ...minimalValid,
        evidence: [{ kind: 'unsupported_kind', id: 'some-id' }],
      };
      const result = validateContextPacket(bad);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.some((i) => i.code === 'invalid_evidence_kind')).toBe(true);
    });
  });

  describe('3. Unknown Field Policy (Strict Object Parsing)', () => {
    it('rejects unknown top-level properties', () => {
      const input = {
        ...minimalValid,
        injectedExecutablePayload: 'rm -rf /',
        unexpectedMeta: 42,
      };
      const result = validateContextPacket(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.issues.some(
          (i) => i.code === 'unknown_field' && i.path === 'injectedExecutablePayload',
        ),
      ).toBe(true);
    });

    it('rejects unknown properties in nested relevantFiles, relevantSymbols, evidence', () => {
      const input = {
        ...minimalValid,
        relevantFiles: [{ path: 'src/a.ts', reason: 'ok', extraBogus: true }],
        relevantSymbols: [{ symbol: 'foo', path: 'src/a.ts', reason: 'ok', ASTDump: {} }],
        evidence: [{ kind: 'file', id: 'src/a.ts', content: 'dangerous raw bytes' }],
      };
      const result = validateContextPacket(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.issues.some(
          (i) => i.code === 'unknown_field' && i.path === 'relevantFiles[0].extraBogus',
        ),
      ).toBe(true);
      expect(
        result.issues.some(
          (i) => i.code === 'unknown_field' && i.path === 'relevantSymbols[0].ASTDump',
        ),
      ).toBe(true);
      expect(
        result.issues.some(
          (i) => i.code === 'unknown_field' && i.path === 'evidence[0].content',
        ),
      ).toBe(true);
    });
  });

  describe('4. Prototype Pollution Safety', () => {
    it('rejects objects containing dangerous prototype keys at root', () => {
      const hostile = JSON.parse(
        '{"__proto__": {"polluted": true}, "objective": "test", "relevantFiles": [], "relevantSymbols": [], "constraints": [], "architectureNotes": [], "risks": [], "evidence": []}',
      );
      const result = validateContextPacket(hostile);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.some((i) => i.code === 'prototype_pollution')).toBe(true);
      expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('rejects nested objects containing dangerous prototype keys', () => {
      const hostileNested = JSON.parse(
        '{"objective": "test", "relevantFiles": [{"__proto__": {"polluted": true}, "path": "src/a.ts", "reason": "ok"}], "relevantSymbols": [], "constraints": [], "architectureNotes": [], "risks": [], "evidence": []}',
      );
      const result = validateContextPacket(hostileNested);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.some((i) => i.code === 'prototype_pollution')).toBe(true);
      expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  describe('5. String Fields & Unicode Bounds', () => {
    it('rejects empty or whitespace-only objective', () => {
      for (const empty of ['', '   ', '\t\n ']) {
        const result = validateContextPacket({ ...minimalValid, objective: empty });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.issues.some((i) => i.code === 'invalid_string_length')).toBe(true);
      }
    });

    it('handles Unicode, emoji, and embedded newlines safely', () => {
      const unicodeValid = {
        ...minimalValid,
        objective: 'Objetivo: Validar ContextPacket com caracteres UTF-8: 🚀, á, é, ç, 日本語\nLinha 2.',
        constraints: ['Restrição: Apenas UTF-8 válido ✨'],
      };
      const result = validateContextPacket(unicodeValid);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.packet.objective).toContain('🚀');
      expect(result.packet.objective).toContain('日本語');
    });

    it('enforces string length budgets (objective, reason, constraints, etc.)', () => {
      const customBudget: Partial<ContextPacketBudget> = {
        maxObjectiveLength: 50,
        maxStringLength: 30,
      };

      // Exact budget
      const exactObj = 'A'.repeat(50);
      expect(
        validateContextPacket({ ...minimalValid, objective: exactObj }, { budget: customBudget }).ok,
      ).toBe(true);

      // Exceeded budget
      const overflowObj = 'A'.repeat(51);
      const res = validateContextPacket(
        { ...minimalValid, objective: overflowObj },
        { budget: customBudget },
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.issues.some((i) => i.code === 'budget_exceeded' && i.path === 'objective')).toBe(
        true,
      );
    });
  });

  describe('6. Array Budgets & Exact Boundaries', () => {
    const customBudget: ContextPacketBudget = {
      ...DEFAULT_CONTEXT_PACKET_BUDGET,
      maxRelevantFiles: 2,
      maxRelevantSymbols: 2,
      maxConstraints: 2,
      maxArchitectureNotes: 2,
      maxRisks: 2,
      maxEvidenceReferences: 2,
    };

    it('accepts array length at limit - 1, and limit', () => {
      const atLimit = {
        ...minimalValid,
        constraints: ['Constraint 1', 'Constraint 2'],
        architectureNotes: ['Note 1', 'Note 2'],
        risks: ['Risk 1', 'Risk 2'],
      };
      const res = validateContextPacket(atLimit, { budget: customBudget });
      expect(res.ok).toBe(true);
    });

    it('rejects array length at limit + 1', () => {
      const overLimit = {
        ...minimalValid,
        constraints: ['Constraint 1', 'Constraint 2', 'Constraint 3'],
      };
      const res = validateContextPacket(overLimit, { budget: customBudget });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.issues.some((i) => i.code === 'budget_exceeded' && i.path === 'constraints')).toBe(
        true,
      );
    });

    it('enforces total character budget', () => {
      const tinyBudget: Partial<ContextPacketBudget> = {
        maxTotalCharacters: 100,
      };
      const largeContent = {
        ...minimalValid,
        objective: 'A'.repeat(80),
        constraints: ['B'.repeat(30)],
      };
      const res = validateContextPacket(largeContent, { budget: tinyBudget });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.issues.some((i) => i.code === 'budget_exceeded' && i.path === '(root)')).toBe(true);
    });
  });

  describe('7. Path Validation & Security Rules', () => {
    it('normalizes valid relative paths across OS styles', () => {
      const cases = [
        ['src/foo.ts', 'src/foo.ts'],
        ['./src/foo.ts', 'src/foo.ts'],
        ['src/./foo.ts', 'src/foo.ts'],
        ['src//foo.ts', 'src/foo.ts'],
        ['src\\foo.ts', 'src/foo.ts'],
        ['src\\nested\\..\\foo.ts', 'src/foo.ts'],
      ] as const;

      for (const [raw, expected] of cases) {
        const outcome = validateAndNormalizeRepositoryPath(raw);
        expect(outcome.valid, `failed for ${raw}`).toBe(true);
        expect(outcome.normalizedPath).toBe(expected);
      }
    });

    it('rejects directory traversal attacks', () => {
      const traversalAttacks = [
        '../secret',
        '../../etc/passwd',
        'src/../../secret',
        'src/foo/../../../etc/shadow',
        '..\\..\\secret',
        '%2e%2e/secret',
        '%2E%2E/secret',
      ];

      for (const attack of traversalAttacks) {
        const outcome = validateAndNormalizeRepositoryPath(attack);
        expect(outcome.valid, `attack ${attack} should be rejected`).toBe(false);
      }
    });

    it('rejects absolute paths (Unix, Windows, UNC, URLs)', () => {
      const absoluteAttacks = [
        '/etc/passwd',
        '/root/.ssh/id_rsa',
        'C:\\Windows\\System32',
        'c:/secret.txt',
        'D:\\data',
        '\\\\server\\share',
        '//server/share',
        'file:///etc/passwd',
        'http://evil.com/payload',
      ];

      for (const attack of absoluteAttacks) {
        const outcome = validateAndNormalizeRepositoryPath(attack);
        expect(outcome.valid, `absolute path ${attack} should be rejected`).toBe(false);
      }
    });

    it('rejects internal forbidden repository paths (.git, .agent-flow)', () => {
      const forbidden = [
        '.git',
        '.git/config',
        '.git/HEAD',
        '.git\\config',
        '.agent-flow',
        '.agent-flow/state.json',
        '.agent-flow/private-key',
        './.git/config',
        './.agent-flow/state.json',
      ];

      for (const f of forbidden) {
        const outcome = validateAndNormalizeRepositoryPath(f);
        expect(outcome.valid, `forbidden path ${f} should be rejected`).toBe(false);
        expect(outcome.code).toBe('path_forbidden');
      }
    });

    it('rejects NUL bytes and control characters in paths', () => {
      const outcome = validateAndNormalizeRepositoryPath('src/foo\0.ts');
      expect(outcome.valid).toBe(false);
    });

    it('rejects duplicate normalized paths in relevantFiles (including aliases)', () => {
      const input = {
        ...minimalValid,
        relevantFiles: [
          { path: 'src/foo.ts', reason: 'First' },
          { path: './src/foo.ts', reason: 'Duplicate alias' },
        ],
      };
      const res = validateContextPacket(input);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.issues.some((i) => i.code === 'duplicate_entry')).toBe(true);
    });

    it('rejects duplicate symbols in relevantSymbols', () => {
      const input = {
        ...minimalValid,
        relevantSymbols: [
          { symbol: 'MyClass', path: 'src/a.ts', reason: 'First' },
          { symbol: 'MyClass', path: './src/a.ts', reason: 'Duplicate' },
        ],
      };
      const res = validateContextPacket(input);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.issues.some((i) => i.code === 'duplicate_entry')).toBe(true);
    });
  });

  describe('8. Trusted Path Authority Boundary', () => {
    const trustedSet = new Set(['src/contracts/index.ts', 'src/core/router.ts']);
    const trustCtx: ContextPacketTrustContext = {
      allowedPaths: trustedSet,
    };

    it('accepts files and symbols when paths are in trusted authority', () => {
      const input = {
        ...minimalValid,
        relevantFiles: [{ path: 'src/contracts/index.ts', reason: 'Trusted file' }],
        relevantSymbols: [
          { symbol: 'router', path: 'src/core/router.ts', reason: 'Trusted symbol path' },
        ],
      };
      const res = validateContextPacket(input, { trust: trustCtx });
      expect(res.ok).toBe(true);
    });

    it('rejects model-invented safe-looking paths not in trusted authority', () => {
      const input = {
        ...minimalValid,
        relevantFiles: [
          { path: 'src/looks-legit-but-does-not-exist.ts', reason: 'Model hallucination' },
        ],
      };
      const res = validateContextPacket(input, { trust: trustCtx });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(
        res.issues.some(
          (i) => i.code === 'path_not_allowed' && i.path === 'relevantFiles[0].path',
        ),
      ).toBe(true);
    });

    it('fails closed when requireTrustedPaths is true and no authority is provided', () => {
      const input = {
        ...minimalValid,
        relevantFiles: [{ path: 'src/contracts/index.ts', reason: 'Some file' }],
      };
      const res = validateContextPacket(input, { trust: { requireTrustedPaths: true } });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.issues.some((i) => i.code === 'path_not_allowed')).toBe(true);
    });
  });

  describe('9. Evidence References & Authority Boundary', () => {
    const trustedEvidence = new Set(['log:validation/task-1/test.log', 'artifact:sdd']);
    const trustCtx: ContextPacketTrustContext = {
      allowedEvidence: trustedEvidence,
    };

    it('accepts evidence references in trusted authority', () => {
      const input = {
        ...minimalValid,
        evidence: [
          { kind: 'log' as const, id: 'validation/task-1/test.log' },
          { kind: 'artifact' as const, id: 'sdd' },
        ],
      };
      const res = validateContextPacket(input, { trust: trustCtx });
      expect(res.ok).toBe(true);
    });

    it('rejects model-invented evidence IDs not in trusted authority', () => {
      const input = {
        ...minimalValid,
        evidence: [{ kind: 'artifact' as const, id: 'artifact-that-never-existed' }],
      };
      const res = validateContextPacket(input, { trust: trustCtx });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.issues.some((i) => i.code === 'evidence_not_allowed')).toBe(true);
    });

    it('rejects duplicate evidence references', () => {
      const input = {
        ...minimalValid,
        evidence: [
          { kind: 'log' as const, id: 'test.log' },
          { kind: 'log' as const, id: 'test.log' },
        ],
      };
      const res = validateContextPacket(input);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.issues.some((i) => i.code === 'duplicate_entry')).toBe(true);
    });

    it('rejects empty or whitespace evidence id', () => {
      for (const empty of ['', '   ']) {
        const input = {
          ...minimalValid,
          evidence: [{ kind: 'file' as const, id: empty }],
        };
        const res = validateContextPacket(input);
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.issues.some((i) => i.code === 'invalid_evidence_id')).toBe(true);
      }
    });

    it('fails closed when requireTrustedEvidence is true with no authority', () => {
      const input = {
        ...minimalValid,
        evidence: [{ kind: 'artifact' as const, id: 'sdd' }],
      };
      const res = validateContextPacket(input, { trust: { requireTrustedEvidence: true } });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.issues.some((i) => i.code === 'evidence_not_allowed')).toBe(true);
    });
  });

  describe('10. Mutation Isolation & Immutability', () => {
    it('protects validated packet from post-validation mutations of raw input', () => {
      const raw = {
        objective: 'Original objective',
        relevantFiles: [{ path: 'src/a.ts', reason: 'Original reason' }],
        relevantSymbols: [{ symbol: 'OriginalSym', path: 'src/a.ts', reason: 'Original reason' }],
        constraints: ['Original constraint'],
        architectureNotes: ['Original note'],
        risks: ['Original risk'],
        evidence: [{ kind: 'log' as const, id: 'test.log' }],
      };

      const result = validateContextPacket(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Mutate raw input object
      raw.objective = 'MUTATED OBJECTIVE';
      raw.relevantFiles[0]!.path = 'src/MUTATED.ts';
      raw.relevantFiles.push({ path: 'src/INJECTED.ts', reason: 'injected' });
      raw.constraints.push('INJECTED CONSTRAINT');

      // Validated packet must remain unchanged
      expect(result.packet.objective).toBe('Original objective');
      expect(result.packet.relevantFiles[0]?.path).toBe('src/a.ts');
      expect(result.packet.relevantFiles).toHaveLength(1);
      expect(result.packet.constraints).toEqual(['Original constraint']);
    });

    it('freezes validated packet and its nested structures', () => {
      const result = validateContextPacket(fullyPopulatedValid);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(Object.isFrozen(result.packet)).toBe(true);
      expect(Object.isFrozen(result.packet.relevantFiles)).toBe(true);
      expect(Object.isFrozen(result.packet.relevantFiles[0])).toBe(true);
      expect(Object.isFrozen(result.packet.relevantSymbols)).toBe(true);
      expect(Object.isFrozen(result.packet.constraints)).toBe(true);
      expect(Object.isFrozen(result.packet.architectureNotes)).toBe(true);
      expect(Object.isFrozen(result.packet.risks)).toBe(true);
      expect(Object.isFrozen(result.packet.evidence)).toBe(true);
      expect(Object.isFrozen(result.packet.evidence[0])).toBe(true);
    });
  });

  describe('11. Determinism, Idempotence & Serialization', () => {
    it('is idempotent: validate(validatedPacket) produces valid equivalent packet', () => {
      const first = validateContextPacket(fullyPopulatedValid);
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const second = validateContextPacket(first.packet);
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      expect(second.packet).toEqual(first.packet);
    });

    it('round-trips safely via JSON.stringify and JSON.parse', () => {
      const result = validateContextPacket(fullyPopulatedValid);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const serialized = JSON.stringify(result.packet);
      const parsed = JSON.parse(serialized);
      const revalidated = validateContextPacket(parsed);
      expect(revalidated.ok).toBe(true);
      if (!revalidated.ok) return;
      expect(revalidated.packet).toEqual(result.packet);
    });

    it('is purely deterministic: same input produces identical issue codes and ordering', () => {
      const invalidInput = {
        objective: '',
        relevantFiles: [{ path: '../traversal', reason: '' }],
        evidence: [{ kind: 'invalid', id: '' }],
      };

      const res1 = validateContextPacket(invalidInput);
      const res2 = validateContextPacket(invalidInput);

      expect(res1.ok).toBe(false);
      expect(res2.ok).toBe(false);
      if (res1.ok || res2.ok) return;

      expect(res1.issues).toEqual(res2.issues);
    });
  });

  describe('12. Adversarial & Pathological Inputs', () => {
    it('rejects giant inputs exceeding structural budgets promptly', () => {
      const massiveFiles = Array.from({ length: 200 }, (_, i) => ({
        path: `src/file_${i}.ts`,
        reason: 'Reason '.repeat(100),
      }));

      const giantPacket = {
        objective: 'Massive candidate packet',
        relevantFiles: massiveFiles,
        relevantSymbols: [],
        constraints: [],
        architectureNotes: [],
        risks: [],
        evidence: [],
      };

      const result = validateContextPacket(giantPacket);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.some((i) => i.code === 'budget_exceeded')).toBe(true);
    });
  });

  describe('13. Trust Predicate Attacks & Resilience', () => {
    it('fails closed when an async predicate returns a Promise (prevents truthy Promise bypass)', () => {
      const asyncFalsePredicate = async () => false;
      const input = {
        ...minimalValid,
        relevantFiles: [{ path: 'src/a.ts', reason: 'Some file' }],
      };
      // Runtime cast of async predicate
      const res = validateContextPacket(input, {
        trust: { allowedPaths: asyncFalsePredicate as unknown as (p: string) => boolean },
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.issues.some((i) => i.code === 'path_not_allowed')).toBe(true);
    });

    it('fails closed when an evidence predicate returns an async Promise', () => {
      const asyncFalseEvidence = async () => false;
      const input = {
        ...minimalValid,
        evidence: [{ kind: 'file' as const, id: 'src/a.ts' }],
      };
      const res = validateContextPacket(input, {
        trust: { allowedEvidence: asyncFalseEvidence as unknown as (r: unknown) => boolean },
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.issues.some((i) => i.code === 'evidence_not_allowed')).toBe(true);
    });

    it('fails closed when a trust predicate throws an Error or string', () => {
      const throwingPredicate = () => {
        throw new Error('Database disconnected');
      };
      const input = {
        ...minimalValid,
        relevantFiles: [{ path: 'src/a.ts', reason: 'Some file' }],
      };
      const res = validateContextPacket(input, {
        trust: { allowedPaths: throwingPredicate },
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.issues.some((i) => i.code === 'path_not_allowed')).toBe(true);
    });

    it('matches normalized aliases inside allowedPaths sets and arrays', () => {
      const unnormalizedAuthority = new Set(['./src/contracts/index.ts']);
      const input = {
        ...minimalValid,
        relevantFiles: [{ path: 'src/contracts/index.ts', reason: 'Match' }],
      };
      const res = validateContextPacket(input, {
        trust: { allowedPaths: unnormalizedAuthority },
      });
      expect(res.ok).toBe(true);
    });

    it('ensures intrinsic path safety rules cannot be overridden by malformed allowedPaths', () => {
      const hostileAuthority = new Set(['../secret', '/etc/passwd']);
      const input = {
        ...minimalValid,
        relevantFiles: [{ path: '../secret', reason: 'Traversal' }],
      };
      const res = validateContextPacket(input, {
        trust: { allowedPaths: hostileAuthority },
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.issues.some((i) => i.code === 'invalid_path')).toBe(true);
    });
  });

  describe('14. Custom Budget Sanitization Attacks', () => {
    it('sanitizes NaN, negative, Infinity, undefined, and non-numeric custom budgets to safe defaults', () => {
      const malformedBudget = {
        maxRelevantFiles: NaN,
        maxRelevantSymbols: -5,
        maxConstraints: Infinity,
        maxArchitectureNotes: undefined,
        maxRisks: '20' as unknown as number,
      };

      const input = {
        ...minimalValid,
        relevantFiles: Array.from({ length: 60 }, (_, i) => ({
          path: `src/file_${i}.ts`,
          reason: 'Reason',
        })),
      };

      // NaN should NOT disable the default 50 limit!
      const res = validateContextPacket(input, { budget: malformedBudget });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.issues.some((i) => i.code === 'budget_exceeded' && i.path === 'relevantFiles')).toBe(
        true,
      );
    });

    it('accepts zero as a valid strict budget constraint', () => {
      const zeroBudget = {
        maxConstraints: 0,
      };
      const emptyOk = validateContextPacket(minimalValid, { budget: zeroBudget });
      expect(emptyOk.ok).toBe(true);

      const oneConstraint = {
        ...minimalValid,
        constraints: ['Constraint 1'],
      };
      const failOne = validateContextPacket(oneConstraint, { budget: zeroBudget });
      expect(failOne.ok).toBe(false);
      if (failOne.ok) return;
      expect(failOne.issues.some((i) => i.code === 'budget_exceeded' && i.path === 'constraints')).toBe(
        true,
      );
    });
  });

  describe('15. Runtime Adversarial Objects (Getters, Cycles, Sparse, Null Proto)', () => {
    it('handles adversarial throwing property getters safely without crashing', () => {
      const hostileObj: Record<string, unknown> = { ...minimalValid };
      Object.defineProperty(hostileObj, 'objective', {
        get() {
          throw new Error('Hostile getter trap');
        },
      });

      const res = validateContextPacket(hostileObj);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.issues.some((i) => i.code === 'invalid_type')).toBe(true);
    });

    it('rejects circular object references safely without infinite recursion', () => {
      const cyclic: Record<string, unknown> = { ...minimalValid };
      cyclic['self'] = cyclic;

      const res = validateContextPacket(cyclic);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.issues.some((i) => i.code === 'unknown_field' && i.path === 'self')).toBe(true);
    });

    it('rejects sparse arrays in place of dense arrays', () => {
      const sparse = {
        ...minimalValid,
        relevantFiles: new Array(5),
      };

      const res = validateContextPacket(sparse);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.issues.some((i) => i.code === 'invalid_type')).toBe(true);
    });

    it('accepts Object.create(null) dictionary inputs with valid shape', () => {
      const nullProto = Object.create(null);
      nullProto.objective = 'Null prototype object test';
      nullProto.relevantFiles = [];
      nullProto.relevantSymbols = [];
      nullProto.constraints = [];
      nullProto.architectureNotes = [];
      nullProto.risks = [];
      nullProto.evidence = [];

      const res = validateContextPacket(nullProto);
      expect(res.ok).toBe(true);
    });
  });

  describe('16. ContextPacketSchema vs Authoritative Validation Boundary', () => {
    it('demonstrates that ContextPacketSchema only parses shapes while validateContextPacket enforces full security and authority', () => {
      const candidateWithHallucination = {
        objective: 'Test',
        relevantFiles: [{ path: 'src/invented.ts', reason: 'Invented by LLM' }],
        relevantSymbols: [],
        constraints: [],
        architectureNotes: [],
        risks: [],
        evidence: [],
      };

      // Zod schema only checks types (for JSON Schema generation / AD-08)
      const zodParsed = ContextPacketSchema.safeParse(candidateWithHallucination);
      expect(zodParsed.success).toBe(true);

      // Authoritative validator rejects hallucinated path when trust is enforced
      const validated = validateContextPacket(candidateWithHallucination, {
        trust: { requireTrustedPaths: true, allowedPaths: new Set(['src/real.ts']) },
      });
      expect(validated.ok).toBe(false);
    });
  });
});
