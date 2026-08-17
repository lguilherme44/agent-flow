import { stringify as toYaml } from 'yaml';
import {
  TaskResultSchema,
  type EffectiveConfig,
  type Task,
  type TaskResult,
  type ValidationJudgement,
} from '../contracts/index.js';
import type { Clock, FileSystem, Host, ProcessRunner } from '../ports/index.js';
import type { GitWorkspaces } from '../adapters/git/git-workspaces.js';
import { routeTask, type RoutingPolicy } from '../core/router.js';
import { StageFailure, type StageExecution, type StageRunner } from './stage-runner.js';
import type { StateStore } from './state-store.js';
import { attemptLogName, runPaths } from './paths.js';
import { runCommands } from './verification-commands.js';
import type { TaskWorkspace } from './task-workspaces.js';
import { buildValidationRegistry } from '../core/validation-registry.js';
import { judgeValidation } from '../core/validation-outcome.js';
import { recordAttempt, type AttemptDraft } from './attempt-receipt.js';

/** Marker the implementation prompt asks the agent to end with. */
const RESULT_BLOCK = /##\s*RESULT\s*([\s\S]*)$/i;

export interface TaskExecutorOptions {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly store: StateStore;
  readonly stageRunner: StageRunner;
  readonly processRunner: ProcessRunner;
  readonly config: EffectiveConfig;
  readonly projectDir: string;
  readonly routingPolicy?: RoutingPolicy;
  /**
   * Git, for the §11.2 sequence. Present only where worktree mode can happen.
   *
   * Optional together with {@link host}, because every sequential caller — and
   * every test predating M2-05 — runs in the project directory and never reaches
   * this code. An isolated attempt with neither wired cannot produce evidence,
   * and says so rather than completing without any.
   */
  readonly workspaces?: GitWorkspaces;
  /** For `randomHex`: the receipt nonce must come from a cryptographic source. */
  readonly host?: Host;
}

/**
 * What the executor knows about an attempt that the `TaskResult` does not.
 *
 * Three facts, and each is one the result shape has no room for: the agent's own
 * report as it was parsed, the validation *ids* the plan named (the result keeps
 * only the resolved commands), and the judgement §10.2 records — which is a
 * three-valued answer where `TaskState` is not.
 */
interface AttemptEvidenceInput {
  readonly judgement: ValidationJudgement;
  readonly report: ParsedReport;
  readonly validationIds: readonly string[];
}

/**
 * Runs one task.
 *
 * The division of labour is the point: the agent writes code, and agent-flow
 * decides whether it worked. Validation commands run here, through the process
 * layer (AD-10), so "the tests pass" is an exit code rather than a claim.
 */
export class TaskExecutor {
  constructor(private readonly options: TaskExecutorOptions) {}

  /**
   * Runs one task, in the workspace it was given.
   *
   * `workspace` is optional and defaults to the project directory, which is what
   * every sequential run gets and what keeps §25's compatibility promise: with
   * no workspace this method behaves exactly as it did before M2-04. In worktree
   * mode the scheduler prepares one and the three places that touch a directory
   * — the agent's cwd, the validation cwd and `AGENTS.md` — all move to it.
   *
   * That last one is load-bearing. `AGENTS.md` used to be read from the mutable
   * project directory, so a task would observe whatever the user happened to
   * have saved in their editor while agents were running, rather than the
   * `AGENTS.md` of its own base.
   */
  async execute(
    task: Task,
    runId: string,
    sdd: string,
    workspace?: TaskWorkspace,
  ): Promise<TaskResult> {
    const { store, clock, stageRunner, config } = this.options;
    const projectDir = this.options.projectDir;
    const workingDirectory = workspace?.path ?? projectDir;

    const role = routeTask(task, this.options.routingPolicy);
    const startedAt = clock.now();

    await store.appendEvent(runId, 'task_started', { task: task.id, role });

    let text: string;
    // What actually ran. Taken from the stage result rather than from the
    // resolution, because a fallback may have sent the work elsewhere — and
    // from the failure when there is no result, because a stage that failed
    // still ran somewhere.
    let execution: StageExecution | undefined;

    try {
      const result = await stageRunner.run(
        {
          name: 'implementation',
          role,
          prompt: 'implementation',
          // One log per task, and per attempt once attempts are isolated. The
          // stage name is not unique here — it runs once per task — and sharing
          // the file meant every task but the last one lost its log; sharing it
          // across attempts loses the log of exactly the attempt somebody is
          // retrying because they wanted to read it.
          logName:
            workspace?.isolation === undefined
              ? `implementation-${task.id}`
              : attemptLogName(task.id, workspace.attempt),
        },
        runId,
        {
          task: toYaml(task).trim(),
          objective: `${task.title}\n${task.description}`,
          sdd,
          projectConfig: config.project === undefined ? 'None.' : toYaml(config.project).trim(),
          agentsMd: await this.readAgentsMd(workingDirectory),
        },
        { workingDirectory },
      );
      text = result.text;
      execution = result.execution;
    } catch (error) {
      const failure = error instanceof StageFailure ? error : undefined;
      // No attempt artifact, and deliberately: the agent produced no report, so
      // there is nothing to record as an attempt's evidence. §17.3 windows 1 and
      // 2 read "no `attempt-<n>.json`" as *the attempt's work was never
      // observed*, and that is precisely what happened here — inventing an
      // `agentReport` to have something to write would be evidence of a report
      // nobody made.
      return this.finish(
        runId,
        {
          task: task.id,
          status: 'failed',
          ...provenanceOf(failure?.execution ?? execution ?? stageRunner.plannedExecution(role)),
          startedAt,
          finishedAt: clock.now(),
          validation: { passed: false, commands: [] },
          notes: [failure?.message ?? String(error)],
          ...(failure === undefined ? {} : { errorCode: failure.errorCode }),
        },
        workspace,
        undefined,
      );
    }

    const report = parseResultBlock(text);

    if (report.status === 'BLOCKED') {
      // Not retried, by design (§23). BLOCKED means a decision is missing, and
      // running the same prompt again produces the same gap — or worse, a guess.
      return this.finish(
        runId,
        {
          task: task.id,
          status: 'blocked',
          ...provenanceOf(execution ?? stageRunner.plannedExecution(role)),
          startedAt,
          finishedAt: clock.now(),
          filesChanged: report.filesChanged,
          validation: { passed: false, commands: [] },
          notes: report.notes,
          errorCode: 'blocked',
        },
        workspace,
        // §10.2's third value, by its own definition: "the agent reported
        // BLOCKED". No validation ran, so there is nothing to be unsatisfied by.
        { judgement: 'not_reached', report, validationIds: task.validation },
      );
    }

    // Run the task's own validation ourselves rather than trusting the agent's
    // account of it (§42).
    //
    // `task.validation` holds *ids*, never commands. They are resolved here
    // against the project configuration, so the string that reaches a shell was
    // written by a human in a config file — not by a model in a plan.
    const registry = buildValidationRegistry(config.project);
    const commands = task.validation.map((id) => ({ id, command: registry.resolve(id) }));
    const unresolved = commands.filter((entry) => entry.command === undefined);

    if (unresolved.length > 0) {
      // Reachable only when configuration changed after the plan was approved:
      // checkPlan rejects unknown ids at planning time. Treated as a failure
      // rather than skipped, because silently not validating is worse than
      // stopping.
      return this.finish(
        runId,
        {
          task: task.id,
          status: 'review_required',
          ...provenanceOf(execution ?? stageRunner.plannedExecution(role)),
          startedAt,
          finishedAt: clock.now(),
          filesChanged: report.filesChanged,
          validation: { passed: false, commands: [] },
          notes: [
            ...report.notes,
            `validation ${unresolved.map((entry) => `"${entry.id}"`).join(', ')} ` +
              `is not defined by the project configuration`,
          ],
        },
        workspace,
        // Not `unsatisfied`: that value means validation ran and the expectation
        // was not met. Nothing ran here, so the expectation was never reached.
        { judgement: 'not_reached', report, validationIds: task.validation },
      );
    }

    const verification =
      commands.length === 0 || task.validationExpectation === 'none'
        ? { passed: true, results: [] }
        : await runCommands({
            processRunner: this.options.processRunner,
            commands: commands.map((entry) => entry.command as string),
            // The same tree the agent wrote in. Validating the project directory
            // while the work happened elsewhere would judge a tree the task never
            // touched (§4.2, I-4).
            cwd: workingDirectory,
          });

    // Judged against what the task expected, not against exit zero. A test-first
    // task is done when its new tests *fail*; the previous rule sent exactly
    // that task to review. Anything unexpected — in either direction — goes to
    // review rather than to another model (§55): a failure is information about
    // the work, and rerouting it would replace a visible problem with a quiet
    // one.
    const judgement = judgeValidation(task.validationExpectation, {
      passed: verification.passed,
      ran: verification.results.length,
    });

    return this.finish(
      runId,
      {
        task: task.id,
        status: judgement.state,
        ...provenanceOf(execution ?? stageRunner.plannedExecution(role)),
        startedAt,
        finishedAt: clock.now(),
        filesChanged: report.filesChanged,
        validation: {
          passed: verification.passed,
          expectation: task.validationExpectation,
          commands: verification.results,
        },
        notes: [
          ...report.notes,
          ...report.deviations.map((d) => `deviation: ${d}`),
          ...(judgement.note === undefined ? [] : [judgement.note]),
        ],
      },
      workspace,
      {
        // The same decision, in the attempt's vocabulary. `judgeValidation` is
        // unchanged and is still the only thing that decides it (I-4): the
        // expectation is evaluated once, here, and never re-evaluated later.
        judgement: judgement.state === 'completed' ? 'satisfied' : 'unsatisfied',
        report,
        validationIds: task.validation,
      },
    );
  }

  /**
   * Records what happened, in the form the run's mode calls for.
   *
   * Two modes, two artifacts, and the difference is what each one *means*
   * (§10.1). A sequential run writes `result.json`, exactly as it always has.
   * An isolated run writes `attempt-<n>.json` — evidence of one local execution
   * — and **does not write `result.json` at all**, because in worktree mode a
   * task's outcome is decided at integration and a file on disk saying
   * `"status": "completed"` for work that has not reached the integration branch
   * is a lie recovery would believe (I-3). The Integrator writes that file, and
   * it does not exist yet (M2-06).
   */
  private async finish(
    runId: string,
    result: unknown,
    workspace: TaskWorkspace | undefined,
    evidence: AttemptEvidenceInput | undefined,
  ): Promise<TaskResult> {
    const parsed = TaskResultSchema.parse(result);

    if (workspace === undefined || workspace.isolation === undefined) {
      const path = runPaths(this.options.projectDir, runId).taskResult(parsed.task);
      await this.options.fs.mkdirp(path.slice(0, path.lastIndexOf('/')));
      await this.options.fs.writeFileAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`);
      return this.announce(runId, parsed);
    }

    if (evidence === undefined) return this.announce(runId, parsed);

    const recorded = await this.recordAttempt(runId, parsed, workspace, evidence);
    if (recorded === null) return this.announce(runId, parsed);

    // Evidence could not be produced. The judgement itself is untouched — it was
    // made by `judgeValidation` and is not revisited (I-4) — but a task cannot be
    // reported as done when nothing recorded that it was: without an artifact
    // there is no receipt, without a receipt there is no marker, and without a
    // marker nothing can ever be integrated. This is the same shape as a crash in
    // the same window (§17.3 window 2), and it is reported the same way.
    //
    // **No `errorCode`, deliberately.** `RunnerErrorCodeSchema` is the vocabulary
    // of *runner* failures — adapters translate their CLI's errors into it, and
    // `doctor`, the health model and the CLI's hints all read it as "the agent's
    // process went wrong". Here the runner did its work and Git could not record
    // it, so any code in that enum would name the wrong subsystem and send a
    // person to read the wrong log. The note carries the module's own code
    // (`validated_tree_uncapturable`, `attempt_artifact_exists`, …), which is the
    // one that is true.
    const demoted =
      parsed.status === 'completed'
        ? TaskResultSchema.parse({
            ...parsed,
            status: 'failed',
            notes: [...parsed.notes, recorded],
          })
        : TaskResultSchema.parse({ ...parsed, notes: [...parsed.notes, recorded] });

    return this.announce(runId, demoted);
  }

  /**
   * The §11.2 sequence, and the two events Appendix B defines for it.
   *
   * Returns `null` on success and a path-free sentence when the evidence could
   * not be produced. The events are emitted here rather than inside
   * `attempt-receipt.ts` so that module keeps no `StateStore`: it decides what is
   * true about an attempt, and this decides what the run is told.
   */
  private async recordAttempt(
    runId: string,
    result: TaskResult,
    workspace: TaskWorkspace,
    evidence: AttemptEvidenceInput,
  ): Promise<string | null> {
    const isolation = workspace.isolation;
    const { workspaces, host } = this.options;

    if (isolation === undefined || workspaces === undefined || host === undefined) {
      return 'this attempt ran in an isolated workspace and no Git access was wired to record it';
    }

    const state = await this.options.store.loadRun(runId);
    if (state.gitRunKey === undefined) {
      return 'this run has no Git namespace, so an attempt marker cannot be named';
    }

    const draft: AttemptDraft = {
      run: runId,
      task: result.task,
      attempt: workspace.attempt,
      base: isolation.base,
      branch: isolation.branch,
      // Workspace-relative, never the absolute path the agent actually ran in
      // (§7.2, §21.3). The absolute root is a machine fact this process resolved
      // and is about to forget.
      workspace: isolation.relativePath,
      runner: result.runner,
      ...(result.model === undefined ? {} : { model: result.model }),
      reasoning: result.reasoning,
      reasoningClamped: result.reasoningClamped,
      ...(result.fallback === undefined ? {} : { fallback: result.fallback }),
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      filesChanged: result.filesChanged,
      agentReport: {
        status: evidence.report.status,
        notes: evidence.report.notes,
        deviations: evidence.report.deviations,
        // The agent's own list, recorded *as a claim* (AD-39). `filesChanged` above is
        // still sourced from the same parse today; AR-05a makes it mechanical, and this
        // field is what lets the two be compared once it is. Recording the claim now
        // means the comparison has something to compare against from the first run.
        claimedFilesChanged: evidence.report.filesChanged,
      },
      validation: {
        expectation: result.validation.expectation,
        passed: result.validation.passed,
        ids: [...evidence.validationIds],
        commands: result.validation.commands,
      },
      validationJudgement: evidence.judgement,
      ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
    };

    const outcome = await recordAttempt(
      {
        workspaces,
        fs: this.options.fs,
        clock: this.options.clock,
        host,
        projectDir: this.options.projectDir,
      },
      { draft, workspacePath: workspace.path, gitRunKey: state.gitRunKey },
    );

    if (!outcome.ok) return `${outcome.failure.code}: ${outcome.failure.detail}`;

    await this.options.store.appendEvent(runId, 'task_attempt_validated', {
      task: draft.task,
      attempt: draft.attempt,
      judgement: draft.validationJudgement,
      validationIds: draft.validation.ids,
    });

    const marker = outcome.value.marker;
    if (marker !== undefined) {
      await this.options.store.appendEvent(runId, 'task_attempt_marker_created', {
        task: draft.task,
        attempt: draft.attempt,
        marker: marker.oid,
        tree: marker.tree,
      });
    }

    return null;
  }

  private async announce(runId: string, parsed: TaskResult): Promise<TaskResult> {
    await this.options.store.appendEvent(runId, 'task_finished', {
      task: parsed.task,
      status: parsed.status,
      runner: parsed.runner,
      validationPassed: parsed.validation.passed,
    });

    return parsed;
  }

  private async readAgentsMd(workingDirectory: string): Promise<string> {
    const path = `${workingDirectory}/AGENTS.md`;
    return (await this.options.fs.exists(path))
      ? this.options.fs.readFile(path)
      : 'No AGENTS.md in this repository.';
  }
}

export interface ParsedReport {
  readonly status: 'COMPLETED' | 'BLOCKED';
  readonly filesChanged: string[];
  readonly deviations: string[];
  readonly notes: string[];
}

/**
 * Reads the report block the implementation prompt asks for.
 *
 * Lenient on purpose: the block is a convention, and a response that did the
 * work but formatted the summary badly should not be thrown away. The one thing
 * treated strictly is BLOCKED — missing it would let a task that stopped for a
 * missing decision be recorded as done.
 */
export function parseResultBlock(text: string): ParsedReport {
  const block = RESULT_BLOCK.exec(text)?.[1] ?? text;

  const status = /STATUS:\s*BLOCKED/i.test(block) ? 'BLOCKED' : 'COMPLETED';

  const section = (name: string): string[] => {
    const pattern = new RegExp(`${name}:\\s*\\n([\\s\\S]*?)(?=\\n[A-Z][A-Z ]+:|$)`, 'i');
    const body = pattern.exec(block)?.[1] ?? '';
    return body
      .split('\n')
      .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
      .filter((line) => line.length > 0 && !/^none$/i.test(line));
  };

  return {
    status,
    filesChanged: section('FILES CHANGED'),
    deviations: section('DEVIATIONS'),
    notes: section('NOTES'),
  };
}

/**
 * Flattens the recorded execution into the shape `TaskResult` persists.
 *
 * Nothing here stands in for the truth. The caller supplies what ran — from the
 * result, from the failure, or from the role's resolution when neither exists —
 * so a failed task says which runner was tried and at what effort. It once said
 * `unknown` at `medium`, which reads like a fact and is not one: `medium` in
 * particular is a real level a run can have, so a task configured at `high` and
 * failed would have been indistinguishable from one that genuinely ran low.
 */
function provenanceOf(
  execution: StageExecution,
): Pick<TaskResult, 'runner' | 'model' | 'reasoning' | 'reasoningClamped' | 'fallback'> {
  return {
    runner: execution.runner,
    ...(execution.model === undefined ? {} : { model: execution.model }),
    reasoning: execution.reasoning,
    reasoningClamped: execution.reasoningClamped,
    ...(execution.fallback === undefined ? {} : { fallback: execution.fallback }),
  };
}
