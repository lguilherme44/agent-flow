import { z } from 'zod';

/**
 * Canonical Evidence Kinds for ContextPacket (§10, M3-03).
 *
 * A ContextPacket references existing raw evidence (files, diffs, execution logs,
 * or persisted run artifacts). A ContextPacket never contains raw evidence bodies
 * and never replaces raw evidence as a source of truth.
 */
export const EVIDENCE_KINDS = ['file', 'diff', 'log', 'artifact'] as const;

export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * Reference to a relevant repository file with an advisory rationale.
 */
export const RelevantFileSchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1),
});

export interface RelevantFile {
  readonly path: string;
  readonly reason: string;
}

/**
 * Reference to a relevant code symbol and its defining/associated file path.
 */
export const RelevantSymbolSchema = z.object({
  symbol: z.string().min(1),
  path: z.string().min(1),
  reason: z.string().min(1),
});

export interface RelevantSymbol {
  readonly symbol: string;
  readonly path: string;
  readonly reason: string;
}

/**
 * Lightweight reference to an existing evidence record.
 */
export const EvidenceReferenceSchema = z.object({
  kind: EvidenceKindSchema,
  id: z.string().min(1),
});

export interface EvidenceReference {
  readonly kind: EvidenceKind;
  readonly id: string;
}

/**
 * Canonical ContextPacket schema (M3-03).
 *
 * A ContextPacket is selection + compression metadata + advisory context.
 * It is authority-free and provider-neutral.
 */
export const ContextPacketSchema = z.object({
  taskId: z.string().min(1).optional(),
  objective: z.string().min(1),
  relevantFiles: z.array(RelevantFileSchema).default([]),
  relevantSymbols: z.array(RelevantSymbolSchema).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  architectureNotes: z.array(z.string().min(1)).default([]),
  risks: z.array(z.string().min(1)).default([]),
  evidence: z.array(EvidenceReferenceSchema).default([]),
});

export interface ContextPacket {
  readonly taskId?: string;
  readonly objective: string;
  readonly relevantFiles: readonly RelevantFile[];
  readonly relevantSymbols: readonly RelevantSymbol[];
  readonly constraints: readonly string[];
  readonly architectureNotes: readonly string[];
  readonly risks: readonly string[];
  readonly evidence: readonly EvidenceReference[];
}

// ─── Budgets ──────────────────────────────────────────────────────────────────

/**
 * Structural budgets for ContextPacket objects.
 *
 * These govern the packet data structure itself to prevent unbounded memory
 * consumption or pathological model payloads. They are completely separate
 * from UtilityModel context-window and inference token budgets.
 */
export interface ContextPacketBudget {
  readonly maxRelevantFiles: number;
  readonly maxRelevantSymbols: number;
  readonly maxConstraints: number;
  readonly maxArchitectureNotes: number;
  readonly maxRisks: number;
  readonly maxEvidenceReferences: number;
  readonly maxObjectiveLength: number;
  readonly maxStringLength: number;
  readonly maxSymbolLength: number;
  readonly maxPathLength: number;
  readonly maxEvidenceIdLength: number;
  readonly maxTaskIdLength: number;
  readonly maxTotalCharacters: number;
}

export const DEFAULT_CONTEXT_PACKET_BUDGET: ContextPacketBudget = Object.freeze({
  maxRelevantFiles: 50,
  maxRelevantSymbols: 100,
  maxConstraints: 30,
  maxArchitectureNotes: 30,
  maxRisks: 30,
  maxEvidenceReferences: 50,
  maxObjectiveLength: 4000,
  maxStringLength: 2000,
  maxSymbolLength: 200,
  maxPathLength: 500,
  maxEvidenceIdLength: 200,
  maxTaskIdLength: 100,
  maxTotalCharacters: 50000,
});

// ─── Trust Authority Context ──────────────────────────────────────────────────

export type AllowedPathsAuthority =
  | ReadonlySet<string>
  | readonly string[]
  | ((path: string) => boolean);

export type AllowedEvidenceAuthority =
  | ReadonlySet<string>
  | readonly string[]
  | ((ref: EvidenceReference) => boolean);

export interface ContextPacketTrustContext {
  /**
   * Authority source for trusted repository paths.
   * Paths not recognized by this authority are rejected with `path_not_allowed`.
   */
  readonly allowedPaths?: AllowedPathsAuthority;
  /**
   * When true, `allowedPaths` must be provided and every path must match it.
   */
  readonly requireTrustedPaths?: boolean;

  /**
   * Authority source for trusted evidence references.
   * References can match `${kind}:${id}` or `id`, or an evaluator predicate.
   */
  readonly allowedEvidence?: AllowedEvidenceAuthority;
  /**
   * When true, `allowedEvidence` must be provided and every evidence item must match it.
   */
  readonly requireTrustedEvidence?: boolean;
}

// ─── Validation Result & Issues ───────────────────────────────────────────────

export const CONTEXT_PACKET_ISSUE_CODES = [
  'invalid_type',
  'missing_field',
  'unknown_field',
  'invalid_string_length',
  'budget_exceeded',
  'invalid_path',
  'path_not_allowed',
  'path_forbidden',
  'duplicate_entry',
  'invalid_evidence_kind',
  'invalid_evidence_id',
  'evidence_not_allowed',
  'prototype_pollution',
] as const;

export type ContextPacketIssueCode = (typeof CONTEXT_PACKET_ISSUE_CODES)[number];

export interface ContextPacketValidationIssue {
  readonly code: ContextPacketIssueCode;
  readonly path: string;
  readonly message: string;
  readonly received?: unknown;
}

export type ContextPacketValidationResult =
  | {
      readonly ok: true;
      readonly packet: ContextPacket;
    }
  | {
      readonly ok: false;
      readonly issues: readonly ContextPacketValidationIssue[];
    };

export interface ContextPacketValidationOptions {
  readonly budget?: Partial<ContextPacketBudget>;
  readonly trust?: ContextPacketTrustContext;
}

// ─── Deterministic Path Normalization & Validation ───────────────────────────

export interface PathValidationOutcome {
  readonly valid: boolean;
  readonly normalizedPath?: string;
  readonly reason?: string;
  readonly code?: 'invalid_path' | 'path_forbidden';
}

function hasControlCharacters(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

/**
 * Validates and normalizes repository-relative paths without host OS discrepancies.
 *
 * Guarantees:
 * - Reject empty / whitespace paths
 * - Reject NUL and control characters
 * - Reject URL schemes (file://, http://)
 * - Reject Unix absolute paths (/...)
 * - Reject Windows drive letters (C:\..., c:/...)
 * - Reject UNC paths (\\..., //...)
 * - Reject directory traversal (.., ../, foo/../../bar)
 * - Reject percent-encoded traversal (%2e%2e, %2f, %5c)
 * - Reject internal forbidden paths (.git, .agent-flow)
 * - Normalize slashes and redundant segments (./, //)
 */
export function validateAndNormalizeRepositoryPath(rawPath: string): PathValidationOutcome {
  if (typeof rawPath !== 'string') {
    return { valid: false, reason: 'path must be a string', code: 'invalid_path' };
  }
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: 'path must not be empty or whitespace', code: 'invalid_path' };
  }
  // Check NUL bytes or control characters
  if (hasControlCharacters(trimmed)) {
    return { valid: false, reason: 'path must not contain control characters', code: 'invalid_path' };
  }
  // Check for URL schemes e.g. file://, http://
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return { valid: false, reason: 'path must not be a URL scheme', code: 'invalid_path' };
  }
  // Check for Windows drive letters e.g. C: or C:/ or C:\
  if (/^[a-zA-Z]:/.test(trimmed)) {
    return {
      valid: false,
      reason: 'path must not be a Windows absolute path with drive letter',
      code: 'invalid_path',
    };
  }
  // Check for UNC paths e.g. \\server\share or //server/share
  if (trimmed.startsWith('\\\\') || trimmed.startsWith('//')) {
    return { valid: false, reason: 'path must not be a UNC path', code: 'invalid_path' };
  }
  // Check for Unix absolute paths
  if (trimmed.startsWith('/')) {
    return {
      valid: false,
      reason: 'path must be relative to repository root, not absolute',
      code: 'invalid_path',
    };
  }

  // Normalize backslashes to forward slashes
  const converted = trimmed.replace(/\\/g, '/');

  // Split into segments
  const rawSegments = converted.split('/');
  const normalizedSegments: string[] = [];

  for (const seg of rawSegments) {
    if (seg === '' || seg === '.') {
      continue;
    }
    if (seg === '..') {
      if (normalizedSegments.length === 0) {
        return {
          valid: false,
          reason: 'path traversal above repository root is forbidden',
          code: 'invalid_path',
        };
      }
      normalizedSegments.pop();
      continue;
    }
    const lower = seg.toLowerCase();
    if (
      lower === '%2e%2e' ||
      lower.includes('%2e%2e') ||
      lower.includes('%2f') ||
      lower.includes('%5c')
    ) {
      return {
        valid: false,
        reason: 'path contains encoded traversal characters',
        code: 'invalid_path',
      };
    }
    normalizedSegments.push(seg);
  }

  if (normalizedSegments.length === 0) {
    return { valid: false, reason: 'path must not resolve to empty root', code: 'invalid_path' };
  }

  const normalized = normalizedSegments.join('/');

  // Check forbidden internal paths
  const firstSeg = normalizedSegments[0]?.toLowerCase();
  if (firstSeg === '.git') {
    return { valid: false, reason: 'access to .git internal paths is forbidden', code: 'path_forbidden' };
  }
  if (firstSeg === '.agent-flow') {
    return {
      valid: false,
      reason: 'access to .agent-flow internal state paths is forbidden',
      code: 'path_forbidden',
    };
  }

  return { valid: true, normalizedPath: normalized };
}

// ─── Prototype Safety Helpers ─────────────────────────────────────────────────

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function hasDangerousKeys(obj: object): boolean {
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (DANGEROUS_KEYS.has(key)) return true;
  }
  return false;
}

// ─── Deterministic ContextPacket Validator ───────────────────────────────────

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'taskId',
  'objective',
  'relevantFiles',
  'relevantSymbols',
  'constraints',
  'architectureNotes',
  'risks',
  'evidence',
]);

const ALLOWED_FILE_KEYS = new Set(['path', 'reason']);
const ALLOWED_SYMBOL_KEYS = new Set(['symbol', 'path', 'reason']);
const ALLOWED_EVIDENCE_KEYS = new Set(['kind', 'id']);

function isPathAllowed(path: string, authority: AllowedPathsAuthority): boolean {
  if (authority instanceof Set) {
    return authority.has(path);
  }
  if (Array.isArray(authority)) {
    return authority.includes(path);
  }
  if (typeof authority === 'function') {
    return authority(path);
  }
  return false;
}

function isEvidenceAllowed(ref: EvidenceReference, authority: AllowedEvidenceAuthority): boolean {
  if (authority instanceof Set) {
    return authority.has(`${ref.kind}:${ref.id}`) || authority.has(ref.id);
  }
  if (Array.isArray(authority)) {
    return authority.includes(`${ref.kind}:${ref.id}`) || authority.includes(ref.id);
  }
  if (typeof authority === 'function') {
    return authority(ref);
  }
  return false;
}

/**
 * Deterministically validates an unknown candidate payload into an immutable ContextPacket.
 *
 * Enforces:
 * - Pure, deterministic validation
 * - Prototype pollution defense
 * - Strict unknown-property rejection
 * - Configurable structural budgets
 * - Safe path normalization, traversal rejection, and forbidden path denial
 * - Optional trusted path authority enforcement (fail-closed when required)
 * - Evidence reference shape, kind, ID, and optional trusted authority validation
 * - Duplicate rejection for files, symbols, and evidence
 * - Mutation isolation: outputs newly allocated, deeply frozen structures
 */
export function validateContextPacket(
  input: unknown,
  options?: ContextPacketValidationOptions,
): ContextPacketValidationResult {
  const issues: ContextPacketValidationIssue[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      issues: Object.freeze([
        {
          code: 'invalid_type',
          path: '(root)',
          message: 'expected a non-null object',
          received: input,
        },
      ]),
    };
  }

  const rawObj = input as Record<string, unknown>;

  if (hasDangerousKeys(rawObj)) {
    issues.push({
      code: 'prototype_pollution',
      path: '(root)',
      message: 'object contains dangerous prototype keys',
    });
  }

  // Check unknown top-level properties
  for (const key of Object.keys(rawObj)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      issues.push({
        code: 'unknown_field',
        path: key,
        message: `unknown property '${key}' is not allowed on ContextPacket`,
        received: key,
      });
    }
  }

  const budget: ContextPacketBudget = {
    ...DEFAULT_CONTEXT_PACKET_BUDGET,
    ...(options?.budget ?? {}),
  };

  const trust = options?.trust;

  let totalChars = 0;

  // 1. taskId (optional)
  let validatedTaskId: string | undefined = undefined;
  if ('taskId' in rawObj && rawObj.taskId !== undefined) {
    if (typeof rawObj.taskId !== 'string') {
      issues.push({
        code: 'invalid_type',
        path: 'taskId',
        message: 'taskId must be a string if present',
        received: rawObj.taskId,
      });
    } else {
      const trimmedTask = rawObj.taskId.trim();
      if (trimmedTask.length === 0) {
        issues.push({
          code: 'invalid_string_length',
          path: 'taskId',
          message: 'taskId must not be empty or whitespace-only',
          received: rawObj.taskId,
        });
      } else if (trimmedTask.length > budget.maxTaskIdLength) {
        issues.push({
          code: 'budget_exceeded',
          path: 'taskId',
          message: `taskId length (${trimmedTask.length}) exceeds budget (${budget.maxTaskIdLength})`,
          received: trimmedTask.length,
        });
      } else {
        validatedTaskId = trimmedTask;
        totalChars += validatedTaskId.length;
      }
    }
  }

  // 2. objective (required)
  let validatedObjective = '';
  if (!('objective' in rawObj) || rawObj.objective === undefined) {
    issues.push({
      code: 'missing_field',
      path: 'objective',
      message: "missing required field 'objective'",
    });
  } else if (typeof rawObj.objective !== 'string') {
    issues.push({
      code: 'invalid_type',
      path: 'objective',
      message: 'objective must be a string',
      received: rawObj.objective,
    });
  } else {
    const trimmedObj = rawObj.objective.trim();
    if (trimmedObj.length === 0) {
      issues.push({
        code: 'invalid_string_length',
        path: 'objective',
        message: 'objective must not be empty or whitespace-only',
        received: rawObj.objective,
      });
    } else if (trimmedObj.length > budget.maxObjectiveLength) {
      issues.push({
        code: 'budget_exceeded',
        path: 'objective',
        message: `objective length (${trimmedObj.length}) exceeds budget (${budget.maxObjectiveLength})`,
        received: trimmedObj.length,
      });
    } else {
      validatedObjective = trimmedObj;
      totalChars += validatedObjective.length;
    }
  }

  // 3. relevantFiles (required array)
  const validatedFiles: RelevantFile[] = [];
  const seenFilePaths = new Set<string>();

  if (!('relevantFiles' in rawObj) || rawObj.relevantFiles === undefined) {
    issues.push({
      code: 'missing_field',
      path: 'relevantFiles',
      message: "missing required field 'relevantFiles'",
    });
  } else if (!Array.isArray(rawObj.relevantFiles)) {
    issues.push({
      code: 'invalid_type',
      path: 'relevantFiles',
      message: 'relevantFiles must be an array',
      received: rawObj.relevantFiles,
    });
  } else {
    if (rawObj.relevantFiles.length > budget.maxRelevantFiles) {
      issues.push({
        code: 'budget_exceeded',
        path: 'relevantFiles',
        message: `relevantFiles count (${rawObj.relevantFiles.length}) exceeds budget (${budget.maxRelevantFiles})`,
        received: rawObj.relevantFiles.length,
      });
    }

    for (let i = 0; i < rawObj.relevantFiles.length; i++) {
      const item = rawObj.relevantFiles[i];
      const itemPath = `relevantFiles[${i}]`;

      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        issues.push({
          code: 'invalid_type',
          path: itemPath,
          message: 'relevantFiles entry must be a non-null object',
          received: item,
        });
        continue;
      }

      const itemObj = item as Record<string, unknown>;
      if (hasDangerousKeys(itemObj)) {
        issues.push({
          code: 'prototype_pollution',
          path: itemPath,
          message: 'relevantFiles entry contains dangerous prototype keys',
        });
      }

      for (const k of Object.keys(itemObj)) {
        if (!ALLOWED_FILE_KEYS.has(k)) {
          issues.push({
            code: 'unknown_field',
            path: `${itemPath}.${k}`,
            message: `unknown property '${k}' in relevantFiles entry`,
            received: k,
          });
        }
      }

      let filePath = '';
      let fileReason = '';

      // path
      if (!('path' in itemObj) || itemObj.path === undefined) {
        issues.push({
          code: 'missing_field',
          path: `${itemPath}.path`,
          message: 'missing path in relevantFiles entry',
        });
      } else if (typeof itemObj.path !== 'string') {
        issues.push({
          code: 'invalid_type',
          path: `${itemPath}.path`,
          message: 'path must be a string',
          received: itemObj.path,
        });
      } else if (itemObj.path.length > budget.maxPathLength) {
        issues.push({
          code: 'budget_exceeded',
          path: `${itemPath}.path`,
          message: `path length exceeds budget (${budget.maxPathLength})`,
          received: itemObj.path.length,
        });
      } else {
        const pathValidation = validateAndNormalizeRepositoryPath(itemObj.path);
        if (!pathValidation.valid || !pathValidation.normalizedPath) {
          issues.push({
            code: pathValidation.code ?? 'invalid_path',
            path: `${itemPath}.path`,
            message: pathValidation.reason ?? 'invalid repository path',
            received: itemObj.path,
          });
        } else {
          filePath = pathValidation.normalizedPath;

          if (seenFilePaths.has(filePath)) {
            issues.push({
              code: 'duplicate_entry',
              path: `${itemPath}.path`,
              message: `duplicate relevant file path '${filePath}'`,
              received: filePath,
            });
          } else {
            seenFilePaths.add(filePath);
          }

          // Check path authority
          if (trust?.allowedPaths !== undefined) {
            if (!isPathAllowed(filePath, trust.allowedPaths)) {
              issues.push({
                code: 'path_not_allowed',
                path: `${itemPath}.path`,
                message: `path '${filePath}' is not in the trusted allowedPaths authority`,
                received: filePath,
              });
            }
          } else if (trust?.requireTrustedPaths === true) {
            issues.push({
              code: 'path_not_allowed',
              path: `${itemPath}.path`,
              message: `path '${filePath}' rejected: requireTrustedPaths is active with no allowedPaths authority`,
              received: filePath,
            });
          }
        }
      }

      // reason
      if (!('reason' in itemObj) || itemObj.reason === undefined) {
        issues.push({
          code: 'missing_field',
          path: `${itemPath}.reason`,
          message: 'missing reason in relevantFiles entry',
        });
      } else if (typeof itemObj.reason !== 'string') {
        issues.push({
          code: 'invalid_type',
          path: `${itemPath}.reason`,
          message: 'reason must be a string',
          received: itemObj.reason,
        });
      } else {
        const trimmedReason = itemObj.reason.trim();
        if (trimmedReason.length === 0) {
          issues.push({
            code: 'invalid_string_length',
            path: `${itemPath}.reason`,
            message: 'reason must not be empty or whitespace-only',
            received: itemObj.reason,
          });
        } else if (trimmedReason.length > budget.maxStringLength) {
          issues.push({
            code: 'budget_exceeded',
            path: `${itemPath}.reason`,
            message: `reason length (${trimmedReason.length}) exceeds budget (${budget.maxStringLength})`,
            received: trimmedReason.length,
          });
        } else {
          fileReason = trimmedReason;
        }
      }

      if (filePath && fileReason) {
        totalChars += filePath.length + fileReason.length;
        validatedFiles.push(Object.freeze({ path: filePath, reason: fileReason }));
      }
    }
  }

  // 4. relevantSymbols (required array)
  const validatedSymbols: RelevantSymbol[] = [];
  const seenSymbolKeys = new Set<string>();

  if (!('relevantSymbols' in rawObj) || rawObj.relevantSymbols === undefined) {
    issues.push({
      code: 'missing_field',
      path: 'relevantSymbols',
      message: "missing required field 'relevantSymbols'",
    });
  } else if (!Array.isArray(rawObj.relevantSymbols)) {
    issues.push({
      code: 'invalid_type',
      path: 'relevantSymbols',
      message: 'relevantSymbols must be an array',
      received: rawObj.relevantSymbols,
    });
  } else {
    if (rawObj.relevantSymbols.length > budget.maxRelevantSymbols) {
      issues.push({
        code: 'budget_exceeded',
        path: 'relevantSymbols',
        message: `relevantSymbols count (${rawObj.relevantSymbols.length}) exceeds budget (${budget.maxRelevantSymbols})`,
        received: rawObj.relevantSymbols.length,
      });
    }

    for (let i = 0; i < rawObj.relevantSymbols.length; i++) {
      const item = rawObj.relevantSymbols[i];
      const itemPath = `relevantSymbols[${i}]`;

      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        issues.push({
          code: 'invalid_type',
          path: itemPath,
          message: 'relevantSymbols entry must be a non-null object',
          received: item,
        });
        continue;
      }

      const itemObj = item as Record<string, unknown>;
      if (hasDangerousKeys(itemObj)) {
        issues.push({
          code: 'prototype_pollution',
          path: itemPath,
          message: 'relevantSymbols entry contains dangerous prototype keys',
        });
      }

      for (const k of Object.keys(itemObj)) {
        if (!ALLOWED_SYMBOL_KEYS.has(k)) {
          issues.push({
            code: 'unknown_field',
            path: `${itemPath}.${k}`,
            message: `unknown property '${k}' in relevantSymbols entry`,
            received: k,
          });
        }
      }

      let symName = '';
      let symPath = '';
      let symReason = '';

      // symbol
      if (!('symbol' in itemObj) || itemObj.symbol === undefined) {
        issues.push({
          code: 'missing_field',
          path: `${itemPath}.symbol`,
          message: 'missing symbol in relevantSymbols entry',
        });
      } else if (typeof itemObj.symbol !== 'string') {
        issues.push({
          code: 'invalid_type',
          path: `${itemPath}.symbol`,
          message: 'symbol must be a string',
          received: itemObj.symbol,
        });
      } else {
        const trimmedSym = itemObj.symbol.trim();
        if (trimmedSym.length === 0) {
          issues.push({
            code: 'invalid_string_length',
            path: `${itemPath}.symbol`,
            message: 'symbol must not be empty or whitespace-only',
            received: itemObj.symbol,
          });
        } else if (trimmedSym.length > budget.maxSymbolLength) {
          issues.push({
            code: 'budget_exceeded',
            path: `${itemPath}.symbol`,
            message: `symbol length (${trimmedSym.length}) exceeds budget (${budget.maxSymbolLength})`,
            received: trimmedSym.length,
          });
        } else {
          symName = trimmedSym;
        }
      }

      // path
      if (!('path' in itemObj) || itemObj.path === undefined) {
        issues.push({
          code: 'missing_field',
          path: `${itemPath}.path`,
          message: 'missing path in relevantSymbols entry',
        });
      } else if (typeof itemObj.path !== 'string') {
        issues.push({
          code: 'invalid_type',
          path: `${itemPath}.path`,
          message: 'path must be a string',
          received: itemObj.path,
        });
      } else if (itemObj.path.length > budget.maxPathLength) {
        issues.push({
          code: 'budget_exceeded',
          path: `${itemPath}.path`,
          message: `path length exceeds budget (${budget.maxPathLength})`,
          received: itemObj.path.length,
        });
      } else {
        const pathValidation = validateAndNormalizeRepositoryPath(itemObj.path);
        if (!pathValidation.valid || !pathValidation.normalizedPath) {
          issues.push({
            code: pathValidation.code ?? 'invalid_path',
            path: `${itemPath}.path`,
            message: pathValidation.reason ?? 'invalid repository path',
            received: itemObj.path,
          });
        } else {
          symPath = pathValidation.normalizedPath;

          // Check path authority
          if (trust?.allowedPaths !== undefined) {
            if (!isPathAllowed(symPath, trust.allowedPaths)) {
              issues.push({
                code: 'path_not_allowed',
                path: `${itemPath}.path`,
                message: `path '${symPath}' is not in the trusted allowedPaths authority`,
                received: symPath,
              });
            }
          } else if (trust?.requireTrustedPaths === true) {
            issues.push({
              code: 'path_not_allowed',
              path: `${itemPath}.path`,
              message: `path '${symPath}' rejected: requireTrustedPaths is active with no allowedPaths authority`,
              received: symPath,
            });
          }
        }
      }

      // reason
      if (!('reason' in itemObj) || itemObj.reason === undefined) {
        issues.push({
          code: 'missing_field',
          path: `${itemPath}.reason`,
          message: 'missing reason in relevantSymbols entry',
        });
      } else if (typeof itemObj.reason !== 'string') {
        issues.push({
          code: 'invalid_type',
          path: `${itemPath}.reason`,
          message: 'reason must be a string',
          received: itemObj.reason,
        });
      } else {
        const trimmedReason = itemObj.reason.trim();
        if (trimmedReason.length === 0) {
          issues.push({
            code: 'invalid_string_length',
            path: `${itemPath}.reason`,
            message: 'reason must not be empty or whitespace-only',
            received: itemObj.reason,
          });
        } else if (trimmedReason.length > budget.maxStringLength) {
          issues.push({
            code: 'budget_exceeded',
            path: `${itemPath}.reason`,
            message: `reason length (${trimmedReason.length}) exceeds budget (${budget.maxStringLength})`,
            received: trimmedReason.length,
          });
        } else {
          symReason = trimmedReason;
        }
      }

      if (symName && symPath && symReason) {
        const symbolKey = `${symPath}::${symName}`;
        if (seenSymbolKeys.has(symbolKey)) {
          issues.push({
            code: 'duplicate_entry',
            path: itemPath,
            message: `duplicate relevant symbol '${symName}' at path '${symPath}'`,
            received: symbolKey,
          });
        } else {
          seenSymbolKeys.add(symbolKey);
        }
        totalChars += symName.length + symPath.length + symReason.length;
        validatedSymbols.push(
          Object.freeze({ symbol: symName, path: symPath, reason: symReason }),
        );
      }
    }
  }

  // 5. Array of bounded strings helper
  function validateStringArray(
    fieldName: 'constraints' | 'architectureNotes' | 'risks',
    maxCount: number,
  ): readonly string[] {
    const result: string[] = [];
    if (!(fieldName in rawObj) || rawObj[fieldName] === undefined) {
      issues.push({
        code: 'missing_field',
        path: fieldName,
        message: `missing required field '${fieldName}'`,
      });
      return result;
    }

    const arr = rawObj[fieldName];
    if (!Array.isArray(arr)) {
      issues.push({
        code: 'invalid_type',
        path: fieldName,
        message: `${fieldName} must be an array`,
        received: arr,
      });
      return result;
    }

    if (arr.length > maxCount) {
      issues.push({
        code: 'budget_exceeded',
        path: fieldName,
        message: `${fieldName} count (${arr.length}) exceeds budget (${maxCount})`,
        received: arr.length,
      });
    }

    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      const itemPath = `${fieldName}[${i}]`;
      if (typeof item !== 'string') {
        issues.push({
          code: 'invalid_type',
          path: itemPath,
          message: `${fieldName} entry must be a string`,
          received: item,
        });
      } else {
        const trimmed = item.trim();
        if (trimmed.length === 0) {
          issues.push({
            code: 'invalid_string_length',
            path: itemPath,
            message: `${fieldName} entry must not be empty or whitespace-only`,
            received: item,
          });
        } else if (trimmed.length > budget.maxStringLength) {
          issues.push({
            code: 'budget_exceeded',
            path: itemPath,
            message: `${fieldName} entry length (${trimmed.length}) exceeds budget (${budget.maxStringLength})`,
            received: trimmed.length,
          });
        } else {
          totalChars += trimmed.length;
          result.push(trimmed);
        }
      }
    }

    return Object.freeze(result);
  }

  const validatedConstraints = validateStringArray('constraints', budget.maxConstraints);
  const validatedArchNotes = validateStringArray(
    'architectureNotes',
    budget.maxArchitectureNotes,
  );
  const validatedRisks = validateStringArray('risks', budget.maxRisks);

  // 6. evidence (required array)
  const validatedEvidence: EvidenceReference[] = [];
  const seenEvidenceKeys = new Set<string>();

  if (!('evidence' in rawObj) || rawObj.evidence === undefined) {
    issues.push({
      code: 'missing_field',
      path: 'evidence',
      message: "missing required field 'evidence'",
    });
  } else if (!Array.isArray(rawObj.evidence)) {
    issues.push({
      code: 'invalid_type',
      path: 'evidence',
      message: 'evidence must be an array',
      received: rawObj.evidence,
    });
  } else {
    if (rawObj.evidence.length > budget.maxEvidenceReferences) {
      issues.push({
        code: 'budget_exceeded',
        path: 'evidence',
        message: `evidence count (${rawObj.evidence.length}) exceeds budget (${budget.maxEvidenceReferences})`,
        received: rawObj.evidence.length,
      });
    }

    for (let i = 0; i < rawObj.evidence.length; i++) {
      const item = rawObj.evidence[i];
      const itemPath = `evidence[${i}]`;

      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        issues.push({
          code: 'invalid_type',
          path: itemPath,
          message: 'evidence entry must be a non-null object',
          received: item,
        });
        continue;
      }

      const itemObj = item as Record<string, unknown>;
      if (hasDangerousKeys(itemObj)) {
        issues.push({
          code: 'prototype_pollution',
          path: itemPath,
          message: 'evidence entry contains dangerous prototype keys',
        });
      }

      for (const k of Object.keys(itemObj)) {
        if (!ALLOWED_EVIDENCE_KEYS.has(k)) {
          issues.push({
            code: 'unknown_field',
            path: `${itemPath}.${k}`,
            message: `unknown property '${k}' in evidence entry`,
            received: k,
          });
        }
      }

      let evKind: EvidenceKind | undefined = undefined;
      let evId = '';

      // kind
      if (!('kind' in itemObj) || itemObj.kind === undefined) {
        issues.push({
          code: 'missing_field',
          path: `${itemPath}.kind`,
          message: 'missing kind in evidence entry',
        });
      } else if (
        typeof itemObj.kind !== 'string' ||
        !EVIDENCE_KINDS.includes(itemObj.kind as EvidenceKind)
      ) {
        issues.push({
          code: 'invalid_evidence_kind',
          path: `${itemPath}.kind`,
          message: `invalid evidence kind; expected one of: ${EVIDENCE_KINDS.join(', ')}`,
          received: itemObj.kind,
        });
      } else {
        evKind = itemObj.kind as EvidenceKind;
      }

      // id
      if (!('id' in itemObj) || itemObj.id === undefined) {
        issues.push({
          code: 'missing_field',
          path: `${itemPath}.id`,
          message: 'missing id in evidence entry',
        });
      } else if (typeof itemObj.id !== 'string') {
        issues.push({
          code: 'invalid_type',
          path: `${itemPath}.id`,
          message: 'evidence id must be a string',
          received: itemObj.id,
        });
      } else {
        const trimmedId = itemObj.id.trim();
        if (trimmedId.length === 0) {
          issues.push({
            code: 'invalid_evidence_id',
            path: `${itemPath}.id`,
            message: 'evidence id must not be empty or whitespace-only',
            received: itemObj.id,
          });
        } else if (hasControlCharacters(trimmedId)) {
          issues.push({
            code: 'invalid_evidence_id',
            path: `${itemPath}.id`,
            message: 'evidence id must not contain control characters',
            received: trimmedId,
          });
        } else if (trimmedId.length > budget.maxEvidenceIdLength) {
          issues.push({
            code: 'budget_exceeded',
            path: `${itemPath}.id`,
            message: `evidence id length (${trimmedId.length}) exceeds budget (${budget.maxEvidenceIdLength})`,
            received: trimmedId.length,
          });
        } else {
          evId = trimmedId;
        }
      }

      if (evKind && evId) {
        const evidenceRef: EvidenceReference = Object.freeze({ kind: evKind, id: evId });
        const evidenceKey = `${evKind}:${evId}`;

        if (seenEvidenceKeys.has(evidenceKey)) {
          issues.push({
            code: 'duplicate_entry',
            path: itemPath,
            message: `duplicate evidence reference '${evidenceKey}'`,
            received: evidenceKey,
          });
        } else {
          seenEvidenceKeys.add(evidenceKey);
        }

        // Check evidence trust authority
        if (trust?.allowedEvidence !== undefined) {
          if (!isEvidenceAllowed(evidenceRef, trust.allowedEvidence)) {
            issues.push({
              code: 'evidence_not_allowed',
              path: itemPath,
              message: `evidence reference '${evidenceKey}' is not in the trusted allowedEvidence authority`,
              received: evidenceKey,
            });
          }
        } else if (trust?.requireTrustedEvidence === true) {
          issues.push({
            code: 'evidence_not_allowed',
            path: itemPath,
            message: `evidence reference '${evidenceKey}' rejected: requireTrustedEvidence is active with no allowedEvidence authority`,
            received: evidenceKey,
          });
        }

        totalChars += evKind.length + evId.length;
        validatedEvidence.push(evidenceRef);
      }
    }
  }

  // 7. Overall character budget check
  if (totalChars > budget.maxTotalCharacters) {
    issues.push({
      code: 'budget_exceeded',
      path: '(root)',
      message: `total packet content characters (${totalChars}) exceeds budget (${budget.maxTotalCharacters})`,
      received: totalChars,
    });
  }

  if (issues.length > 0) {
    return {
      ok: false,
      issues: Object.freeze(issues),
    };
  }

  const packet: ContextPacket = Object.freeze({
    ...(validatedTaskId !== undefined ? { taskId: validatedTaskId } : {}),
    objective: validatedObjective,
    relevantFiles: Object.freeze(validatedFiles),
    relevantSymbols: Object.freeze(validatedSymbols),
    constraints: validatedConstraints,
    architectureNotes: validatedArchNotes,
    risks: validatedRisks,
    evidence: Object.freeze(validatedEvidence),
  });

  return {
    ok: true,
    packet,
  };
}
