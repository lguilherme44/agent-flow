import type { ZodType } from 'zod';
import {
  formatValidationError,
  toJsonSchema,
  type GlobalConfig,
  type ReasoningLevel,
  type RunStage,
  type RunnerErrorCode,
  type WorkflowRole,
} from '../contracts/index.js';
import type { AgentRunner, Clock, FileSystem } from '../ports/index.js';
import type { RunnerCapabilitiesMap } from '../core/role.js';
import { resolveRole, type ResolvedAgentConfig } from '../core/role.js';
import type { PromptLoader } from './prompt-loader.js';
import type { StateStore } from './state-store.js';
import { runPaths, type ArtifactName } from './paths.js';

/** Codes a fallback may act on (§55). Everything else stays visible. */
const FALLBACK_ELIGIBLE: ReadonlySet<RunnerErrorCode> = new Set([
  'quota_exceeded',
  'auth_required',
  'runner_unavailable',
]);

/** One re-prompt after the first bad response, then stop. */
const MAX_REPAIR_ATTEMPTS = 2;

export class StageFailure extends Error {
  /**
   * Whether a fallback runner may be tried (§55).
   *
   * Computed from the error code rather than decided by the caller, so the rule
   * lives in one place: quota, auth and availability are infrastructure; a
   * malformed response is a contract problem that must not be routed around.
   */
  readonly fallbackEligible: boolean;

  constructor(
    readonly stage: RunStage,
    readonly errorCode: RunnerErrorCode,
    message: string,
    readonly raw?: string,
  ) {
    super(message);
    this.name = 'StageFailure';
    this.fallbackEligible = FALLBACK_ELIGIBLE.has(errorCode);
  }
}

export interface StageDefinition {
  readonly name: RunStage;
  readonly role: WorkflowRole;
  /** Prompt asset name, without the .md extension. */
  readonly prompt: string;
  /** Where to persist the response. Omitted for stages that return only data. */
  readonly artifact?: ArtifactName;
  /** When set, the response must validate against it. */
  readonly outputSchema?: ZodType;
  /** Extra structural checks beyond the schema, e.g. required SDD sections. */
  readonly validate?: (value: unknown, text: string) => string[];
}

export interface StageResult {
  readonly text: string;
  readonly data?: unknown;
  readonly runner: string;
  readonly attempts: number;
  /**
   * What actually ran.
   *
   * The resolved role says what was *requested*; a fallback may have sent the
   * work somewhere else, on a different model and effort. Recording the request
   * as though it were the execution makes every downstream artifact — result
   * files, telemetry, a future dashboard — quietly wrong.
   */
  readonly execution: {
    readonly runner: string;
    readonly model?: string;
    readonly reasoning: ReasoningLevel;
    readonly reasoningClamped: boolean;
    readonly fallback?: { readonly from: string; readonly errorCode: RunnerErrorCode };
  };
}

export interface StageRunnerOptions {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly store: StateStore;
  readonly config: GlobalConfig;
  readonly capabilities: RunnerCapabilitiesMap;
  readonly promptLoader: PromptLoader;
  /**
   * Resolves the runner for a role.
   *
   * Takes the whole resolution rather than just a runner id, because the caller
   * may need to wrap it — a fallback has to know which role it is standing in
   * for in order to resolve that role's replacement configuration.
   */
  readonly getRunner: (resolved: ResolvedAgentConfig) => AgentRunner;
  readonly projectDir: string;
}

/**
 * The engine every stage runs on.
 *
 * A stage is declared as data — role, prompt, artifact, schema — and this class
 * supplies everything around it: resolution, invocation, validation, the repair
 * loop, persistence, logging and events. Adding a stage should mean writing a
 * prompt and a definition, never repeating infrastructure.
 */
export class StageRunner {
  constructor(private readonly options: StageRunnerOptions) {}

  async run(
    stage: StageDefinition,
    runId: string,
    vars: Record<string, string>,
  ): Promise<StageResult> {
    const { store, clock, config, capabilities, promptLoader, getRunner } = this.options;

    const prompt = await promptLoader.load(stage.prompt);

    // Resolution validates capabilities against what the prompt declares, so a
    // misconfiguration fails here rather than after a process is spawned.
    const resolved = resolveRole(stage.role, config, capabilities, {
      readOnly: prompt.meta.permissions === 'read-only',
      nativeStructuredOutput: prompt.meta.nativeStructuredOutput,
    });

    // Raises on a missing variable — before anything is spawned or spent.
    const rendered = prompt.render(vars);

    if (resolved.reasoningClamped) {
      // Never only in a log line: a run that quietly ran below its configured
      // level should be able to explain itself later (R-16).
      await store.recordDegradation(runId, {
        kind: 'reasoning_clamped',
        reason: `runner "${resolved.runner}" does not support the configured effort for role "${stage.role}"`,
        impact: `stage "${stage.name}" ran at ${resolved.reasoning}`,
      });
    }

    const runner = getRunner(resolved);
    const startedAt = clock.now();

    await store.appendEvent(runId, 'stage_started', {
      stage: stage.name,
      role: stage.role,
      runner: resolved.runner,
      reasoning: resolved.reasoning,
    });

    const logLines: string[] = [
      `stage=${stage.name} role=${stage.role} runner=${resolved.runner} ` +
        `reasoning=${resolved.reasoning} startedAt=${startedAt}`,
    ];

    let attempt = 0;
    let promptText = rendered;
    let lastProblems: string[] = [];

    while (attempt < MAX_REPAIR_ATTEMPTS + 1) {
      attempt += 1;

      const result = await runner.run({
        prompt: promptText,
        reasoning: resolved.reasoning,
        workingDirectory: this.options.projectDir,
        permissions: prompt.meta.permissions,
        timeoutSeconds: resolved.timeoutSeconds,
        ...(resolved.model === undefined ? {} : { model: resolved.model }),
        ...(stage.outputSchema === undefined
          ? {}
          : { outputSchema: toJsonSchema(stage.outputSchema) }),
      });

      if (!result.ok) {
        // Infrastructure failures are not retried here: re-running immediately
        // would hit the same wall. Deciding whether to fall back belongs to the
        // caller, which is why the code travels with the error.
        logLines.push(`attempt=${attempt} failed errorCode=${result.errorCode}`);
        await this.writeLog(runId, stage, logLines);
        await store.appendEvent(runId, 'stage_failed', {
          stage: stage.name,
          errorCode: result.errorCode,
        });

        throw new StageFailure(
          stage.name,
          result.errorCode,
          `Stage "${stage.name}" failed: ${result.errorCode}`,
          result.raw,
        );
      }

      logLines.push(`attempt=${attempt} ok durationMs=${result.durationMs}`);

      const problems = this.validate(stage, result.text, result.json);
      if (problems.length === 0) {
        await this.persist(runId, stage, result.text);
        await this.writeLog(runId, stage, logLines);

        await store.updateRun(runId, (state) => ({ ...state, stage: stage.name }));
        await store.appendEvent(runId, 'stage_completed', {
          stage: stage.name,
          role: stage.role,
          runner: resolved.runner,
          reasoning: resolved.reasoning,
          attempts: attempt,
          startedAt,
          finishedAt: clock.now(),
        });

        // Prefer what the runner reported over what was resolved: they differ
        // exactly when a fallback fired, which is the case worth recording.
        const provenance = result.provenance;

        return {
          text: result.text,
          ...(stage.outputSchema === undefined
            ? {}
            : { data: stage.outputSchema.parse(result.json ?? safeJson(result.text)) }),
          runner: provenance?.runner ?? resolved.runner,
          attempts: attempt,
          execution: {
            runner: provenance?.runner ?? resolved.runner,
            ...(provenance !== undefined
              ? provenance.model === undefined
                ? {}
                : { model: provenance.model }
              : resolved.model === undefined
                ? {}
                : { model: resolved.model }),
            reasoning: provenance?.reasoning ?? resolved.reasoning,
            reasoningClamped: provenance?.reasoningClamped ?? resolved.reasoningClamped,
            ...(provenance === undefined
              ? {}
              : {
                  fallback: {
                    from: provenance.substitutedFor.runner,
                    errorCode: provenance.substitutedFor.errorCode,
                  },
                }),
          },
        };
      }

      lastProblems = problems;
      logLines.push(`attempt=${attempt} invalid: ${problems.join('; ')}`);

      // The retry has to say what was wrong. Asking again without the reason is
      // a coin flip, and an expensive one.
      promptText =
        `${rendered}\n\n---\n\n` +
        `Your previous response was rejected because it did not satisfy the required format:\n` +
        `${problems.map((problem) => `  - ${problem}`).join('\n')}\n\n` +
        `Return a corrected response. Output only the response itself.`;
    }

    await this.writeLog(runId, stage, logLines);
    await store.appendEvent(runId, 'stage_failed', {
      stage: stage.name,
      errorCode: 'invalid_output',
      problems: lastProblems,
    });

    throw new StageFailure(
      stage.name,
      'invalid_output',
      `Stage "${stage.name}" produced output that never satisfied its contract ` +
        `after ${String(attempt)} attempts:\n${lastProblems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }

  /** Schema first, then any structural checks the stage adds. */
  private validate(stage: StageDefinition, text: string, json: unknown): string[] {
    const problems: string[] = [];

    if (stage.outputSchema !== undefined) {
      const candidate = json ?? safeJson(text);
      if (candidate === undefined) {
        problems.push('expected a JSON object, got unparseable output');
      } else {
        const result = stage.outputSchema.safeParse(candidate);
        if (!result.success) {
          problems.push(...formatValidationError(result.error).split('\n').slice(1));
        }
      }
    }

    if (stage.validate) problems.push(...stage.validate(json, text));
    return problems;
  }

  private async persist(runId: string, stage: StageDefinition, text: string): Promise<void> {
    if (stage.artifact === undefined) return;
    await this.options.store.writeArtifact(runId, stage.artifact, text);
  }

  private async writeLog(
    runId: string,
    stage: StageDefinition,
    lines: readonly string[],
  ): Promise<void> {
    const path = runPaths(this.options.projectDir, runId).log(stage.name);
    await this.options.fs.mkdirp(runPaths(this.options.projectDir, runId).logsDir);
    await this.options.fs.writeFileAtomic(path, `${lines.join('\n')}\n`);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
}
