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
]);

const SECRET_OR_ENV_FILE_REGEX =
  /^(\.env(\..+)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa|id_ed25519)$/i;

export interface CandidateFilterOptions {
  readonly maxCandidates?: number;
  readonly excludedSegments?: readonly string[];
}

/**
 * Deterministically filters, normalizes, deduplicates, and bounds repository candidate paths.
 *
 * Excludes:
 * - Empty or whitespace paths
 * - Unsafe paths (traversal, Unix/Windows absolute, UNC, control chars)
 * - Internal state and VCS directories (.git, .agent-flow)
 * - Build output and dependencies (node_modules, dist, coverage, .turbo, .next)
 * - Sensitive credential files (.env*, *.pem, *.key, id_rsa, etc.)
 */
export function filterAndNormalizeCandidatePaths(
  rawPaths: readonly string[],
  options?: CandidateFilterOptions,
): readonly string[] {
  const maxCandidates = options?.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const excludedSegments = new Set(
    (options?.excludedSegments ?? DEFAULT_EXCLUDED_SEGMENTS).map((s) => s.toLowerCase()),
  );

  const seen = new Set<string>();
  const normalizedList: string[] = [];

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
      normalizedList.push(norm);
    }
  }

  // Deterministic lexicographical ordering
  normalizedList.sort((a, b) => a.localeCompare(b));

  if (normalizedList.length > maxCandidates) {
    return Object.freeze(normalizedList.slice(0, maxCandidates));
  }

  return Object.freeze(normalizedList);
}

// ─── Candidate Discovery Implementations ──────────────────────────────────────

export interface CandidateDiscovery {
  discoverCandidates(projectDir: string): Promise<readonly string[]>;
}

export class StaticCandidateDiscovery implements CandidateDiscovery {
  private readonly candidates: readonly string[];

  constructor(candidates: readonly string[], options?: CandidateFilterOptions) {
    this.candidates = filterAndNormalizeCandidatePaths(candidates, options);
  }

  async discoverCandidates(_projectDir: string): Promise<readonly string[]> {
    return this.candidates;
  }
}

export class FileSystemCandidateDiscovery implements CandidateDiscovery {
  constructor(
    private readonly fs: FileSystem,
    private readonly options?: CandidateFilterOptions,
  ) {}

  async discoverCandidates(projectDir: string): Promise<readonly string[]> {
    const rawPaths: string[] = [];
    const excludedSegments = new Set(
      (this.options?.excludedSegments ?? DEFAULT_EXCLUDED_SEGMENTS).map((s) => s.toLowerCase()),
    );

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
          await walk(relPath);
        } else {
          rawPaths.push(relPath);
        }
      }
    };

    await walk('');
    return filterAndNormalizeCandidatePaths(rawPaths, this.options);
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
  'You are a repository context ranker. Given an objective and a list of candidate repository files, select and rank the files most relevant to understanding or implementing the objective. Return a structured JSON response conforming to the schema. Do not invent paths outside the candidate list.';

// ─── RepositoryRetriever ──────────────────────────────────────────────────────

/**
 * Orchestrates deterministic repository candidate discovery and advisory ranking (M3-04).
 *
 * Guarantees:
 * - Deterministic candidate discovery (repository defines the candidate universe)
 * - The local UtilityModel NEVER discovers the repository; it only ranks candidates
 * - Zero shell, zero arbitrary filesystem write authority
 * - Model output is treated as untrusted and strictly validated via validateContextPacket
 * - Model-invented paths fail closed and cannot cross the ContextPacket trust boundary
 * - Any model failure or validation refusal safely degrades into a deterministic bypass
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
    this.maxCandidates = options?.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
    this.systemInstruction = options?.systemInstruction ?? DEFAULT_SYSTEM_INSTRUCTION;
  }

  async retrieve(input: RepositoryRetrievalInput): Promise<RepositoryRetrievalResult> {
    const projectDir = input.projectDir ?? this.projectDir ?? process.cwd();

    // 1. Resolve candidates deterministically
    let candidates: readonly string[] = [];

    if (input.explicitCandidates !== undefined) {
      candidates = filterAndNormalizeCandidatePaths(input.explicitCandidates, {
        maxCandidates: this.maxCandidates,
      });
    } else if (this.candidateDiscovery !== undefined) {
      candidates = await this.candidateDiscovery.discoverCandidates(projectDir);
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

    if (rawPayload === undefined) {
      return {
        ok: false,
        bypass: true,
        reason: 'Model returned empty structured output',
        errorCode: 'invalid_response',
        candidateCount: candidates.length,
      };
    }

    // 6. Validate ContextPacket against trusted candidate authority
    const candidateSet = new Set(candidates);
    const validation = validateContextPacket(rawPayload, {
      trust: {
        allowedPaths: candidateSet,
        requireTrustedPaths: true,
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
