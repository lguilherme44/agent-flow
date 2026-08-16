import {
  ContextPacketSchema,
  validateContextPacket,
  validateAndNormalizeRepositoryPath,
  type ContextPacket,
  type ContextPacketValidationIssue,
} from '../contracts/context-packet.schema.js';
import { toJsonSchema } from '../contracts/json-schema.js';
import type { FileSystem } from '../ports/file-system.js';
import type {
  UtilityModel,
  UtilityModelErrorCode,
} from '../ports/utility-model.js';

// ─── Candidate Discovery Types & Constants ───────────────────────────────────

export const DEFAULT_MAX_CANDIDATES = 200;
export const HARD_MAX_CANDIDATES = 1000;

export const DEFAULT_EXCLUDED_SEGMENTS = Object.freeze([
  '.git',
  '.agent-flow',
  'node_modules',
  'dist',
  'coverage',
  '.turbo',
  '.next',
  '.nuxt',
  'build',
  '.output',
  // Tool-owned generated directories discovered in the M3-09 dogfood: Claude
  // Code drops `.atl/` droppings, uv/ruff/pytest leave cache dirs behind. They
  // are clearly generated/tool-owned, never legitimate repository content.
  '.atl',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
]);

const SECRET_OR_ENV_FILE_REGEX =
  /^(\.env(\..+)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa|id_ed25519)$/i;

export interface CandidateFilterOptions {
  readonly maxCandidates?: number;
  readonly excludedSegments?: readonly string[];
  readonly objective?: string;
}

function sanitizeMaxCandidates(val?: number): number {
  if (val === 0) return 0;
  if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
    return DEFAULT_MAX_CANDIDATES;
  }
  return Math.min(Math.floor(val), HARD_MAX_CANDIDATES);
}

// ─── Deterministic Objective-Path Relevance Scorer (Hotspot B) ────────────────

const COMMON_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'into',
  'file',
  'files',
  'code',
  'implement',
  'fix',
  'test',
  'tests',
  'update',
  'change',
  'add',
  'remove',
  'delete',
  'issue',
  'bug',
]);

function extractObjectiveTokens(objective?: string): readonly string[] {
  if (!objective || typeof objective !== 'string') return [];
  const rawTokens = objective
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((t) => t.length >= 2);

  const filtered = rawTokens.filter((t) => !COMMON_STOP_WORDS.has(t));
  return filtered.length > 0 ? filtered : rawTokens;
}

function tokenizePath(path: string): { readonly segments: readonly string[]; readonly basenameTokens: readonly string[] } {
  const norm = path.toLowerCase();
  const rawSegments = norm.split('/');
  const basename = rawSegments[rawSegments.length - 1] ?? '';

  // Split basename by delimiters and camelCase
  const basenameTokens = basename
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length >= 2);

  return {
    segments: rawSegments,
    basenameTokens,
  };
}

function scorePathRelevance(path: string, objectiveTokens: readonly string[]): number {
  if (objectiveTokens.length === 0) return 0;

  const { segments, basenameTokens } = tokenizePath(path);
  const basename = segments[segments.length - 1] ?? '';
  let score = 0;

  for (const token of objectiveTokens) {
    // 1. Exact token in basename tokens
    if (basenameTokens.includes(token)) {
      score += 100;
    } else if (basename.includes(token)) {
      score += 50;
    }

    // 2. Segment match
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i] ?? '';
      if (seg === token) {
        score += 30;
      } else if (seg.includes(token)) {
        score += 10;
      }
    }
  }

  return score;
}

/**
 * Deterministically filters, normalizes, scores against objective, deduplicates, and bounds repository candidate paths.
 *
 * Excludes:
 * - Empty or whitespace paths
 * - Unsafe paths (traversal, Unix/Windows absolute, UNC, control chars)
 * - Internal state and VCS directories (.git, .agent-flow)
 * - Build output and dependencies (node_modules, dist, coverage, .turbo, .next)
 * - Sensitive credential files (.env*, *.pem, *.key, id_rsa, etc.)
 *
 * Scoring & Selection (Hotspot B):
 * - When an objective is provided, candidates are scored by lexical relevance to objective tokens.
 * - Candidates are sorted by score descending, then tie-broken deterministically by normalized path.
 * - The top `maxCandidates` candidates are selected, ensuring relevant files are not starved by alphabetic order.
 */
export function filterAndNormalizeCandidatePaths(
  rawPaths: readonly string[],
  options?: CandidateFilterOptions,
): readonly string[] {
  const maxCandidates = sanitizeMaxCandidates(options?.maxCandidates);
  if (maxCandidates === 0) return Object.freeze([]);

  const excludedSegments = new Set(
    (options?.excludedSegments ?? DEFAULT_EXCLUDED_SEGMENTS).map((s) => s.toLowerCase()),
  );

  const seen = new Set<string>();
  const validList: string[] = [];

  for (const raw of rawPaths) {
    if (typeof raw !== 'string') continue;

    const validation = validateAndNormalizeRepositoryPath(raw);
    if (!validation.valid || !validation.normalizedPath) {
      continue;
    }

    const norm = validation.normalizedPath;
    const segments = norm.split('/');

    // Check if any path segment is excluded
    const hasExcludedSegment = segments.some((seg) =>
      excludedSegments.has(seg.toLowerCase()),
    );
    if (hasExcludedSegment) {
      continue;
    }

    // Check secret / sensitive files
    const filename = segments[segments.length - 1] ?? '';
    if (SECRET_OR_ENV_FILE_REGEX.test(filename)) {
      continue;
    }

    if (!seen.has(norm)) {
      seen.add(norm);
      validList.push(norm);
    }
  }

  const objectiveTokens = extractObjectiveTokens(options?.objective);

  if (objectiveTokens.length > 0) {
    // Score each candidate against objective tokens
    const scored = validList.map((path) => ({
      path,
      score: scorePathRelevance(path, objectiveTokens),
    }));

    // Sort by score descending, then tie-break deterministically by path ascending
    scored.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.path.localeCompare(b.path);
    });

    const selected = scored.slice(0, maxCandidates).map((s) => s.path);
    return Object.freeze(selected);
  }

  // Deterministic lexicographical ordering fallback
  validList.sort((a, b) => a.localeCompare(b));

  if (validList.length > maxCandidates) {
    return Object.freeze(validList.slice(0, maxCandidates));
  }

  return Object.freeze(validList);
}

// ─── Candidate Discovery Implementations ──────────────────────────────────────

export interface CandidateDiscovery {
  discoverCandidates(projectDir: string, objective?: string): Promise<readonly string[]>;
}

export class StaticCandidateDiscovery implements CandidateDiscovery {
  private readonly rawCandidates: readonly string[];
  private readonly options?: CandidateFilterOptions;

  constructor(candidates: readonly string[], options?: CandidateFilterOptions) {
    this.rawCandidates = Object.freeze([...candidates]);
    this.options = options;
  }

  async discoverCandidates(_projectDir: string, objective?: string): Promise<readonly string[]> {
    return filterAndNormalizeCandidatePaths(this.rawCandidates, {
      ...this.options,
      objective: objective ?? this.options?.objective,
    });
  }
}

export class FileSystemCandidateDiscovery implements CandidateDiscovery {
  constructor(
    private readonly fs: FileSystem,
    private readonly options?: CandidateFilterOptions,
  ) {}

  async discoverCandidates(projectDir: string, objective?: string): Promise<readonly string[]> {
    const rawPaths: string[] = [];
    const excludedSegments = new Set(
      (this.options?.excludedSegments ?? DEFAULT_EXCLUDED_SEGMENTS).map((s) => s.toLowerCase()),
    );

    const realProjectDir = (await this.fs.realPath(projectDir)) ?? projectDir;

    const walk = async (currentRelDir: string): Promise<void> => {
      const fullDir = currentRelDir ? `${projectDir}/${currentRelDir}` : projectDir;
      let entries: string[] = [];
      try {
        entries = await this.fs.readDir(fullDir);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry === '.' || entry === '..') continue;
        if (excludedSegments.has(entry.toLowerCase())) continue;

        const relPath = currentRelDir ? `${currentRelDir}/${entry}` : entry;
        const fullPath = `${projectDir}/${relPath}`;

        let st = null;
        try {
          st = await this.fs.stat(fullPath);
        } catch {
          continue;
        }

        if (!st) continue;

        if (st.isDirectory) {
          // Prevent symlink directory escapes and cycles
          const realDirPath = await this.fs.realPath(fullPath);
          if (
            realDirPath &&
            (realDirPath === realProjectDir || realDirPath.startsWith(`${realProjectDir}/`))
          ) {
            await walk(relPath);
          }
        } else {
          rawPaths.push(relPath);
        }
      }
    };

    await walk('');
    return filterAndNormalizeCandidatePaths(rawPaths, {
      ...this.options,
      objective: objective ?? this.options?.objective,
    });
  }
}

// ─── Repository Retrieval Types ───────────────────────────────────────────────

export interface RepositoryRetrievalInput {
  readonly objective: string;
  readonly taskId?: string;
  readonly projectDir?: string;
  readonly explicitCandidates?: readonly string[];
}

export type RepositoryRetrievalErrorCode =
  | UtilityModelErrorCode
  | 'no_model'
  | 'validation_failed'
  | 'empty_candidates';

export type RepositoryRetrievalResult =
  | {
      readonly ok: true;
      readonly bypass: false;
      readonly packet: ContextPacket;
      readonly candidateCount: number;
    }
  | {
      readonly ok: false;
      readonly bypass: true;
      readonly reason: string;
      readonly errorCode?: RepositoryRetrievalErrorCode;
      readonly validationIssues?: readonly ContextPacketValidationIssue[];
      readonly candidateCount: number;
    };

export interface RepositoryRetrieverOptions {
  readonly utilityModel?: UtilityModel;
  readonly candidateDiscovery?: CandidateDiscovery;
  readonly projectDir?: string;
  readonly maxCandidates?: number;
  readonly systemInstruction?: string;
}

const DEFAULT_SYSTEM_INSTRUCTION =
  'You are a repository context ranker. Given an objective and a list of candidate repository files, select and rank the files most relevant to understanding or implementing the objective. Return a structured JSON response conforming to the schema. Do not invent paths outside the candidate list. Do not reference evidence.';

// ─── RepositoryRetriever ──────────────────────────────────────────────────────

/**
 * Orchestrates deterministic repository candidate discovery and advisory ranking (M3-04).
 *
 * Guarantees:
 * - Deterministic candidate discovery (repository defines the candidate universe)
 * - Objective-sensitive lexical candidate preselection (Hotspot B) prevents alphabetic starvation
 * - The local UtilityModel NEVER discovers the repository; it only ranks candidates
 * - Zero shell, zero arbitrary filesystem write authority
 * - Model output is treated as untrusted and strictly validated via validateContextPacket
 * - Model-invented paths fail closed and cannot cross the ContextPacket trust boundary
 * - Model cannot reference unauthorized evidence (Hotspot A: allowedEvidence: new Set(), requireTrustedEvidence: true)
 * - Any model failure, validation refusal, or discovery error safely degrades into a deterministic bypass
 * - Number of inference calls is at most 1
 */
export class RepositoryRetriever {
  private readonly utilityModel?: UtilityModel;
  private readonly candidateDiscovery?: CandidateDiscovery;
  private readonly projectDir?: string;
  private readonly maxCandidates: number;
  private readonly systemInstruction: string;

  constructor(options?: RepositoryRetrieverOptions) {
    this.utilityModel = options?.utilityModel;
    this.candidateDiscovery = options?.candidateDiscovery;
    this.projectDir = options?.projectDir;
    this.maxCandidates = sanitizeMaxCandidates(options?.maxCandidates);
    this.systemInstruction = options?.systemInstruction ?? DEFAULT_SYSTEM_INSTRUCTION;
  }

  async retrieve(input: RepositoryRetrievalInput): Promise<RepositoryRetrievalResult> {
    const projectDir = input.projectDir ?? this.projectDir ?? process.cwd();

    if (this.maxCandidates === 0) {
      return {
        ok: false,
        bypass: true,
        reason: 'maxCandidates is configured to 0',
        errorCode: 'empty_candidates',
        candidateCount: 0,
      };
    }

    // 1. Resolve candidates deterministically
    let candidates: readonly string[] = [];

    try {
      if (input.explicitCandidates !== undefined) {
        candidates = filterAndNormalizeCandidatePaths(input.explicitCandidates, {
          maxCandidates: this.maxCandidates,
          objective: input.objective,
        });
      } else if (this.candidateDiscovery !== undefined) {
        candidates = await this.candidateDiscovery.discoverCandidates(projectDir, input.objective);
      }
    } catch (err) {
      return {
        ok: false,
        bypass: true,
        reason: `Candidate discovery failed: ${err instanceof Error ? err.message : String(err)}`,
        errorCode: 'empty_candidates',
        candidateCount: 0,
      };
    }

    if (candidates.length === 0) {
      return {
        ok: false,
        bypass: true,
        reason: 'No candidate repository files available for retrieval',
        errorCode: 'empty_candidates',
        candidateCount: 0,
      };
    }

    // 2. Check UtilityModel availability
    if (!this.utilityModel) {
      return {
        ok: false,
        bypass: true,
        reason: 'UtilityModel is not configured',
        errorCode: 'no_model',
        candidateCount: candidates.length,
      };
    }

    try {
      const health = await this.utilityModel.healthCheck();
      if (health.status === 'unavailable') {
        return {
          ok: false,
          bypass: true,
          reason: `UtilityModel is unavailable: ${health.detail ?? 'endpoint probe failed'}`,
          errorCode: 'unavailable',
          candidateCount: candidates.length,
        };
      }
    } catch (err) {
      return {
        ok: false,
        bypass: true,
        reason: `UtilityModel health check threw: ${err instanceof Error ? err.message : String(err)}`,
        errorCode: 'unavailable',
        candidateCount: candidates.length,
      };
    }

    // 3. Build ranking prompt
    const promptContent = this.buildPromptContent(input.objective, candidates, input.taskId);
    const desiredOutputSchema = toJsonSchema(ContextPacketSchema);

    // 4. Run inference (at most 1 call)
    let modelResult;
    try {
      modelResult = await this.utilityModel.run({
        systemInstruction: this.systemInstruction,
        content: promptContent,
        desiredOutputSchema,
        correlationId: input.taskId,
      });
    } catch (err) {
      return {
        ok: false,
        bypass: true,
        reason: `UtilityModel run threw unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        errorCode: 'execution_failed',
        candidateCount: candidates.length,
      };
    }

    if (!modelResult.ok) {
      return {
        ok: false,
        bypass: true,
        reason: `UtilityModel inference failed: ${modelResult.message}`,
        errorCode: modelResult.errorCode,
        candidateCount: candidates.length,
      };
    }

    // 5. Parse structured response
    let rawPayload: unknown = modelResult.structured;
    if (rawPayload === undefined && modelResult.text) {
      try {
        rawPayload = JSON.parse(modelResult.text);
      } catch {
        return {
          ok: false,
          bypass: true,
          reason: 'Model returned unstructured text that could not be parsed as JSON',
          errorCode: 'invalid_response',
          candidateCount: candidates.length,
        };
      }
    }

    if (rawPayload === undefined || typeof rawPayload !== 'object' || rawPayload === null) {
      return {
        ok: false,
        bypass: true,
        reason: 'Model returned empty or non-object structured output',
        errorCode: 'invalid_response',
        candidateCount: candidates.length,
      };
    }

    // Preserve trusted caller fields (objective, taskId)
    const payloadObj = { ...(rawPayload as Record<string, unknown>) };
    payloadObj.objective = input.objective;
    if (input.taskId !== undefined) {
      payloadObj.taskId = input.taskId;
    }

    // 6. Validate ContextPacket against trusted candidate authority and strict empty evidence authority (Hotspot A)
    const candidateSet = new Set(candidates);
    const validation = validateContextPacket(payloadObj, {
      trust: {
        allowedPaths: candidateSet,
        requireTrustedPaths: true,
        allowedEvidence: new Set<string>(),
        requireTrustedEvidence: true,
      },
    });

    if (!validation.ok) {
      return {
        ok: false,
        bypass: true,
        reason: `ContextPacket validation failed: ${validation.issues.map((i) => i.message).join('; ')}`,
        errorCode: 'validation_failed',
        validationIssues: validation.issues,
        candidateCount: candidates.length,
      };
    }

    return {
      ok: true,
      bypass: false,
      packet: validation.packet,
      candidateCount: candidates.length,
    };
  }

  private buildPromptContent(
    objective: string,
    candidates: readonly string[],
    taskId?: string,
  ): string {
    const lines = [
      `Objective: ${objective}`,
      ...(taskId ? [`Task ID: ${taskId}`] : []),
      '',
      'Candidate repository files (select and rank relevant files strictly from this list):',
      ...candidates.map((c) => `- ${c}`),
    ];
    return lines.join('\n');
  }
}
