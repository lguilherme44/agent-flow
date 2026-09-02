import { isAbsolute, relative } from 'node:path';
import { renderFailureContext } from '../core/failure-context.js';
import { stringify as toYaml } from 'yaml';
import {
  FailedAttemptSchema,
  FailureContextPacketSchema,
  TaskResultSchema,
  type EffectiveConfig,
  type AgentIdentity,
  type Task,
  type TaskResult,
  type ValidationJudgement,
  type WorkflowRole,
} from '../contracts/index.js';
import { consumesAttempt } from '../core/failure-classification.js';
import { redactAndTruncate } from '../core/evidence-redaction.js';
import {
  assertObservableChange,
  assertScopeContainment,
  buildAcceptanceMap,
  type AcceptanceAssertion,
  type AcceptanceEntry,
} from '../core/acceptance.js';

/** What Git observed about one attempt. Owned by `attempt-receipt.ts`; named here for use. */
type ObservedChange = AttemptChange;

/**
 * AD-38's two assertions, in order, most disabling first.
 *
 * "Did it do anything" precedes "did it stay in bounds" because a task that changed
 * nothing cannot have left its scope, and reporting the second would describe a diff that
 * does not exist.
 */
function assertAcceptance(task: Task, observed: ObservedChange): AcceptanceAssertion {
  const effect = assertObservableChange({
    ...(observed.baseTree === undefined ? {} : { baseTree: observed.baseTree }),
    ...(observed.validatedTree === undefined ? {} : { validatedTree: observed.validatedTree }),
    ...(task.expectsNoChange === undefined ? {} : { expectsNoChange: task.expectsNoChange }),
  });
  if (!effect.satisfied) return effect;

  if (observed.changedFiles === undefined) return effect;

  return assertScopeContainment({
    changedFiles: observed.changedFiles,
    filesLikely: task.files.likely,
    ...(task.scopeMode === undefined ? {} : { scopeMode: task.scopeMode }),
  });
}

/**
 * A note when Git and the agent disagree about what changed (AD-39).
 *
 * Informative, never blocking. The two agreed in the evidence run, which is a fact about
 * that agent on that day rather than a guarantee — and a divergence is worth a reviewer's
 * eye even when the mechanical list is the one that counts.
 */
function divergenceNote(
  mechanical: readonly string[] | undefined,
  claimed: readonly string[],
): string[] {
  if (mechanical === undefined) return [];

  const actual = new Set(mechanical);
  const said = new Set(claimed);
  const unclaimed = [...actual].filter((path) => !said.has(path));
  const unmade = [...said].filter((path) => !actual.has(path));
  if (unclaimed.length === 0 && unmade.length === 0) return [];

  const parts: string[] = [];
  if (unclaimed.length > 0) parts.push(`changed but not reported: ${unclaimed.join(', ')}`);
  if (unmade.length > 0) parts.push(`reported but not changed: ${unmade.join(', ')}`);

  return [`report_divergence: ${parts.join('; ')}`];
}
import type { Clock, FileSystem, Host, ProcessRunner } from '../ports/index.js';
import type { GitWorkspaces } from '../adapters/git/git-workspaces.js';
import { routeTask, type RoutingPolicy } from '../core/router.js';
import { resolveRole, type RunnerCapabilitiesMap } from '../core/role.js';
import type { TaskAssignment } from '../contracts/index.js';
import { StageFailure, type StageExecution, type StageRunner } from './stage-runner.js';
import type { StateStore } from './state-store.js';
import { attemptLogName, runPaths } from './paths.js';
import { runCommands } from './verification-commands.js';
import type { TaskWorkspace } from './task-workspaces.js';
import type { CollaborationBlocks, CollaborationService } from './collaboration-service.js';
import { buildCollaborationBootstrap } from '../core/collaboration/context.js';
import { buildValidationRegistry } from '../core/validation-registry.js';
import { judgeValidation } from '../core/validation-outcome.js';
import {
  captureAttemptChange,
  recordAttempt,
  type AttemptChange,
  type AttemptDraft,
} from './attempt-receipt.js';

/**
 * The router's answer, shaped as an assignment.
 *
 * Used wherever the policy cannot be asked — no collaboration service wired, or the ask
 * itself went wrong. **The fallback is the whole safety property**: an assignment is
 * model-influenced input, so a bug in reading it must never leave a task unassigned or
 * assigned to nobody. The worst case is the answer M4 gave.
 */
function fallbackAssignment(taskId: string, role: WorkflowRole, now: string): TaskAssignment {
  return { taskId, agentId: role, role, reason: 'routed', candidates: [], assignedAt: now };
}

/** Marker the implementation prompt asks the agent to end with. */
const RESULT_BLOCK = /##\s*RESULT\s*([\s\S]*)$/i;

/**
 * How much of a repository's `AGENTS.md` reaches a prompt.
 *
 * Generous — a real one is a page or two, and 64 KiB is many pages. The number is not
 * about typical files; it is about there being a number at all, so that the size of every
 * implementation prompt is a decision this repository made rather than one the repository
 * under test makes.
 */
const MAX_AGENTS_MD_BYTES = 64 * 1024;

/**
 * Whether a resolved path sits under a resolved root.
 *
 * Both sides must already be real paths: this is the lexical half of a check whose other
 * half is `realPath`, and running it on unresolved paths would answer confidently about
 * the wrong two files.
 */
function isWithin(root: string, candidate: string): boolean {
  const inside = relative(root, candidate);
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
}

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
  /**
   * Reads what the agent left in its outbox, when the run allows agents to speak (M4-02).
   *
   * Optional in exactly the way {@link workspaces} and the Integrator are: absent, no
   * outbox is read and every existing caller behaves as it did. Present but disabled by
   * configuration, the same — the service answers with silence.
   *
   * **Where it is called is the whole guarantee** (I-32): after the agent's process has
   * exited, and before {@link TaskExecutor.observeChange} stages the tree. One line earlier
   * and the file would be read while the agent could still rewrite it; one line later and
   * `git add -A` would have staged it into the tree a marker is bound to.
   */
  readonly collaboration?: CollaborationService;
  /**
   * What each runner can do, for the handoff capability gate (M4-04).
   *
   * Optional together with {@link collaboration}: without it a handoff is refused rather
   * than granted, which is the conservative direction — granting execution to an agent
   * whose capabilities nobody checked is the one outcome the gate exists to prevent.
   */
  readonly capabilities?: RunnerCapabilitiesMap;
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
  /** What Git observed, so the artifact records the same tree the decision used (AD-38). */
  readonly observed?: ObservedChange;
  /** Every acceptance criterion and what demonstrates it (C-15). */
  readonly acceptance?: readonly AcceptanceEntry[];
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
    /**
     * Ends this attempt, and the agent's process tree, before its timeout (PRI-14).
     *
     * Per execution rather than on the executor, because it belongs to the *run* that is
     * being cancelled and one executor serves many attempts.
     */
    signal?: AbortSignal,
  ): Promise<TaskResult> {
    const { store, clock, stageRunner, config } = this.options;
    const projectDir = this.options.projectDir;
    const workingDirectory = workspace?.path ?? projectDir;

    const role = routeTask(task, this.options.routingPolicy);

    // **Who executes this task** (M4-04). Asked unconditionally and answering `role` for
    // almost every task: a seam that only existed while a flag was on would be a function
    // nobody calls. `assignment.agentId` is the *speaker* for everything below — the
    // context it is shown, and the `from` on anything it says.
    const assignment = await this.assignAgent(runId, task, role);
    const startedAt = clock.now();

    await store.appendEvent(runId, 'task_started', {
      task: task.id,
      role,
      // Additive on an open record (§8), and only when it says something the role does
      // not: a `reason: 'routed'` on every task would be a field nobody reads.
      ...(assignment.reason === 'routed' ? {} : { agent: assignment.agentId, assignment: assignment.reason }),
    });

    const collaborationBlocks = await this.collaborationContextFor(runId, task, assignment.agentId);

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
          failureContext: await this.readFailureContext(runId, task.id, workspace?.attempt ?? 1),
        },
        {
          workingDirectory,
          complexity: task.complexity,
          // AR-09: what this attempt's context cost, attributable to this attempt.
          task: task.id,
          ...(workspace?.attempt === undefined ? {} : { attempt: workspace.attempt }),
          // M5. Two blocks, two sources. The bootstrap goes out whenever the channel is
          // open; the payload only when a mechanical rule says something concerns this
          // agent. With the feature off both are absent and the prompt is byte-for-byte
          // what it was before M4.
          ...(collaborationBlocks.bootstrap === undefined
            ? {}
            : { collaborationBootstrap: collaborationBlocks.bootstrap }),
          ...(collaborationBlocks.context === undefined
            ? {}
            : { collaborationContext: collaborationBlocks.context }),
          // Reaches the agent's process group (PRI-14). An aborted invocation comes back
          // as an ordinary failure, so the `catch` below records the attempt exactly as it
          // records any other — cancel keeps evidence, it does not erase it.
          ...(signal === undefined ? {} : { signal }),
        },
      );
      text = result.text;
      execution = result.execution;
    } catch (error) {
      const failure = error instanceof StageFailure ? error : undefined;
      const finishedAt = clock.now();
      const failedExecution =
        failure?.execution ?? execution ?? stageRunner.plannedExecution(role);

      // **Harvested on the failure path too, and for two reasons.**
      //
      // An agent that timed out may have asked a question before it stopped, and that
      // question is often the most useful thing the attempt produced. And in sequential
      // mode the outbox lives in the *user's own working tree*: leaving it there would put
      // a file nobody wrote into their `git status`. No tree is captured on this path — a
      // failed attempt produces no receipt and no marker — so the ordering constraint is
      // slack here, but the cleanup is not optional.
      const failedNotes = await this.harvestCollaboration(runId, task, assignment.agentId, workingDirectory);

      // Still no `attempt-<n>.json`, and still deliberately: the agent produced no report,
      // so there is nothing to record as an attempt's *work*. §17.3 windows 1 and 2 read
      // "no `attempt-<n>.json`" as *the attempt's work was never observed*, and inventing
      // an `agentReport` to have something to write would be evidence of a report nobody
      // made.
      //
      // **What that reasoning overshot is the failure itself** (AD-34). Error code,
      // provenance, redacted output and duration all exist, and discarding them left the
      // only attempts with no persisted record as exactly the ones somebody needed to
      // diagnose. So a *differently named* artifact carries them, which keeps the window
      // semantics literally true.
      await this.writeFailedAttempt({
        runId,
        task,
        workspace,
        execution: failedExecution,
        failure,
        startedAt,
        finishedAt,
      });

      return this.finish(
        runId,
        {
          task: task.id,
          status: 'failed',
          ...provenanceOf(failedExecution),
          startedAt,
          finishedAt,
          validation: { passed: false, commands: [] },
          notes: [failure?.message ?? String(error), ...failedNotes],
          ...(failure === undefined ? {} : { errorCode: failure.errorCode }),
          // Named on the result too, so no surface has to open an artifact to find out
          // what kind of failure it is reporting.
          ...(failure === undefined ? {} : { failureClass: failure.failureClass }),
          ...(failure?.deniedCommand === undefined
            ? {}
            : { deniedCommand: failure.deniedCommand }),
        },
        workspace,
        undefined,
      );
    }

    const report = parseResultBlock(text);

    // **The agent has exited; the tree has not been captured. This is the window** (I-32).
    //
    // The outbox is read and removed here and nowhere else. Earlier, and the agent could
    // still be writing it. Later — after `observeChange` below runs `git add -A` — and the
    // file would already be inside the tree the receipt is bound to, which would put
    // agent-authored content into a marker.
    //
    // Nothing it returns changes what happens next. `collaborationNotes` are prose on the
    // result; no branch below reads them, and no message can complete, block or fail a
    // task (I-27).
    const collaborationNotes = await this.harvestCollaboration(runId, task, assignment.agentId, workingDirectory);

    // **What Git says this attempt did** (AD-38, AD-39). Captured once, as soon as the
    // agent has exited, and handed to every path below — the judgement, the assertions,
    // the receipt and the two early exits. An agent that stopped at BLOCKED may still have
    // written files before it stopped, and the record of which ones should be Git's answer
    // there too.
    const observed = await this.observeChange(workspace);
    const filesChanged = observed.changedFiles ?? report.filesChanged;

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
          filesChanged,
          validation: { passed: false, commands: [] },
          notes: [...report.notes, ...collaborationNotes],
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
          filesChanged,
          validation: { passed: false, commands: [] },
          notes: [
            ...report.notes,
            ...collaborationNotes,
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
    //
    // `changed` is what C-14 adds: a red suite is a fact about the repository, and
    // "this task reddened it" is the claim being judged.
    const judgement = judgeValidation(task.validationExpectation, {
      passed: verification.passed,
      ran: verification.results.length,
      ...(observed.changed === undefined ? {} : { changed: observed.changed }),
    });

    // AD-38's two assertions, evaluated only where the judgement would otherwise let the
    // task through. A task already heading for review does not need a second reason, and
    // stacking them would replace the specific note with a less specific one.
    const acceptance =
      judgement.state === 'completed' ? assertAcceptance(task, observed) : undefined;

    const state = acceptance?.satisfied === false ? 'review_required' : judgement.state;

    return this.finish(
      runId,
      {
        task: task.id,
        status: state,
        ...provenanceOf(execution ?? stageRunner.plannedExecution(role)),
        startedAt,
        finishedAt: clock.now(),
        filesChanged,
        validation: {
          passed: verification.passed,
          expectation: task.validationExpectation,
          commands: verification.results,
        },
        notes: [
          ...report.notes,
          ...collaborationNotes,
          ...report.deviations.map((d) => `deviation: ${d}`),
          ...(judgement.note === undefined ? [] : [judgement.note]),
          ...(acceptance?.satisfied === false ? [acceptance.detail] : []),
          ...divergenceNote(observed.changedFiles, report.filesChanged),
        ],
        ...(judgement.failureClass === undefined
          ? {}
          : { failureClass: judgement.failureClass }),
        // The assertion's class wins where it fired: it is the more specific statement,
        // and it is the one that names what a person has to look at.
        ...(acceptance?.satisfied === false ? { failureClass: acceptance.failureClass } : {}),
      },
      workspace,
      {
        // The same decision, in the attempt's vocabulary. `judgeValidation` is
        // still the only thing that decides the *validation* question (I-4); AD-38's
        // assertions are a separate question about the diff, asked once, here.
        judgement: state === 'completed' ? 'satisfied' : 'unsatisfied',
        report,
        validationIds: task.validation,
        observed,
        acceptance: buildAcceptanceMap({
          criteria: task.acceptanceCriteria,
          validation: verification.results.map((command, index) => ({
            id: task.validation[index] ?? command.command,
            exitCode: command.exitCode,
          })),
          changedFiles: observed.changedFiles ?? [],
        }),
      },
    );
  }

  /**
   * What Git says this attempt changed (AD-38, AD-39).
   *
   * **One capture, handed to everyone.** The validated tree used to be written inside
   * `recordAttempt`, after the judgement had already been made — so the decision "is this
   * task done" was taken without the one measurement that could answer it. Capturing here
   * and passing the result down means the judgement, the assertions and the receipt all
   * describe the same tree, and a second `write-tree` cannot disagree with the first.
   *
   * Every field is absent in sequential mode. That is not a degraded answer, it is the
   * true one: no workspace was cut, so there is no base to compare against.
   */
  /**
   * Who executes this task (M4-04).
   *
   * Falls back to the router's answer on absence, on a disabled feature and on anything
   * going wrong — and the fallback is the *whole* safety property, not defensive tidiness.
   * A handoff is model output, so a bug in reading it must never be able to leave a task
   * unassigned or assigned to nobody; the worst case is that the router's answer stands,
   * which is what would have happened before M4 anyway.
   *
   * The capability question is answered by `resolveRole`, which owns it. Passing a
   * predicate rather than a capability map is what keeps `core/collaboration/handoffs.ts`
   * pure and provider-free.
   */
  private async assignAgent(
    runId: string,
    task: Task,
    role: WorkflowRole,
  ): Promise<TaskAssignment> {
    const collaboration = this.options.collaboration;
    if (collaboration === undefined) return fallbackAssignment(task.id, role, this.options.clock.now());

    try {
      const assignment = await collaboration.assignmentFor({
        runId,
        task,
        routedRole: role,
        canImplement: (agent) => this.canImplement(agent),
        inFlight: await this.inFlightByAgent(runId),
      });

      // Recorded whenever the answer is not the router's, which is the only case a
      // reader needs an explanation for. I-34: the candidate ranking rides on the event
      // so "why did Backend not get this" is answerable from the audit trail alone.
      if (assignment.reason !== 'routed') {
        await this.options.store.appendEvent(runId, 'task_assigned', {
          task: task.id,
          agent: assignment.agentId,
          role: assignment.role,
          reason: assignment.reason,
          ...(assignment.detail === undefined ? {} : { detail: assignment.detail }),
          candidates: assignment.candidates.map((candidate) => ({
            agent: candidate.agentId,
            score: Number(candidate.score.toFixed(3)),
            ...(candidate.excludedBy === undefined ? {} : { excludedBy: candidate.excludedBy }),
          })),
        });
      }

      return assignment;
    } catch {
      return fallbackAssignment(task.id, role, this.options.clock.now());
    }
  }

  /**
   * How many tasks each agent currently holds (I-39).
   *
   * **Derived from the run's own task states, never stored.** A persisted `busy: true`
   * outlives the crash that ended the work, and the agent it named would then be locked
   * out of every subsequent wave with nothing to explain it.
   *
   * A task counts as held when it is `running`. `queued` is not held — nobody is doing it
   * — and a task that failed is not either.
   */
  private async inFlightByAgent(runId: string): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>();

    // **The strict read, not the tolerant one.** `readEventsBestEffort` exists for read
    // models: a malformed legacy line should cost a dashboard a row rather than a whole
    // projection. This is not a read model — it decides who gets work — and skipping an
    // unparseable line here would silently change an assignment. An architecture rule
    // caught the first version of this using the tolerant read.
    //
    // A throw is handled by the caller's fallback to the router's answer, which is the
    // fail-closed direction: an unreadable log means the team policy is not consulted,
    // never that a member is assumed idle.
    const events = await this.options.store.readEvents(runId);
    const state = await this.options.store.loadRun(runId);
    const running = new Set(
      state.tasks.filter((task) => task.state === 'running').map((task) => task.id),
    );

    // The last assignment recorded for each running task. Read from the audit trail
    // rather than from a second store: an assignment is a fact the run already recorded,
    // and keeping a parallel copy is the drift §19 forbids.
    const assignedTo = new Map<string, string>();
    for (const event of events) {
      if (event.type !== 'task_assigned') continue;
      const task = event.detail['task'];
      const agent = event.detail['agent'];
      if (typeof task === 'string' && typeof agent === 'string') assignedTo.set(task, agent);
    }

    for (const taskId of running) {
      const agent = assignedTo.get(taskId);
      if (agent === undefined) continue;
      counts.set(agent, (counts.get(agent) ?? 0) + 1);
    }

    return counts;
  }

  /**
   * Whether this agent's (runner, model) pair can do implementation work.
   *
   * Asked through `resolveRole` — the one module that answers a capability question — with
   * the requirements `prompts/implementation.md` declares: it writes, and it reads the
   * repository. An agent whose runner is an inference endpoint fails both, which is
   * exactly why a handoff to one has to be refused rather than attempted.
   */
  private canImplement(agent: AgentIdentity): boolean {
    const capabilities = this.options.capabilities;
    if (capabilities === undefined) return false;

    try {
      resolveRole(agent.role, this.options.config.global, capabilities, {
        workingDirectory: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The two collaboration blocks this agent should be shown (M4-06, M5).
   *
   * Never throws: a prompt is not the place to discover that a log line was malformed.
   * On an unhappy path the *invitation* still goes out and the payload does not, because
   * availability and relevance are different promises (I-40) and only one of them
   * depends on the log being readable.
   */
  private async collaborationContextFor(
    runId: string,
    task: Task,
    agentId: string,
  ): Promise<CollaborationBlocks> {
    const collaboration = this.options.collaboration;
    if (collaboration === undefined || !collaboration.enabled) return {};

    try {
      return await collaboration.contextFor({
        runId,
        taskId: task.id,
        agentId,
        files: task.files.likely,
      });
    } catch {
      // A malformed log is not a reason to withhold the *invitation*: the channel is
      // open, and an agent that cannot be shown what others said can still say
      // something. Withholding both would let one bad line close the channel silently.
      return { bootstrap: buildCollaborationBootstrap() };
    }
  }

  /**
   * Reads the agent's outbox, if this run lets agents speak (M4-02).
   *
   * Returns notes for the result and nothing else. **It cannot fail an attempt**, and the
   * `catch` is not defensive tidiness — it is I-27 written as code: a message is not the
   * work, and a run whose task validated and integrated must not be failed because a JSON
   * file beside it was unreadable. Everything the harvest actually refuses is already a
   * recorded event with a reason; what this catches is the harvest itself going wrong.
   *
   * The agent id is the executor role the router chose, because in M4 those are the same
   * thing. M4-04 replaces this expression with `resolveTaskAgent` and nothing else here
   * changes — which is why `AgentIdentity.id` was a separate field from the first version.
   */
  private async harvestCollaboration(
    runId: string,
    task: Task,
    role: string,
    workingDirectory: string,
  ): Promise<string[]> {
    const collaboration = this.options.collaboration;
    if (collaboration === undefined || !collaboration.enabled) return [];

    try {
      const summary = await collaboration.harvest({
        runId,
        taskId: task.id,
        agentId: role,
        workspaceDir: workingDirectory,
      });
      return [...summary.notes];
    } catch {
      return ['collaboration: the outbox could not be processed for this attempt'];
    }
  }

  private async observeChange(workspace: TaskWorkspace | undefined): Promise<ObservedChange> {
    const isolation = workspace?.isolation;
    const { workspaces } = this.options;
    if (workspace === undefined || isolation === undefined || workspaces === undefined) {
      return {};
    }

    // Asked of the module that owns the §11.2 Git operations rather than performed here.
    // One module answers "which tree was validated", and an architecture test keeps it
    // that way — splitting it would give two answers, and only one of them would be the
    // tree a receipt is bound to.
    return captureAttemptChange({ workspaces }, {
      workspacePath: workspace.path,
      base: isolation.base,
    });
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
  /**
   * `tasks/<TASK>/attempt-<n>.failed.json` (AD-34).
   *
   * **Worktree mode only, and that is the schema talking rather than a preference.**
   * `FailedAttemptSchema` requires `base`, `branch` and a workspace-relative path; a
   * sequential attempt has none of the three, and filling them with placeholders would put
   * three assertions on disk that nobody measured. A sequential failure is still fully
   * described by `result.json` plus the stage log, which is what it always was.
   *
   * Best-effort by construction: a failure to write evidence must not replace the failure
   * being described. The stage log and the `stage_failed` event have already landed by the
   * time this runs.
   */
  private async writeFailedAttempt(input: {
    readonly runId: string;
    readonly task: Task;
    readonly workspace: TaskWorkspace | undefined;
    readonly execution: StageExecution;
    readonly failure: StageFailure | undefined;
    readonly startedAt: string;
    readonly finishedAt: string;
  }): Promise<void> {
    const isolation = input.workspace?.isolation;
    if (input.workspace === undefined || isolation === undefined) return;

    const { fs, projectDir, config } = this.options;

    // Already redacted by `StageRunner`, which redacts once at the boundary that persists
    // (AD-35). Truncated here to this artifact's own budget.
    const excerpt =
      input.failure?.raw === undefined
        ? undefined
        : redactAndTruncate(input.failure.raw, config.global.recovery.maxRawExcerptBytes).text;

    const failureClass = input.failure?.failureClass ?? 'runner_execution_failed';

    const artifact = {
      run: input.runId,
      task: input.task.id,
      attempt: input.workspace.attempt,
      base: isolation.base,
      branch: isolation.branch,
      workspace: isolation.relativePath,
      runner: input.execution.runner,
      ...(input.execution.model === undefined ? {} : { model: input.execution.model }),
      reasoning: input.execution.reasoning,
      reasoningClamped: input.execution.reasoningClamped,
      ...(input.execution.fallback === undefined ? {} : { fallback: input.execution.fallback }),
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      failureClass,
      ...(input.failure === undefined ? {} : { runnerErrorCode: input.failure.errorCode }),
      ...(excerpt === undefined ? {} : { rawExcerpt: excerpt }),
      repairAttempts: 1,
      // The decision the budget was applied to, recorded rather than recomputed (AD-37).
      consumedAttempt: consumesAttempt(failureClass),
    };

    try {
      const parsed = FailedAttemptSchema.parse(artifact);
      const path = runPaths(projectDir, input.runId).failedAttempt(
        input.task.id,
        input.workspace.attempt,
      );
      await fs.mkdirp(path.slice(0, path.lastIndexOf('/')));
      await fs.writeFileAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`);
    } catch {
      // Evidence about a failure must never become a second failure. The stage log and the
      // `stage_failed` event already carry the same facts.
    }
  }

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
      // AD-38's evidence, on the artifact that has to be able to explain the decision
      // afterwards. Both hashes were already computable and were never written down.
      ...(evidence.observed?.baseTree === undefined ||
      evidence.observed.validatedTree === undefined
        ? {}
        : {
            treeComparison: {
              baseTree: evidence.observed.baseTree,
              validatedTree: evidence.observed.validatedTree,
              identical: evidence.observed.baseTree === evidence.observed.validatedTree,
            },
          }),
      ...(evidence.acceptance === undefined ? {} : { acceptance: [...evidence.acceptance] }),
    };

    const outcome = await recordAttempt(
      {
        workspaces,
        fs: this.options.fs,
        clock: this.options.clock,
        host,
        projectDir: this.options.projectDir,
      },
      {
        draft,
        workspacePath: workspace.path,
        gitRunKey: state.gitRunKey,
        // The tree this task's decision was actually made against. Recapturing it here
        // would be a second measurement of the same thing, and two measurements are two
        // chances to disagree about what the receipt attests to.
        ...(evidence.observed?.validatedTree === undefined
          ? {}
          : { capturedTree: evidence.observed.validatedTree }),
      },
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

  /**
   * What the previous attempt learned, rendered into this one's prompt (AD-40, AR-03).
   *
   * **The defect this closes.** The packet was built by the scheduler, persisted to
   * `attempt-<n>.context.json` and recorded in the event log — and stopped there. Nothing
   * read it back, `renderFailureContext` had no caller, and `implementation.md` had no slot
   * for it, so automatic recovery re-ran the identical prompt. That is not recovery; it is
   * a retry loop with more bookkeeping, and it would have spent the whole attempt budget
   * rediscovering one failure.
   *
   * Empty on a first attempt, and empty on a packet that will not parse. An uninformed
   * attempt is worse than an informed one; it is not worse than no attempt at all, and a
   * crash between requeue and retry must not strand the task.
   */
  private async readFailureContext(
    runId: string,
    taskId: string,
    attempt: number,
  ): Promise<string> {
    if (attempt <= 1) return '';

    const path = runPaths(this.options.projectDir, runId).attemptContext(taskId, attempt);
    if (!(await this.options.fs.exists(path))) return '';

    try {
      const packet = FailureContextPacketSchema.parse(
        JSON.parse(await this.options.fs.readFile(path)),
      );
      return renderFailureContext(packet);
    } catch {
      return '';
    }
  }

  /**
   * The repository's own instructions, read **on the agent's behalf** (T6, PRI-20).
   *
   * That phrase is the whole reason this is not a two-line read. Everywhere else, hostile
   * repository content reaches a model because the model went and read it — inside
   * whatever sandbox the vendor applies. Here the *orchestrator* opens the file, with the
   * orchestrator's privileges and no sandbox at all, and interpolates the result into the
   * prompt. Two things follow, and neither held:
   *
   *   **It must be inside the workspace.** A repository shipping `AGENTS.md` as a symlink
   *   to `~/.ssh/id_rsa` had that file read by this process and pasted into a prompt. The
   *   agent could not have reached it; this could. Refused by comparing the *resolved*
   *   path against the resolved workspace, because a lexical check answers a different
   *   question than the one a symlink asks.
   *
   *   **It must be bounded.** `measurePromptComposition` measures and does not enforce,
   *   and it runs after this — so a repository decided how large every implementation
   *   prompt was. Truncation is explicit and says how much is missing, in the same shape
   *   the process boundary already uses: silence would be a prompt that quietly stopped
   *   containing the instructions it claims to carry.
   *
   * A refusal is not an error. The file is a convenience, and a task that cannot run
   * because a repository shipped a strange one would be a worse outcome than a task that
   * runs without it — so both cases produce a sentence the agent can read, and the run
   * continues.
   */
  private async readAgentsMd(workingDirectory: string): Promise<string> {
    const path = `${workingDirectory}/AGENTS.md`;
    if (!(await this.options.fs.exists(path))) return 'No AGENTS.md in this repository.';

    const [resolvedFile, resolvedRoot] = await Promise.all([
      this.options.fs.realPath(path),
      this.options.fs.realPath(workingDirectory),
    ]);

    if (resolvedFile !== null && resolvedRoot !== null && !isWithin(resolvedRoot, resolvedFile)) {
      return (
        'This repository ships AGENTS.md as a link to a file outside it, so it was not ' +
        'read. Agent Flow reads that file on your behalf, outside any sandbox, and will ' +
        'not follow it out of the workspace.'
      );
    }

    const content = await this.options.fs.readFile(path);
    if (content.length <= MAX_AGENTS_MD_BYTES) return content;

    return (
      `${content.slice(0, MAX_AGENTS_MD_BYTES)}\n\n` +
      `… [truncated: AGENTS.md is ${String(content.length)} bytes and this prompt ` +
      `carries the first ${String(MAX_AGENTS_MD_BYTES)}]`
    );
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
