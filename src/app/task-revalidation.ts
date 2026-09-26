import type { CommandResult, EffectiveConfig, RunActor } from '../contracts/index.js';
import type { Clock, FileSystem, Host } from '../ports/index.js';
import type { ProcessRunner } from '../ports/process-runner.js';
import type { GitWorkspaces } from '../adapters/git/git-workspaces.js';
import { attemptRef, attemptWorkspace } from '../core/worktree-policy.js';
import { buildValidationRegistry } from '../core/validation-registry.js';
import { judgeValidation } from '../core/validation-outcome.js';
import { escalationEvidence } from '../core/recovery-policy.js';
import { deriveRepoKey } from './run-git-identity.js';
import {
  captureAttemptChange,
  readAttempt,
  recordAttempt,
  type AttemptDraft,
} from './attempt-receipt.js';
import { runCommands } from './verification-commands.js';
import type { StateStore } from './state-store.js';

/**
 * "I fixed it by hand; re-run only the validation" (D19).
 *
 * The gap this closes was measured rather than imagined. TASK-004 of AF-2026-004 stopped
 * `recovery_exhausted`, and the whole evidence was nine unused imports in nine test files:
 * `typecheck` clean, 3972 tests passing, the substance of four tasks standing. The product
 * said *"Review the attempt evidence, then retry the task"* — and `retry` knows exactly one
 * move, which is **to run the model again**. Twenty minutes of an executor to delete nine
 * import lines, and a retry spent doing it.
 *
 * `retry --expect-no-change` is the nearest thing that existed and it says something else:
 * *accept an empty diff*, not *revalidate what I corrected*.
 *
 * So this module is the third verb, and it is deliberately the smallest one that can be
 * correct:
 *
 *   **it spawns no model**, so it costs nothing and spends no work attempt;
 *   **it resets nothing** — the tree is validated exactly as the person left it;
 *   **it reuses the receipt and marker machinery** rather than a shortcut around it, so a
 *   task closed this way integrates through the one path that has ever integrated
 *   anything (§11.2, §14);
 *   **it records that the closer was a person**, because a task closed by a human hand
 *   must not read like one closed by the model.
 *
 * ## Why it does not reopen the approval gate
 *
 * AR §1.1 decides this rather than taste: *"A decision belongs to the human only when it
 * changes **what was agreed** or **what is permitted**."* Repairing an attempt's worktree
 * changes neither — the plan, its scope and its acceptance criteria are untouched, and
 * §1.3's list of what must remain human ("plan approval", "scope expansion") does not
 * contain "a person edited a file". Reopening approval here would ask somebody to
 * re-approve a plan they already approved because they did the very thing the escalation
 * asked them to do, which is the shape §1.2 catalogues thirteen times over.
 *
 * What is *not* waived is the merge decision: a revalidated task goes back to `running` and
 * is integrated by the Integrator on the next `agent-flow run`, through the same ancestry,
 * tree-binding and marker checks every model-produced attempt goes through. Nothing here
 * writes `completed` (I-3).
 *
 * AD-38's two acceptance assertions are deliberately **not** re-run over the human's diff.
 * They exist to judge an *agent's* output — "did the model actually do anything, and did it
 * stay inside `files.likely`" — and the authority for a person's own edit to their own
 * repository is the person (AR §1.1). Refusing their fix for scope would be the machine
 * stopping to ask for a human action and then refusing the action it asked for, which is
 * the exact pathology `retryTask`'s budget comment already names. The diff is recorded on
 * the artifact either way, so a reviewer can still see every path that moved.
 */

/**
 * Why a revalidation was refused, before anything was taken or written.
 *
 * Its own vocabulary rather than the run-level codes of Appendix A, for the reason
 * `attempt-receipt.ts` gives about its own: these describe this path's preconditions, and
 * the caller decides how to render them.
 */
export const REVALIDATION_REFUSAL_CODES = [
  /** The run has no such task, or the task is in a state a revalidation cannot speak about. */
  'task_not_revalidatable',
  /** A sequential run has no attempt worktree, so there is no tree "as it stands" to validate. */
  'revalidation_unsupported',
  /** The last attempt's worktree, or the evidence naming its base, is gone. */
  'attempt_workspace_missing',
  /**
   * The task declares no validation this path could run, so "it passed" would assert nothing.
   *
   * **The most dangerous shape this command could have had.** `judgeValidation` answers
   * `completed` for an expectation of `none` or a run of zero commands — correctly, because
   * for the executor that means "the agent did the work and the plan asked for no check".
   * Reached from here it would mean something else entirely: a person types one word, no
   * command runs, no model runs, and an untouched tree acquires a receipt, a marker and an
   * integration. A task whose agent answered BLOCKED is exactly the task that state is
   * reachable from, and §23 exists to keep that one away from automatic closure.
   */
  'nothing_to_revalidate',
] as const;

export type RevalidationRefusalCode = (typeof REVALIDATION_REFUSAL_CODES)[number];

export interface RevalidationRefusal {
  readonly code: RevalidationRefusalCode;
  /** What happened, in the words a person needs. Never a stack trace, never a path (§7.2). */
  readonly message: string;
  /** What to do about it. */
  readonly action?: string;
}

export interface RevalidationResult {
  readonly runId: string;
  readonly taskId: string;
  /** The attempt number the human tree was recorded as, or the one it was read from. */
  readonly attempt: number;
  /** Whether the task's own validation commands met the task's own expectation. */
  readonly passed: boolean;
  readonly commands: readonly CommandResult[];
  /** Failing commands and their verdict lines, redacted. Empty on a pass. */
  readonly evidence: readonly string[];
}

export type RevalidationOutcome =
  | { readonly ok: true; readonly value: RevalidationResult }
  | { readonly ok: false; readonly refusal: RevalidationRefusal };

/** What this use case needs, as ports. The same collaborators `ExecutionContext` publishes. */
export interface RevalidationDeps {
  readonly fs: FileSystem;
  readonly clock: Clock;
  /** For `randomHex` alone: the receipt nonce must come from a cryptographic source. */
  readonly host: Host;
  readonly store: StateStore;
  readonly workspaces: GitWorkspaces;
  readonly processRunner: ProcessRunner;
  /**
   * `project` for the ids, `execution` for how long their commands may run — the same
   * `execution.commandTimeoutSeconds` the executor honours, so a suite that passes under
   * `run` is not killed when a person revalidates it.
   */
  readonly config: Pick<EffectiveConfig, 'project'> & {
    readonly global: Pick<EffectiveConfig['global'], 'execution'>;
  };
  readonly projectDir: string;
}

/**
 * The states a revalidation has something to say about.
 *
 * `completed` is terminal and `running` belongs to recovery — the same two `retryTask`
 * refuses, for the same reasons (§16, §17.3). `queued`, `ready` and `interrupted` are all
 * "the machine still intends to run this", and validating a tree the scheduler is about to
 * discard would record evidence about work nobody is going to keep.
 */
const REVALIDATABLE = new Set(['failed', 'review_required', 'blocked']);

/**
 * Whether this task can be revalidated at all — **asked before the lock, not inside it**.
 *
 * The rule is C-19's and it is not tidiness: every one of these questions is answerable
 * from persisted state and the filesystem, so asking them under the lease would cost a full
 * acquire/refuse/release cycle and write two events describing work that never happened.
 *
 * Exported so the caller that owns the lease can ask first and hold second. It never
 * writes anything.
 */
export async function refuseUnrevalidatable(
  deps: RevalidationDeps,
  runId: string,
  taskId: string,
): Promise<RevalidationRefusal | undefined> {
  const state = await deps.store.loadRun(runId);

  if (state.status === 'completed' || state.status === 'cancelled') {
    return {
      code: 'task_not_revalidatable',
      message: `${runId} has finished (${state.status}), so none of its tasks can be revalidated.`,
      action: 'Start a new run if the work needs revisiting.',
    };
  }

  const entry = state.tasks.find((task) => task.id === taskId);
  if (entry === undefined) {
    return {
      code: 'task_not_revalidatable',
      message: `${taskId} has not run in ${runId}.`,
      action: 'Only a task that has already been attempted can be revalidated.',
    };
  }

  if (!REVALIDATABLE.has(entry.state)) {
    return {
      code: 'task_not_revalidatable',
      message: `${taskId} is ${entry.state}, and a revalidation only speaks about a task that stopped.`,
      action:
        entry.state === 'completed'
          ? 'It is already integrated; revise the plan and start a new run if it must change.'
          : 'Run `agent-flow run`, which reconciles what is in flight before anything else.',
    };
  }

  // §25: a sequential run validates the user's own working tree, which nothing isolated
  // it from — there is no attempt worktree, no marker and no integration branch, so the
  // whole mechanism this path reuses does not exist for it.
  if (state.isolationMode !== 'worktree' || state.gitRunKey === undefined) {
    return {
      code: 'revalidation_unsupported',
      message: `${runId} does not isolate its tasks, so ${taskId} has no attempt worktree to revalidate.`,
      action: 'Fix the tree and run `agent-flow review`, which judges the project directory.',
    };
  }

  if (entry.attempts < 1) {
    return {
      code: 'attempt_workspace_missing',
      message: `${taskId} has no recorded attempt, so there is no tree a person could have fixed.`,
      action: 'Run it once with `agent-flow run` before revalidating it.',
    };
  }

  // The artifact first, always. It is the only honest source for the commit this
  // workspace was cut from, and a marker built on a base nobody recorded would be a
  // marker nothing can re-derive (§11.1, §12.2).
  const evidence = await readAttempt(deps, runId, taskId, entry.attempts);
  if (evidence === null) {
    return {
      code: 'attempt_workspace_missing',
      message:
        `attempt ${String(entry.attempts)} of ${taskId} left no evidence that parses, so the ` +
        'base its worktree was cut from is not recorded anywhere.',
      action: 'Retry the task so an attempt is observed, then revalidate that one.',
    };
  }

  const path = await workspacePathOf(deps, state.gitRunKey, taskId, entry.attempts);
  if (path === null || !(await deps.fs.exists(path))) {
    return {
      code: 'attempt_workspace_missing',
      message:
        `the worktree of attempt ${String(entry.attempts)} of ${taskId} is no longer on disk, ` +
        'so there is no tree "as it stands" to validate.',
      action: 'Retry the task, which cuts a fresh worktree from the integration head.',
    };
  }

  return refuseUncheckable(deps, taskId, evidence.validation);
}

/**
 * Refuses a revalidation that would check nothing (the zero-check close).
 *
 * **This is the one refusal the command cannot do without.** Everything else here protects
 * a person from a confusing outcome; this protects the integration branch from a tree
 * nobody looked at. Without it `revalidate` on a task that declares no validation — which
 * a BLOCKED task routinely is — walks straight through `judgeValidation`'s honest
 * `completed` for zero commands, mints a receipt over the untouched worktree, publishes a
 * marker and hands it to the Integrator. One word typed, no command run, no model run, no
 * gate crossed.
 *
 * Shared by the precondition and the use case rather than written twice: the precondition
 * is what a person hits, and the second call is what a caller reaching past it hits. Two
 * copies of a rule this load-bearing is one copy that eventually disagrees.
 */
function refuseUncheckable(
  deps: RevalidationDeps,
  taskId: string,
  validation: { readonly expectation: 'pass' | 'fail' | 'none'; readonly ids: readonly string[] },
): RevalidationRefusal | undefined {
  if (validation.expectation !== 'none' && validation.ids.length > 0) {
    // Ids that the project no longer defines are a different refusal with a different
    // remedy, and it is answered here too so that it is answered before the lock.
    const registry = buildValidationRegistry(deps.config.project);
    const unresolved = validation.ids.filter((id) => registry.resolve(id) === undefined);
    if (unresolved.length === 0) return undefined;

    return {
      code: 'task_not_revalidatable',
      message:
        `${taskId} validates with ${unresolved.map((id) => `"${id}"`).join(', ')}, ` +
        'which this project no longer defines.',
      action: 'Restore the validation command in .agent-flow/config.yaml, then revalidate.',
    };
  }

  return {
    code: 'nothing_to_revalidate',
    message:
      `${taskId} declares no validation this command could run, so re-running it would ` +
      'prove nothing about the tree.',
    // Named rather than left as a bare "no": the task still has a way forward, and it is
    // the one that involves somebody judging the work instead of a command exiting zero.
    action:
      'Retry the task, or run `agent-flow review` and accept the outcome — a task with no ' +
      'check cannot be closed by re-running one.',
  };
}

/**
 * Runs the task's own validation commands over the attempt's worktree, as it is.
 *
 * The caller holds the run's execution lease and has already called
 * {@link refuseUnrevalidatable}; the refusals repeated below are the ones that can only be
 * answered after the commands have run.
 *
 * **On a pass** this is attempt *n+1* — recorded through `recordAttempt`, so it gets the
 * same artifact, the same post-hoc nonce and the same marker every model-produced attempt
 * gets — and the task goes back to `running`. That is exactly the state a satisfied attempt
 * leaves in worktree mode: the outcome is decided at integration, and the next
 * `agent-flow run` reconciles the durable evidence and merges it through the Integrator
 * (§14.4, §17.3 window 5). Nothing here completes a task (I-3).
 *
 * **On a failure** nothing is spent and no attempt artifact is written. A failed
 * revalidation is not an execution of work — no runner ran, and §11.3 reads "no
 * `attempt-<n>.json`" as *the attempt's work was never observed*, which is literally true.
 * It also keeps the door open: a person whose first fix was incomplete fixes more and
 * revalidates again, over the same worktree, which is the whole point of the command.
 *
 * **Order: evidence, then bookkeeping.** `recordAttempt` runs before the state write, so a
 * crash between them leaves an artifact and a marker that a `revalidate` typed again simply
 * re-derives — rather than a task whose counter moved past a worktree nobody can reach.
 */
export async function revalidateTask(
  deps: RevalidationDeps,
  runId: string,
  taskId: string,
  actor: RunActor,
): Promise<RevalidationOutcome> {
  const state = await deps.store.loadRun(runId);
  const gitRunKey = state.gitRunKey;
  const entry = state.tasks.find((task) => task.id === taskId);

  if (entry === undefined || gitRunKey === undefined) {
    return {
      ok: false,
      refusal: {
        code: 'task_not_revalidatable',
        message: `${taskId} is no longer a task of ${runId} with a Git namespace.`,
      },
    };
  }

  const previous = entry.attempts;
  const evidence = await readAttempt(deps, runId, taskId, previous);
  const workspacePath = await workspacePathOf(deps, gitRunKey, taskId, previous);

  if (evidence === null || workspacePath === null) {
    return {
      ok: false,
      refusal: {
        code: 'attempt_workspace_missing',
        message: `attempt ${String(previous)} of ${taskId} can no longer be located on this machine.`,
      },
    };
  }

  // **Asked a second time, and this one is not belt-and-braces.** A caller that reached
  // past `refuseUnrevalidatable` — a future adapter, a test, a refactor that reorders the
  // two — must not be able to close a task by running nothing. There is no branch below
  // this line that tolerates an empty command list.
  const uncheckable = refuseUncheckable(deps, taskId, evidence.validation);
  if (uncheckable !== undefined) return { ok: false, refusal: uncheckable };

  // The *ids* the previous attempt recorded, resolved against the project configuration —
  // never a command a plan or a model wrote. This is the same rule the executor follows,
  // and it is why `task.validation` holds ids at all (§42). Every one resolves: the check
  // above is what guarantees it.
  const registry = buildValidationRegistry(deps.config.project);
  const commands = evidence.validation.ids.map((id) => registry.resolve(id) as string);

  const startedAt = deps.clock.now();
  const expectation = evidence.validation.expectation;

  const verification = await runCommands({
    processRunner: deps.processRunner,
    commands,
    // The worktree the person edited, and nothing else. Validating the project directory
    // while the fix lives elsewhere would judge a tree nobody touched (§4.2, I-4).
    cwd: workspacePath,
    timeoutSeconds: deps.config.global.execution.commandTimeoutSeconds,
  });

  // What Git says the tree now holds, measured once and handed to both the judgement and
  // the receipt — so the decision and the artifact describe the same tree (AD-38).
  const observed = await captureAttemptChange(deps, {
    workspacePath,
    base: evidence.base,
  });

  // The same function that judges every model attempt, asked the same question (I-4). A
  // RED task is still done when its check fails, and a person who "fixed" it into passing
  // has not satisfied it — the expectation belongs to the task, not to who typed.
  const judgement = judgeValidation(expectation, {
    passed: verification.passed,
    ran: verification.results.length,
    ...(observed.changed === undefined ? {} : { changed: observed.changed }),
  });

  const passed = judgement.state === 'completed';
  const failures = escalationEvidence({
    validation: { commands: verification.results },
  });

  if (!passed) {
    await deps.store.appendEvent(runId, 'task_revalidated', {
      task: taskId,
      attempt: previous,
      passed: false,
      actor,
      validationIds: [...evidence.validation.ids],
      ...(judgement.note === undefined ? {} : { note: judgement.note }),
      // Redacted and bounded by `escalationEvidence`, which is what the escalation itself
      // shows. Validation output is captured raw, and a test that prints an environment
      // variable would otherwise put it in the audit trail.
      evidence: failures,
    });

    return {
      ok: true,
      value: { runId, taskId, attempt: previous, passed: false, commands: verification.results, evidence: failures },
    };
  }

  const attempt = previous + 1;
  const branch = attemptRef(gitRunKey, taskId, attempt);
  if (!branch.ok) {
    return {
      ok: false,
      refusal: { code: 'task_not_revalidatable', message: branch.refusal.reason },
    };
  }

  const finishedAt = deps.clock.now();
  const draft: AttemptDraft = {
    run: runId,
    task: taskId,
    attempt,
    // The base the *previous* attempt was cut from: the tree being marked is that
    // worktree's, so its marker's one parent has to be that worktree's base (§12.5).
    base: evidence.base,
    branch: branch.value,
    // Workspace-relative, and the previous attempt's, because that is the directory the
    // validated tree was read out of. Never the absolute path (§7.2).
    workspace: evidence.workspace,
    // **No runner ran, and the record says so in the field a reader looks at first.**
    // Filling in the previous attempt's runner would attribute a person's work to a model.
    runner: 'human',
    reasoning: 'low',
    reasoningClamped: false,
    closedBy: 'human',
    startedAt,
    finishedAt,
    filesChanged: [...(observed.changedFiles ?? [])],
    agentReport: {
      // The shape the artifact requires, filled with the only honest content there is: no
      // agent produced this tree, and the note says which command closed the task instead.
      status: 'COMPLETED',
      notes: ['revalidated by hand: a person fixed this worktree and no runner was invoked'],
      deviations: [],
      claimedFilesChanged: [],
    },
    validation: {
      expectation,
      passed: verification.passed,
      ids: [...evidence.validation.ids],
      commands: verification.results,
    },
    validationJudgement: 'satisfied',
    ...(observed.baseTree === undefined || observed.validatedTree === undefined
      ? {}
      : {
          treeComparison: {
            baseTree: observed.baseTree,
            validatedTree: observed.validatedTree,
            identical: observed.baseTree === observed.validatedTree,
          },
        }),
  };

  const recorded = await recordAttempt(deps, {
    draft,
    workspacePath,
    gitRunKey,
    ...(observed.validatedTree === undefined ? {} : { capturedTree: observed.validatedTree }),
  });

  if (!recorded.ok) {
    return {
      ok: false,
      refusal: {
        code: 'attempt_workspace_missing',
        message: `${recorded.failure.code}: ${recorded.failure.detail}`,
        action: 'Fix what stopped the evidence from being written, then revalidate again.',
      },
    };
  }

  await concludeRevalidation(deps, runId, taskId, attempt);

  await deps.store.appendEvent(runId, 'task_attempt_validated', {
    task: taskId,
    attempt,
    judgement: 'satisfied',
    validationIds: [...evidence.validation.ids],
  });

  const marker = recorded.value.marker;
  if (marker !== undefined) {
    await deps.store.appendEvent(runId, 'task_attempt_marker_created', {
      task: taskId,
      attempt,
      marker: marker.oid,
      tree: marker.tree,
    });
  }

  await deps.store.appendEvent(runId, 'task_revalidated', {
    task: taskId,
    attempt,
    passed: true,
    actor,
    validationIds: [...evidence.validation.ids],
    closedBy: 'human',
  });

  return {
    ok: true,
    value: { runId, taskId, attempt, passed: true, commands: verification.results, evidence: [] },
  };
}

/**
 * Puts the task where a satisfied attempt leaves it, in two legal moves.
 *
 * §22 has no `failed → running` edge and should not: `failed` returns to the queue, and
 * the queue is what dispatches. So the task passes through `queued` — which is true, and
 * briefly — and lands on `running`, the state a validated-but-unmerged attempt sits in
 * until the Integrator decides its outcome (§14.4). Writing `completed` here would be the
 * one thing worktree mode forbids outside the Integrator (I-3).
 *
 * `attempts` moves because an attempt artifact now exists under that number, and recovery
 * finds the artifact by that counter. `attemptsBeforeHumanRetry` moves with it, which is
 * what leaves the retry budget untouched: `retry.maxAttempts` bounds the streak made *with
 * nobody watching*, and this attempt is the opposite of that — `autonomy-budget.ts` already
 * states the principle, that "a call a person asked for is not autonomous and must not
 * count against a budget that exists to bound unattended work".
 */
async function concludeRevalidation(
  deps: RevalidationDeps,
  runId: string,
  taskId: string,
  attempt: number,
): Promise<void> {
  await deps.store.updateRun(runId, (current) => ({
    ...current,
    tasks: current.tasks.map((task) =>
      task.id === taskId
        ? { ...task, state: 'queued' as const, blockReason: undefined }
        : task,
    ),
  }));

  await deps.store.updateRun(runId, (current) => ({
    ...current,
    tasks: current.tasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            state: 'running' as const,
            attempts: attempt,
            attemptsBeforeHumanRetry: attempt,
          }
        : task,
    ),
  }));
}

/**
 * Where attempt *n* of this task was checked out, or `null` when it cannot be named.
 *
 * Derived the way §5.1 and §7.3 specify rather than read from the artifact, for the reason
 * the Integrator re-derives its refs: the artifact records a path as a string, and the one
 * thing it must not be able to do is point this code at a directory outside the root Agent
 * Flow owns (S-2).
 */
async function workspacePathOf(
  deps: RevalidationDeps,
  gitRunKey: string,
  taskId: string,
  attempt: number,
): Promise<string | null> {
  const repoKey = await deriveRepoKey(deps);
  if (repoKey === null) return null;

  const location = attemptWorkspace(repoKey, gitRunKey, taskId, attempt);
  if (!location.ok) return null;

  const path = deps.workspaces.workspacePath(location.value);
  return path.ok ? path.value : null;
}
