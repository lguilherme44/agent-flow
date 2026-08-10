import { stringify as toYaml } from 'yaml';
import {
  TaskResultSchema,
  type EffectiveConfig,
  type Task,
  type TaskResult,
} from '../contracts/index.js';
import type { Clock, FileSystem, ProcessRunner } from '../ports/index.js';
import { routeTask, type RoutingPolicy } from '../core/router.js';
import { StageFailure, type StageRunner } from './stage-runner.js';
import type { StateStore } from './state-store.js';
import { runPaths } from './paths.js';
import { runCommands } from './verification-commands.js';
import { buildValidationRegistry } from '../core/validation-registry.js';
import { judgeValidation } from '../core/validation-outcome.js';

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

  async execute(task: Task, runId: string, sdd: string): Promise<TaskResult> {
    const { store, clock, stageRunner, config, projectDir } = this.options;

    const role = routeTask(task, this.options.routingPolicy);
    const startedAt = clock.now();

    await store.appendEvent(runId, 'task_started', { task: task.id, role });

    let text: string;
    let runner = 'unknown';
    // What actually ran. Populated from the stage result rather than from the
    // resolution, because a fallback may have sent the work elsewhere.
    let execution: {
      runner: string;
      model?: string;
      reasoning: TaskResult['reasoning'];
      reasoningClamped: boolean;
      fallback?: { from: string; errorCode: NonNullable<TaskResult['errorCode']> };
    } = { runner: 'unknown', reasoning: 'medium', reasoningClamped: false };

    try {
      const result = await stageRunner.run(
        {
          name: 'implementation',
          role,
          prompt: 'implementation',
        },
        runId,
        {
          task: toYaml(task).trim(),
          sdd,
          projectConfig: config.project === undefined ? 'None.' : toYaml(config.project).trim(),
          agentsMd: await this.readAgentsMd(),
        },
      );
      text = result.text;
      runner = result.runner;
      execution = result.execution;
    } catch (error) {
      const failure = error instanceof StageFailure ? error : undefined;
      return this.persist(runId, {
        task: task.id,
        status: 'failed',
        ...provenanceOf(execution, runner),
        startedAt,
        finishedAt: clock.now(),
        validation: { passed: false, commands: [] },
        notes: [failure?.message ?? String(error)],
        ...(failure === undefined ? {} : { errorCode: failure.errorCode }),
      });
    }

    const report = parseResultBlock(text);

    if (report.status === 'BLOCKED') {
      // Not retried, by design (§23). BLOCKED means a decision is missing, and
      // running the same prompt again produces the same gap — or worse, a guess.
      return this.persist(runId, {
        task: task.id,
        status: 'blocked',
        ...provenanceOf(execution, runner),
        startedAt,
        finishedAt: clock.now(),
        filesChanged: report.filesChanged,
        validation: { passed: false, commands: [] },
        notes: report.notes,
        errorCode: 'blocked',
      });
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
      return this.persist(runId, {
        task: task.id,
        status: 'review_required',
        ...provenanceOf(execution, runner),
        startedAt,
        finishedAt: clock.now(),
        filesChanged: report.filesChanged,
        validation: { passed: false, commands: [] },
        notes: [
          ...report.notes,
          `validation ${unresolved.map((entry) => `"${entry.id}"`).join(', ')} ` +
            `is not defined by the project configuration`,
        ],
      });
    }

    const verification =
      commands.length === 0 || task.validationExpectation === 'none'
        ? { passed: true, results: [] }
        : await runCommands({
            processRunner: this.options.processRunner,
            commands: commands.map((entry) => entry.command as string),
            cwd: projectDir,
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

    return this.persist(runId, {
      task: task.id,
      status: judgement.state,
      ...provenanceOf(execution, runner),
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
    });
  }

  private async persist(runId: string, result: unknown): Promise<TaskResult> {
    const parsed = TaskResultSchema.parse(result);
    const path = runPaths(this.options.projectDir, runId).taskResult(parsed.task);

    await this.options.fs.mkdirp(path.slice(0, path.lastIndexOf('/')));
    await this.options.fs.writeFileAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`);

    await this.options.store.appendEvent(runId, 'task_finished', {
      task: parsed.task,
      status: parsed.status,
      runner: parsed.runner,
      validationPassed: parsed.validation.passed,
    });

    return parsed;
  }

  private async readAgentsMd(): Promise<string> {
    const path = `${this.options.projectDir}/AGENTS.md`;
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
 * Nothing here is a default standing in for the truth: when the stage never
 * ran — the runner failed before producing anything — the fields describe that
 * absence rather than inventing a plausible value.
 */
function provenanceOf(
  execution: {
    runner: string;
    model?: string;
    reasoning: TaskResult['reasoning'];
    reasoningClamped: boolean;
    fallback?: { from: string; errorCode: NonNullable<TaskResult['errorCode']> };
  },
  fallbackRunner: string,
): Pick<TaskResult, 'runner' | 'model' | 'reasoning' | 'reasoningClamped' | 'fallback'> {
  return {
    runner: execution.runner === 'unknown' ? fallbackRunner : execution.runner,
    ...(execution.model === undefined ? {} : { model: execution.model }),
    reasoning: execution.reasoning,
    reasoningClamped: execution.reasoningClamped,
    ...(execution.fallback === undefined ? {} : { fallback: execution.fallback }),
  };
}
