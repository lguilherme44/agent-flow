import type { ZodType } from 'zod';
import {
  formatValidationError,
  toJsonSchema,
  type FailureClass,
  type GlobalConfig,
  type ReasoningLevel,
  type RunUsage,
  type RunStage,
  type RunnerErrorCode,
  type Task,
  type WorkflowRole,
} from '../contracts/index.js';
import type { AgentRunner, Clock, FileSystem, Host, RunProvenance } from '../ports/index.js';
import type { RunnerCapabilitiesMap } from '../core/role.js';
import { resolveRole, type ResolvedAgentConfig } from '../core/role.js';
import {
  classifyRunnerFailure,
  type RunnerFailureClassification,
} from '../core/failure-classification.js';
import { redactAndTruncate, redactEvidence } from '../core/evidence-redaction.js';
import { measurePromptComposition } from '../core/prompt-budget.js';
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

  /**
   * What this failure *is*, above the transport code (AD-36, AR-02).
   *
   * `errorCode` says the runner process failed; `failureClass` says why, when the evidence
   * supports naming it. The two are a refinement, not a replacement — `execution_failed`
   * covered an unsupported effort, a denied command and a genuine implementation failure,
   * three failures with three different correct responses.
   *
   * **Nothing branches on this.** Control flow still reads `errorCode` (that is I-21's
   * companion rule and AD-33's); this travels onto artifacts, events and the sentence a
   * person reads.
   */
  readonly failureClass: FailureClass;

  /** The tool the runner was refused, when the evidence names it (C-06). */
  readonly deniedCommand?: string;

  constructor(
    readonly stage: RunStage,
    readonly errorCode: RunnerErrorCode,
    message: string,
    readonly raw?: string,
    /**
     * What ran, as far as it got.
     *
     * A failure is provenance too. Callers used to have nothing to record here
     * and invented placeholders — `runner: "unknown"`, `reasoning: "medium"` —
     * which are not unknowns but assertions, and false ones: the run was
     * routed somewhere specific, at a specific effort, and that is exactly what
     * someone reading a failed result needs to know.
     */
    readonly execution?: StageExecution,
    classification?: RunnerFailureClassification,
  ) {
    super(message);
    this.name = 'StageFailure';
    this.fallbackEligible = FALLBACK_ELIGIBLE.has(errorCode);

    // Classified here when the caller did not, so no construction site can produce a
    // failure with no class. The code-only answer is always available and always correct
    // as a floor; passing `raw` sharpens it.
    const resolved = classification ?? classifyRunnerFailure({ errorCode, ...(raw === undefined ? {} : { redactedRaw: raw }) });
    this.failureClass = resolved.failureClass;
    if (resolved.deniedCommand !== undefined) this.deniedCommand = resolved.deniedCommand;
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
  /**
   * Log file name, when the stage name is not unique within a run.
   *
   * Implementation runs once per task, and every one of them wrote
   * `logs/implementation.log` — so a run of nine tasks kept the log of whichever
   * finished last, and the other eight were gone. It went unnoticed because
   * nothing read the logs back until the dashboard needed them.
   */
  readonly logName?: string;
}

/** What actually ran, as opposed to what was resolved. */
export interface StageExecution {
  readonly runner: string;
  readonly model?: string;
  readonly reasoning: ReasoningLevel;
  readonly reasoningClamped: boolean;
  readonly fallback?: { readonly from: string; readonly errorCode: RunnerErrorCode };
  /**
   * What the runner said this call spent (PRI-19).
   *
   * Beside `model` and not merged into it, because the two answer different questions:
   * that one is what the configuration asked for, this one is what the provider says
   * actually answered. A run that pins no model — the arrangement AD-13 recommends — has
   * `model` absent and `usage.model` populated, which is the case that made every such
   * run unattributable before this field existed.
   */
  readonly usage?: RunUsage;
}

export interface StageResult {
  readonly text: string;
  readonly data?: unknown;
  readonly runner: string;
  /**
   * How many times the stage had to re-prompt for a well-formed answer (AR §4.4).
   *
   * **Named `repairs` and not `attempts`.** One word, one meaning: an *attempt* is one
   * agent invocation for one task in one prepared workspace whose work was observed and
   * judged, and that number lives on `TaskProgress`. This one counts re-prompts inside a
   * single stage call, and the two were both called `attempt` — which is how a log line
   * reading `attempt=1 failed` ended up inside a file named `…-attempt-2.log`.
   */
  readonly repairs: number;
  /**
   * What actually ran.
   *
   * The resolved role says what was *requested*; a fallback may have sent the
   * work somewhere else, on a different model and effort. Recording the request
   * as though it were the execution makes every downstream artifact — result
   * files, telemetry, a future dashboard — quietly wrong.
   */
  readonly execution: StageExecution;
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
  /**
   * Optional advisory-context hook (§18, M3-08). When present, its block is
   * appended to the prompt the primary runner receives — never replacing it.
   * Offline, malformed, or throwing advisors leave the prompt untouched.
   */
  readonly advisor?: StageAdvisor;
  /**
   * The machine, for its home directory — the second root {@link redactEvidence} needs.
   *
   * Optional so the twenty-odd test wirings that predate AR-02 keep working; production
   * always supplies it from `execution-context.ts`. Absent, workspace paths are still
   * redacted and home paths are not, which is a weaker guarantee rather than a wrong one.
   */
  readonly host?: Host;
}

/**
 * The engine every stage runs on.
 *
 * A stage is declared as data — role, prompt, artifact, schema — and this class
 * supplies everything around it: resolution, invocation, validation, the repair
 * loop, persistence, logging and events. Adding a stage should mean writing a
 * prompt and a definition, never repeating infrastructure.
 */
/** Per-invocation overrides. Only the working directory so far. */
export interface StageRunOptions {
  /** Absolute. Defaults to the project directory. */
  readonly workingDirectory?: string;
  /**
   * Ends this stage's invocation, and its process tree, before its timeout (PRI-14).
   *
   * Passed through rather than acted on here: the repair loop below is bounded and short,
   * and a cancelled stage's next repair round would be work nobody is waiting for — so the
   * signal reaches the runner, and an aborted invocation returns as an ordinary failure
   * that ends the loop.
   */
  readonly signal?: AbortSignal;
  /**
   * How the plan classified this task, when a task is what is running (AR-09).
   *
   * Only `trivial` has a context ceiling: the ceiling is about *proportion*, and a complex
   * task legitimately receives a lot. Absent for a pipeline stage, which is not classified.
   */
  readonly complexity?: Task['complexity'];
  /**
   * Which task and attempt this stage is running for (AR-09).
   *
   * Absent for a pipeline stage, which genuinely belongs to no task. Present for an
   * implementation stage, because AR-09's acceptance asks for a recovered task's cost
   * *against a first-attempt baseline* — and a baseline is a comparison between two
   * attempts of one task. `implementation` runs once per task per attempt, so an event
   * naming only the stage cannot be joined to either of them.
   */
  readonly task?: string;
  readonly attempt?: number;
  /**
   * A block appended to the rendered prompt, from outside the stage (M4-06).
   *
   * The same shape as the advisory block and appended in the same place, for the same
   * reason: it is *context*, never control. What makes it a parameter rather than a
   * second `StageAdvisor` is that its content depends on the task and the agent, and the
   * advisory request carries neither — a hook that had to be told which task it was for
   * would stop being the stage-generic seam MVP 3 designed.
   *
   * **Appended rather than interpolated into `prompts/implementation.md`, deliberately.**
   * A `{{collaboration}}` placeholder would put a blank line into every prompt whether or
   * not the feature is on, and M4's acceptance requires that a run with
   * `collaboration.enabled: false` produce byte-for-byte the prompt it produced before the
   * milestone.
   */
  readonly collaborationContext?: string;
  /**
   * The unconditional half of the same seam (M5, I-40).
   *
   * Appended whether or not {@link collaborationContext} is present, because an agent
   * that is not told the channel exists never uses it — which is the deadlock M4 shipped
   * and this field exists to make structurally impossible.
   */
  readonly collaborationBootstrap?: string;
  /**
   * The team member answering for this role, when one is (M5, §8).
   *
   * **`resolveRole` has taken this override since M5 and the execution path never passed
   * it.** A member declares `runner:`; the capability check honoured it and the
   * independence calculation honoured it, while the dispatch resolved the role and ran on
   * whatever `roles:` pointed at. The live M6 log said it in two lines — `task_assigned
   * agent=qa` then `task_finished runner=agy`, with `qa` declaring `claude` — and three of
   * five recorded independence levels were wrong as a result, one of them recording
   * *maximum* independence for a review where the same provider wrote and judged.
   *
   * §8 asks the system to persist the *effective* level. That is only possible if the
   * effective runner is the one that runs.
   */
  readonly member?: { readonly runner: string; readonly model?: string };
}

/**
 * What a stage wants before it runs.
 *
 * The advisor receives everything a decision needs and nothing it doesn't: the
 * stage declaration, the run, the rendered prompt and the resolved role. It
 * must stay provider-neutral — it never sees runners or models, only the work.
 */
export interface StageAdvisoryRequest {
  readonly stage: StageDefinition;
  readonly runId: string;
  /** The prompt the primary runner is about to receive, re-rendered. */
  readonly renderedPrompt: string;
  readonly objective: string;
}

/**
 * A provider-neutral hook that may enrich a stage's prompt with advisory
 * context before it reaches the primary runner (§18, M3-08).
 *
 * Deliberately void-shaped: the advisor contributes *context*, never workflow
 * truth, and never succeeds or fails the stage. A thrown error, a missing
 * utility model, or malformed output all mean "run the stage as if M3 did not
 * exist" — silently, because advisory context is optional by contract.
 */
export interface StageAdvisor {
  /**
   * May return an advisory block appended to the prompt. Returning `undefined`
   * leaves the prompt untouched. Throwing is treated the same way.
   */
  advise(request: StageAdvisoryRequest): Promise<string | undefined>;
}

export class StageRunner {
  constructor(private readonly options: StageRunnerOptions) {}

  /**
   * Where a role would be routed, before anything runs.
   *
   * Callers need this only to describe a stage that failed before it could
   * report anything of its own. Resolution already lives here, next to the
   * configuration and capabilities it depends on — asking the caller to redo it
   * would mean two answers to one question, and the caller's would drift.
   */
  plannedExecution(role: StageDefinition['role']): StageExecution {
    return executionOf(
      undefined,
      resolveRole(role, this.options.config, this.options.capabilities),
    );
  }

  /** The roots this stage's output may name, for {@link redactEvidence}. */
  private redactionContext(options: StageRunOptions): { workspaceRoot: string; home?: string } {
    return redactionContextOf({
      workingDirectory: options.workingDirectory ?? this.options.projectDir,
      ...(this.options.host === undefined ? {} : { home: this.options.host.homeDir }),
    });
  }

  /**
   * Where the agent runs, when it is not the project directory.
   *
   * Added for M2-04: in worktree mode a task's agent must run in that task's own
   * checkout (§4.2). Defaulted rather than required, so every planning stage —
   * which observes the project and writes nothing — keeps the behaviour it has.
   */
  async run(
    stage: StageDefinition,
    runId: string,
    vars: Record<string, string>,
    options: StageRunOptions = {},
  ): Promise<StageResult> {
    const { store, clock, config, capabilities, promptLoader, getRunner } = this.options;

    const prompt = await promptLoader.load(stage.prompt);

    // Resolution validates capabilities against what the prompt declares, so a
    // misconfiguration fails here rather than after a process is spawned.
    const resolved = resolveRole(
      stage.role,
      config,
      capabilities,
      {
        // Named so a role that serves several stages can send one of them
        // elsewhere — `roles.architect.stages.architecture-impact.runner`.
        stage: stage.name,
        readOnly: prompt.meta.permissions === 'read-only',
        nativeStructuredOutput: prompt.meta.nativeStructuredOutput,
        // The prompt decides, exactly as it does for `readOnly` (AD-12). A stage that opens
        // no file may run on a runner that has no filesystem.
        workingDirectory: prompt.meta.workingDirectory,
      },
      // Absent for every pipeline stage, which genuinely answers to a role rather than to
      // a member — so a run with no team resolves exactly as it did before M5.
      options.member,
    );

    // Raises on a missing variable — before anything is spawned or spent.
    const rendered = prompt.render(vars);

    if (resolved.reasoningClamped) {
      // Never only in a log line: a run that quietly ran below its configured
      // level should be able to explain itself later (R-16).
      //
      // **Naming the pair, and all four facts** (AR-01, C-03). The old sentence blamed the
      // *runner*, which was true of a CLI-level gap and false of the one that actually
      // happened: the AGY CLI accepts `medium` and the model behind it does not. A person
      // reading "runner agy does not support medium" would have gone looking in the wrong
      // place — and did.
      await store.recordDegradation(runId, {
        kind: 'reasoning_clamped',
        reason:
          `role "${stage.role}" requested effort ${resolved.requestedReasoning}, which ` +
          `runner "${resolved.runner}"${describeModel(resolved.model)} does not offer ` +
          `(supported: ${resolved.supportedReasoningLevels.join(', ')})`,
        impact: `stage "${stage.name}" ran at ${resolved.reasoning} instead of ${resolved.requestedReasoning}`,
      });
    }

    // Advisory context is optional by contract (§18): offline, malformed or
    // throwing advisors leave the prompt as-rendered, and the stage proceeds.
    // The block is appended once, before the repair loop, so a re-prompt never
    // re-runs the advisor — its answer does not depend on the earlier attempt.
    // It is also part of the prompt's *base*, so a repair rebuilds from the
    // same material the failed attempt saw — never dropping the advisory.
    let basePrompt = rendered;
    // Kept beside the prompt rather than folded into it, so AR-09 can attribute the bytes
    // to the source that produced them. "The prompt got big" is not something anybody can
    // act on; "the advisory block is 60% of it" names what to turn off.
    let advisoryBlock = '';
    const advisor = this.options.advisor;
    if (advisor !== undefined) {
      try {
        const advisory = await advisor.advise({
          stage,
          runId,
          renderedPrompt: rendered,
          objective: vars.objective ?? stage.name,
        });
        if (advisory !== undefined && advisory.length > 0) {
          advisoryBlock = advisory;
          basePrompt = `${rendered}\n\n${advisory}`;
        }
      } catch {
        // Best effort: advisory context never changes stage control (§14.3).
      }
    }
    // M4-06. After the advisory block, so the two are in a fixed order and a prompt is a
    // deterministic function of its inputs; and inside the *base*, so a repair rebuilds
    // from the same material the failed attempt saw.
    // Bootstrap first, then context: the invitation is what makes the payload
    // actionable, and an agent that reads a question before it knows how to answer has
    // met the two halves in the wrong order.
    const bootstrapBlock = options.collaborationBootstrap ?? '';
    if (bootstrapBlock.length > 0) basePrompt = `${basePrompt}\n\n${bootstrapBlock}`;

    const collaborationBlock = options.collaborationContext ?? '';
    if (collaborationBlock.length > 0) basePrompt = `${basePrompt}\n\n${collaborationBlock}`;

    let promptText = basePrompt;

    const runner = getRunner(resolved);
    const startedAt = clock.now();

    // The same facts the degradation carries, structurally (AR-01, C-03). The degradation
    // is prose, for a person; this is for the read model, which must never have to parse
    // one. §8 keeps `RunEvent.detail` an open record precisely so evidence can be enriched
    // without a migration, and these fields are additive.
    await store.appendEvent(runId, 'stage_started', {
      stage: stage.name,
      role: stage.role,
      runner: resolved.runner,
      ...(resolved.model === undefined ? {} : { model: resolved.model }),
      reasoning: resolved.reasoning,
      reasoningRequested: resolved.requestedReasoning,
      reasoningSupported: resolved.supportedReasoningLevels,
      reasoningClamped: resolved.reasoningClamped,
    });

    // **What this prompt is made of** (AR-09). A one-`grep` call in the evidence
    // environment reported ≈49 k input tokens before Agent Flow contributed anything of
    // its own, and recovery adds a packet on top of that. Measured per stage and recorded,
    // because a total nobody can attribute is a number nobody can act on.
    //
    // `agentsMd` is counted from the rendered variables rather than re-read: what matters
    // is what the runner received, not what is on disk.
    // The window belongs to the runner this stage resolved to, not to the stage:
    // the same prompt is comfortable on one model and over the wall on another.
    // Absent for every runner that does not declare one, which is all of them
    // until an operator says otherwise.
    const runnerWindow = config.runners[resolved.runner]?.contextWindow;

    const composition = measurePromptComposition(
      {
        stagePrompt: rendered,
        agentsMd: vars.agentsMd ?? '',
        advisory: advisoryBlock,
        failureContext: vars.failureContext ?? '',
        collaborationBootstrap: bootstrapBlock,
        collaboration: collaborationBlock,
      },
      options.complexity === undefined ? undefined : { complexity: options.complexity },
      runnerWindow,
    );

    await store.appendEvent(runId, 'stage_context_measured', {
      stage: stage.name,
      role: stage.role,
      // Omitted rather than defaulted for a stage with no task: `task: ''` would join to
      // nothing while looking as though it should.
      ...(options.task === undefined ? {} : { task: options.task }),
      ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
      totalBytes: composition.totalBytes,
      parts: composition.parts,
      overCeiling: composition.overCeiling,
      ...(composition.ceilingDetail === undefined
        ? {}
        : { ceilingDetail: composition.ceilingDetail }),
      ...(composition.nearModelWindow === undefined
        ? {}
        : { nearModelWindow: composition.nearModelWindow }),
      ...(composition.windowDetail === undefined
        ? {}
        : { windowDetail: composition.windowDetail }),
    });

    const logLines: string[] = [
      `stage=${stage.name} role=${stage.role} runner=${resolved.runner} ` +
        `reasoning=${resolved.reasoning} startedAt=${startedAt}`,
    ];

    /**
     * The input, when the operator asked for it (§95, `execution.recordPrompts`).
     *
     * Every other line in this file describes what came *back*. An agent that did
     * something inexplicable was told something, and without this the thing it was told
     * is unrecoverable — the prompt is assembled from a dozen sources and never kept.
     *
     * Redacted with the same context and the same function as the runner's output, so
     * there is no path by which a credential reaches the log through the input that does
     * not through the output. Off by default: a prompt is a copy of whatever the stage
     * was given, and copies of repository content are not free to leave lying around.
     */
    if (config.execution.recordPrompts) {
      logLines.push(
        '--- prompt (redacted) ---',
        redactEvidence(promptText, this.redactionContext(options)),
        '--- end prompt ---',
      );
    }

    // **`repair`, not `attempt` (AR §4.4).** This counts re-prompts for a
    // well-formed answer inside one invocation of this stage; an *attempt* is one
    // agent invocation for one task in one prepared workspace, and the task's own
    // counter owns that word. Sharing it produced a log line reading
    // `attempt=1 failed` inside a file named `…-attempt-2.log`, which is two
    // different numbers under one name in one sentence.
    let repair = 0;
    let lastProblems: string[] = [];
    // Who produced the answer we are about to reject. Repairs can straddle a
    // fallback, so this is not a constant — and when the repairs run out, it is
    // the only record of who actually wrote the output that failed.
    let lastExecution = executionOf(undefined, resolved);

    while (repair < MAX_REPAIR_ATTEMPTS + 1) {
      repair += 1;

      const result = await runner.run({
        prompt: promptText,
        reasoning: resolved.reasoning,
        workingDirectory: options.workingDirectory ?? this.options.projectDir,
        permissions: prompt.meta.permissions,
        timeoutSeconds: resolved.timeoutSeconds,
        ...(resolved.model === undefined ? {} : { model: resolved.model }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(stage.outputSchema === undefined
          ? {}
          : { outputSchema: toJsonSchema(stage.outputSchema) }),
      });

      lastExecution = executionOf(result.provenance, resolved, result.usage);

      if (!result.ok) {
        // Infrastructure failures are not retried here: re-running immediately
        // would hit the same wall. Deciding whether to fall back belongs to the
        // caller, which is why the code travels with the error.
        //
        // **Redaction first, once, before anything is looked at or written** (AD-35,
        // I-21). Both persistence paths below and the classifier all read the same
        // redacted string, so there is no unredacted mirror and no second opinion about
        // what the runner said.
        const redactionContext = this.redactionContext(options);
        const redactedRaw = redactEvidence(result.raw, redactionContext);
        const classification = classifyRunnerFailure({
          errorCode: result.errorCode,
          redactedRaw,
        });
        const excerpt = redactAndTruncate(
          redactedRaw,
          config.recovery.maxRawExcerptBytes,
          // Already redacted; truncation is all that is left to do.
          {},
        );

        logLines.push(
          `repair=${repair} failed errorCode=${result.errorCode} failureClass=${classification.failureClass}`,
          // The full output, in the one place with room for it. This is the line whose
          // absence sent a person to read the vendor's own log directory.
          '--- runner output (redacted) ---',
          redactedRaw,
          '--- end runner output ---',
        );
        await this.writeLog(runId, stage, logLines);
        await store.appendEvent(runId, 'stage_failed', {
          stage: stage.name,
          role: stage.role,
          errorCode: result.errorCode,
          failureClass: classification.failureClass,
          ...(classification.deniedCommand === undefined
            ? {}
            : { deniedCommand: classification.deniedCommand }),
          // The head of it, bounded. The dashboard reads events; without this an
          // operator still needs a terminal to find out what happened.
          rawExcerpt: excerpt.text,
          // A failure is provenance too: it ran somewhere, at some effort, and
          // possibly after a substitution that also failed.
          ...executionDetail(lastExecution),
          repairs: repair,
          startedAt,
          finishedAt: clock.now(),
        });

        throw new StageFailure(
          stage.name,
          result.errorCode,
          `Stage "${stage.name}" failed: ${result.errorCode}`,
          redactedRaw,
          lastExecution,
          classification,
        );
      }

      logLines.push(`repair=${repair} ok durationMs=${result.durationMs}`);

      // "The runner answered" and "the answer was accepted" are two facts, and
      // `stage_completed` was carrying both. They diverged on a real run: the
      // planner returned a schema-valid plan, `checkPlan` turned it down, and the
      // log held `stage_completed` and `stage_failed` for `planning` at the same
      // timestamp — with `status` then showing `Task Planning ✓` on a FAILED run.
      //
      // Emitted as well as, never instead of: every existing reader keeps working,
      // and a reader that needs the distinction now has it.
      await store.appendEvent(runId, 'stage_output_received', {
        stage: stage.name,
        role: stage.role,
        runner: lastExecution?.runner ?? resolved.runner,
        durationMs: result.durationMs,
      });

      const problems = this.validate(stage, result.text, result.json);
      if (problems.length === 0) {
        await this.persist(runId, stage, result.text);

        /**
         * What the runner said, on the path where it worked (§95).
         *
         * The failure path has written this block since the day somebody had to open a
         * vendor's own log directory to find out what an agent said. The success path
         * wrote two lines — `repair=1 ok durationMs=…` — for what a live run measured as
         * six minutes of model work. With `execution.recordPrompts` on, that log then held
         * the question and not the answer, which is the same asymmetry inverted.
         *
         * A stage with an artifact gets a pointer instead of a copy. Its answer is already
         * on disk under a name, and two copies of one document is how a reader ends up
         * comparing them.
         *
         * Redacted with the same context and the same function as everywhere else, so no
         * credential reaches a log through this door that would not through the others.
         */
        logLines.push(
          ...(stage.artifact === undefined
            ? [
                '--- runner output (redacted) ---',
                redactEvidence(result.text, this.redactionContext(options)),
                '--- end runner output ---',
              ]
            : [`answer written to artifact "${stage.artifact}"`]),
        );

        await this.writeLog(runId, stage, logLines);

        const execution = lastExecution;

        await store.updateRun(runId, (state) => ({ ...state, stage: stage.name }));
        await store.appendEvent(runId, 'stage_completed', {
          stage: stage.name,
          role: stage.role,
          // What ran, not what was resolved. A stage that fell back was logged
          // under the runner that was *down* — so every reader of the event log
          // inherited configured intent where the invariant is that actual
          // execution wins. The two agree except in the one case worth seeing.
          ...executionDetail(execution),
          repairs: repair,
          startedAt,
          finishedAt: clock.now(),
        });

        return {
          text: result.text,
          ...(stage.outputSchema === undefined
            ? {}
            : { data: stage.outputSchema.parse(result.json ?? safeJson(result.text)) }),
          runner: execution.runner,
          repairs: repair,
          execution,
        };
      }

      lastProblems = problems;
      logLines.push(`repair=${repair} invalid: ${problems.join('; ')}`);

      // The retry has to say what was wrong. Asking again without the reason is
      // a coin flip, and an expensive one.
      promptText =
        `${basePrompt}\n\n---\n\n` +
        `Your previous response was rejected because it did not satisfy the required format:\n` +
        `${problems.map((problem) => `  - ${problem}`).join('\n')}\n\n` +
        `Return a corrected response. Output only the response itself.`;
    }

    await this.writeLog(runId, stage, logLines);
    await store.appendEvent(runId, 'stage_failed', {
      stage: stage.name,
      role: stage.role,
      errorCode: 'invalid_output',
      ...executionDetail(lastExecution),
      repairs: repair,
      startedAt,
      finishedAt: clock.now(),
      problems: lastProblems,
    });

    throw new StageFailure(
      stage.name,
      'invalid_output',
      `Stage "${stage.name}" produced output that never satisfied its contract ` +
        `after ${String(repair)} attempts:\n${lastProblems.map((p) => `  - ${p}`).join('\n')}`,
      undefined,
      lastExecution,
    );
  }

  /** Schema first, then any structural checks the stage adds. */
  private validate(stage: StageDefinition, text: string, json: unknown): string[] {
    const problems: string[] = [];

    /**
     * An empty answer is a failed stage, not a successful one (PRI-22).
     *
     * A live run found this the expensive way. `discovery` completed in 31 seconds having
     * produced 2,709 output tokens — the accounting says so — and returned an empty string.
     * No schema, no structural check, so `problems` was empty and the stage was recorded
     * `stage_completed`. The failure surfaced two stages later as
     * `Prompt "architecture-impact" is missing required variables: architecture`, which
     * names the wrong stage, the wrong file and the wrong problem.
     *
     * Checked before the schema so the message says what actually happened. A schema-bearing
     * stage would otherwise report "expected a JSON object, got unparseable output", which
     * is true of an empty string and describes a malformed answer rather than an absent one.
     *
     * `json` is consulted because a runner can return a parsed object with empty raw text,
     * and an answer that satisfies the contract is an answer whatever the text looks like.
     */
    if (text.trim() === '' && json === undefined) {
      problems.push(
        'the runner returned an empty answer; nothing was written and no later stage can use it',
      );
      // Returned rather than accumulated: every check below describes the *shape* of an
      // answer, and there is none to describe.
      return problems;
    }

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
    const paths = runPaths(this.options.projectDir, runId);
    await this.options.fs.mkdirp(paths.logsDir);
    await this.options.fs.writeFileAtomic(
      paths.log(stage.logName ?? stage.name),
      `${lines.join('\n')}\n`,
    );
  }
}

/**
 * The roots a runner's output is likely to name, for redaction (AD-35).
 *
 * The working directory rather than the project directory: in worktree mode the agent ran
 * inside `~/.agent-flow/worktrees/…`, and that is the absolute path its output quotes.
 */
function redactionContextOf(options: {
  readonly workingDirectory: string;
  readonly home?: string;
}): { workspaceRoot: string; home?: string } {
  return {
    workspaceRoot: options.workingDirectory,
    ...(options.home === undefined ? {} : { home: options.home }),
  };
}

/**
 * The execution, flattened into event detail.
 *
 * One shape for every event that reports a finished attempt, so a reader of
 * `events.jsonl` — `status`, telemetry, a future dashboard — never has to know
 * which event it is looking at to find out who actually ran.
 */
export function executionDetail(execution: StageExecution): Record<string, unknown> {
  return {
    runner: execution.runner,
    ...(execution.model === undefined ? {} : { model: execution.model }),
    reasoning: execution.reasoning,
    reasoningClamped: execution.reasoningClamped,
    ...(execution.fallback === undefined ? {} : { fallback: execution.fallback }),
    // What it spent, when the runner said (PRI-19). Emitted on `stage_completed` and
    // `stage_failed` alike, through this one function, so the event log can total a run's
    // cost without a reader knowing which event it is looking at.
    ...(execution.usage === undefined ? {} : { usage: execution.usage }),
  };
}

/**
 * The model, in a sentence, or nothing.
 *
 * A separate function because the alternative is a ternary inside a template literal that
 * produces `runner "agy" ` with a trailing space when no model is configured — and a
 * degradation message is read by people.
 */
function describeModel(model: string | undefined): string {
  return model === undefined ? '' : ` on model "${model}"`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
}

/**
 * Reconciles what was asked for with what the runner reported.
 *
 * The runner's own account wins where it exists: the two differ exactly when a
 * fallback fired, which is the case worth recording. Built here, in one place,
 * so success and failure describe the run the same way — a failed stage still
 * ran somewhere, at some effort, and saying otherwise is a fabrication.
 */
function executionOf(
  provenance: RunProvenance | undefined,
  resolved: ResolvedAgentConfig,
  /**
   * What the runner reported spending, when it reported anything (PRI-19).
   *
   * Separate from `provenance` because they come from different places and only one of
   * them is a substitution: usage is present on an ordinary call and provenance is not.
   */
  usage?: RunUsage,
): StageExecution {
  const spent = usage === undefined ? {} : { usage };

  if (provenance === undefined) {
    return {
      runner: resolved.runner,
      ...(resolved.model === undefined ? {} : { model: resolved.model }),
      reasoning: resolved.reasoning,
      reasoningClamped: resolved.reasoningClamped,
      ...spent,
    };
  }

  return {
    runner: provenance.runner,
    ...(provenance.model === undefined ? {} : { model: provenance.model }),
    reasoning: provenance.reasoning,
    reasoningClamped: provenance.reasoningClamped,
    fallback: {
      from: provenance.substitutedFor.runner,
      errorCode: provenance.substitutedFor.errorCode,
    },
    ...spent,
  };
}
