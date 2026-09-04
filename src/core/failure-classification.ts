import type {
  FailureAuthority,
  FailureClass,
  FailureGroup,
  RecoveryDisposition,
  RunnerErrorCode,
} from '../contracts/index.js';

/**
 * The failure taxonomy, as a table (AD-36, AR §3, AR §5).
 *
 * Deterministic, table-driven, and it never calls a model. Classification runs **once**,
 * in the adapter-facing layer, before anything is persisted, and the result travels on
 * every artifact and event that reports the failure.
 *
 * **A refinement above `RUNNER_ERROR_CODES`, never a replacement.** That vocabulary is
 * the *runner transport* level and is correct there; what was missing is the level above,
 * where `execution_failed` covered an unsupported effort, a denied command and a genuine
 * implementation failure — three failures with three different correct responses.
 * Creating a second parallel enum instead of a refinement would give two answers to one
 * question, so every class here declares the runner code it refines, and nothing in the
 * codebase branches on both.
 *
 * AR-00 lands the table and the lookups. **The signature-matching intelligence that
 * turns a raw string into `runner_permission_required` is AR-02's**, and is deliberately
 * absent: this module knows what the classes *are* and what each one implies, so AR-02
 * has somewhere to put the decision instead of inventing a vocabulary at the call site.
 */

export interface FailureClassDefinition {
  readonly failureClass: FailureClass;
  readonly group: FailureGroup;
  /**
   * The runner code this class refines, or `undefined` where the failure never reached
   * a runner.
   *
   * Several classes refine one code — that is what "refinement" means, and it is the
   * point: `runner_execution_failed` and `runner_permission_required` are the same
   * transport failure told apart by evidence. The reverse is forbidden: the mapping is
   * single-valued from class to code, asserted by a test.
   */
  readonly refines?: RunnerErrorCode;
  readonly disposition: RecoveryDisposition;
  /** Who decides the response. `mechanical` rows spend zero model calls, by contract. */
  readonly authority: FailureAuthority;
  /**
   * Whether this failure spends one of the task's work attempts (AD-37, I-22).
   *
   * `false` for every `PRE_EXECUTION` class without exception — that *is* I-22, and it
   * is what makes `retry --force` unnecessary for an environment fault.
   */
  readonly consumesAttempt: boolean;
  /** What must be persisted alongside the class. AR §5's last column. */
  readonly evidence: readonly string[];
  /**
   * The one specific human action, when a human is needed (AR §3.6).
   *
   * Present exactly when the disposition is `requires_human`. "Something failed,
   * inspect logs" is a contract violation, and a class that escalates without naming an
   * action is that sentence with the words removed — so the shape refuses to express it.
   */
  readonly humanAction?: string;
}

const DEFINITIONS: readonly FailureClassDefinition[] = [
  // ---- §3.1 PRE_EXECUTION — knowable before the agent is invoked. Never an attempt.
  {
    failureClass: 'project_not_initialized',
    group: 'PRE_EXECUTION',
    disposition: 'requires_human',
    authority: 'mechanical',
    consumesAttempt: false,
    evidence: ['absent config path'],
    humanAction: 'Run `agent-flow init`',
  },
  {
    failureClass: 'runner_unavailable',
    group: 'PRE_EXECUTION',
    refines: 'runner_unavailable',
    disposition: 'recoverable',
    authority: 'mechanical',
    consumesAttempt: false,
    evidence: ['health detail'],
  },
  {
    failureClass: 'runner_not_authenticated',
    group: 'PRE_EXECUTION',
    refines: 'auth_required',
    disposition: 'requires_human',
    authority: 'mechanical',
    consumesAttempt: false,
    evidence: ['runner', 'auth status'],
    humanAction: 'Authenticate the named runner CLI',
  },
  {
    failureClass: 'model_capability_mismatch',
    group: 'PRE_EXECUTION',
    // Never reaches a runner: AD-31 clamps at resolution, so no invocation happens at
    // the unsupported level (I-20). There is no transport failure to refine.
    disposition: 'recoverable',
    authority: 'mechanical',
    consumesAttempt: false,
    evidence: ['requested', 'effective', 'supported set', 'reason'],
  },
  {
    failureClass: 'permission_not_ready',
    group: 'PRE_EXECUTION',
    disposition: 'requires_human',
    authority: 'mechanical',
    consumesAttempt: false,
    evidence: ['tool class', 'runner', 'model'],
    humanAction: 'Grant the named tool class to the runner',
  },
  {
    failureClass: 'workspace_not_ready',
    group: 'PRE_EXECUTION',
    disposition: 'recoverable',
    authority: 'mechanical',
    consumesAttempt: false,
    evidence: ['phase', 'changed paths'],
  },
  {
    failureClass: 'dependency_environment_not_ready',
    group: 'PRE_EXECUTION',
    disposition: 'recoverable',
    authority: 'mechanical',
    consumesAttempt: false,
    evidence: ['install command', 'exit code'],
  },
  {
    failureClass: 'validation_registry_incomplete',
    group: 'PRE_EXECUTION',
    disposition: 'requires_human',
    authority: 'mechanical',
    consumesAttempt: false,
    evidence: ['unresolved validation ids'],
    humanAction: 'Declare the named validation ids in the project configuration',
  },

  // ---- §3.2 RUNNER — the agent was invoked and the process failed.
  {
    failureClass: 'runner_execution_failed',
    group: 'RUNNER',
    refines: 'execution_failed',
    disposition: 'recoverable',
    authority: 'mechanical',
    consumesAttempt: true,
    evidence: ['redacted raw', 'failure class'],
  },
  {
    failureClass: 'runner_timeout',
    group: 'RUNNER',
    refines: 'timeout',
    disposition: 'recoverable',
    authority: 'mechanical',
    consumesAttempt: true,
    evidence: ['duration', 'configured timeout'],
  },
  {
    failureClass: 'runner_quota_exhausted',
    group: 'RUNNER',
    refines: 'quota_exceeded',
    disposition: 'recoverable',
    authority: 'mechanical',
    // The agent was invoked but produced no work to judge, so §4.4's definition is not
    // met and the task's attempt budget is untouched.
    consumesAttempt: false,
    evidence: ['runner error code'],
  },
  {
    failureClass: 'runner_permission_required',
    group: 'RUNNER',
    // The class the evidence run needed and did not have. Refines the same code as
    // `runner_execution_failed` and is told apart by a denial signature in the redacted
    // raw output — which is AR-02's work, not this module's.
    refines: 'execution_failed',
    disposition: 'requires_human',
    authority: 'mechanical',
    // The work was never attempted: local policy refused a tool before anything ran.
    consumesAttempt: false,
    evidence: ['redacted raw', 'denied command'],
    humanAction: 'Grant the named command to the runner configuration',
  },
  {
    failureClass: 'malformed_runner_output',
    group: 'RUNNER',
    refines: 'invalid_output',
    disposition: 'recoverable',
    authority: 'mechanical',
    consumesAttempt: true,
    evidence: ['problems list'],
  },
  {
    // Parsed, validated, and turned down by a plan rule. `requires_human` because
    // retrying the same prompt reproduces the same plan: what this needs is an
    // instruction, which is exactly what `revise` carries.
    failureClass: 'plan_rejected_by_checks',
    group: 'RUNNER',
    refines: 'invalid_output',
    disposition: 'requires_human',
    authority: 'mechanical',
    consumesAttempt: true,
    evidence: ['problems list'],
    humanAction: 'Fix the plan with: agent-flow revise "<instruction>"',
  },

  // ---- §3.3 TASK — the agent produced work and it was judged.
  {
    failureClass: 'implementation_completed',
    group: 'TASK',
    // Not a failure. Present because the taxonomy has to be able to say "this attempt
    // succeeded" in the same vocabulary the artifacts carry, rather than leaving the
    // field absent and indistinguishable from "nobody classified it".
    disposition: 'recoverable',
    authority: 'mechanical',
    consumesAttempt: true,
    evidence: ['validated tree', 'receipt'],
  },
  {
    failureClass: 'validation_unsatisfied',
    group: 'TASK',
    disposition: 'recoverable',
    authority: 'mechanical',
    consumesAttempt: true,
    evidence: ['exit codes', 'output tails'],
  },
  {
    failureClass: 'acceptance_evidence_missing',
    group: 'TASK',
    disposition: 'recoverable',
    authority: 'mechanical',
    consumesAttempt: true,
    evidence: ['base tree', 'validated tree'],
  },
  {
    failureClass: 'acceptance_evidence_unsatisfied',
    group: 'TASK',
    disposition: 'recoverable',
    authority: 'mechanical',
    consumesAttempt: true,
    evidence: ['acceptance criterion → evidence map'],
  },
  {
    failureClass: 'scope_violation',
    group: 'TASK',
    // Not auto-recoverable: a task that wrote outside its declared scope may already
    // have changed another task's outcome, which is what one evidence-run task did to
    // three downstream tasks. A retry cannot un-do that.
    disposition: 'requires_human',
    authority: 'mechanical',
    consumesAttempt: true,
    evidence: ['offending paths'],
    humanAction: 'Review the out-of-scope paths and decide whether the plan changed',
  },
  {
    failureClass: 'agent_blocked',
    group: 'TASK',
    refines: 'blocked',
    // Today's behaviour, without exception: BLOCKED means a decision is missing, and
    // re-running the same prompt produces the same gap or a guess.
    disposition: 'requires_human',
    authority: 'mechanical',
    consumesAttempt: true,
    evidence: ["the agent's own reason"],
    humanAction: 'Answer the question the agent reported as blocking',
  },

  // ---- §3.4 INTEGRATION.
  {
    failureClass: 'merge_conflict',
    group: 'INTEGRATION',
    disposition: 'recoverable',
    authority: 'mechanical',
    consumesAttempt: false,
    evidence: ['conflicting paths'],
  },
  {
    failureClass: 'integration_validation_failed',
    group: 'INTEGRATION',
    disposition: 'recoverable',
    authority: 'mechanical',
    consumesAttempt: true,
    evidence: ['exit codes', 'output tails'],
  },
  {
    failureClass: 'integration_history_invalid',
    group: 'INTEGRATION',
    disposition: 'requires_human',
    authority: 'mechanical',
    consumesAttempt: false,
    evidence: ['expected head', 'actual head'],
    humanAction: 'Inspect the integration branch before any further automation',
  },

  // ---- §3.5 REVIEW. The two advisory rows of AR §5.
  {
    failureClass: 'semantic_review_failed',
    group: 'REVIEW',
    disposition: 'recoverable',
    authority: 'llm_advisory',
    consumesAttempt: false,
    evidence: ['findings with severity'],
  },
  {
    failureClass: 'final_review_failed',
    group: 'REVIEW',
    disposition: 'recoverable',
    authority: 'llm_advisory',
    consumesAttempt: false,
    evidence: ['findings', 'envelope verdict'],
  },
  {
    failureClass: 'corrective_plan_invalid',
    group: 'REVIEW',
    disposition: 'recoverable',
    authority: 'mechanical',
    consumesAttempt: false,
    evidence: ['problem list per round'],
  },
  {
    failureClass: 'corrective_plan_rejected',
    group: 'REVIEW',
    // Never self-answered: the reviewer's objection is semantic, and answering it
    // autonomously would let the system talk itself past its own gate.
    disposition: 'requires_human',
    authority: 'llm_advisory',
    consumesAttempt: false,
    evidence: ['reviewer findings'],
    humanAction: 'Revise the corrective plan',
  },
];

const BY_CLASS: ReadonlyMap<FailureClass, FailureClassDefinition> = new Map(
  DEFINITIONS.map((definition) => [definition.failureClass, definition]),
);

/**
 * The whole table, in declaration order.
 *
 * Exported so a test can assert totality — every {@link FAILURE_CLASSES} entry has
 * exactly one definition — rather than trusting that the two lists were edited together.
 */
export const FAILURE_CLASS_DEFINITIONS = DEFINITIONS;

/**
 * What a class implies.
 *
 * Throws on an unknown class rather than returning `undefined`: the argument type is the
 * closed enum, so reaching this branch means the table and the enum have diverged, and
 * that is a programming error to surface immediately — not a missing recovery policy to
 * be defaulted around.
 */
export function failureClassDefinition(failureClass: FailureClass): FailureClassDefinition {
  const definition = BY_CLASS.get(failureClass);
  if (definition === undefined) {
    throw new Error(`no definition for failure class "${failureClass}"`);
  }
  return definition;
}

export function failureGroupOf(failureClass: FailureClass): FailureGroup {
  return failureClassDefinition(failureClass).group;
}

export function dispositionOf(failureClass: FailureClass): RecoveryDisposition {
  return failureClassDefinition(failureClass).disposition;
}

/**
 * Whether this failure spends one of the task's work attempts (AD-37, I-22).
 *
 * Derived from the table rather than from the group, even though the two agree for
 * `PRE_EXECUTION` — and the tests assert that agreement. Two RUNNER classes do *not*
 * consume an attempt, so a caller reasoning from the group alone would be wrong about
 * exactly the case that forced `retry --force` in the evidence run.
 */
export function consumesAttempt(failureClass: FailureClass): boolean {
  return failureClassDefinition(failureClass).consumesAttempt;
}

/** The runner code a class refines, or `undefined` when it never reached a runner. */
export function refinedRunnerErrorCode(failureClass: FailureClass): RunnerErrorCode | undefined {
  return failureClassDefinition(failureClass).refines;
}

/**
 * The classes that refine one runner code.
 *
 * The reverse direction is one-to-many by design: this is how AR-02 will know which
 * candidates a raw output has to be told apart between.
 */
export function classesRefining(code: RunnerErrorCode): readonly FailureClass[] {
  return DEFINITIONS.filter((definition) => definition.refines === code).map(
    (definition) => definition.failureClass,
  );
}

/**
 * The class a runner code maps to when nothing more specific is known.
 *
 * The **only** classification AR-00 performs, and it is deliberately the dumbest one
 * that is still correct: one runner code in, its default refinement out. It exists so
 * AR-02 has a baseline to sharpen — reading a redacted raw output and choosing among
 * `classesRefining(code)` — rather than a blank where a class should be.
 *
 * `undefined` for a code with no single default. There is none today; the branch exists
 * so adding a code without deciding its default is a `undefined` a caller must handle
 * rather than a silently wrong class.
 */
export function defaultClassForRunnerError(code: RunnerErrorCode): FailureClass | undefined {
  const candidates = classesRefining(code);
  // One candidate is unambiguous. Several means the code is refined by evidence, and
  // choosing between them without reading that evidence would be a guess — so the
  // ambiguity is resolved by an explicit default, declared here beside the table.
  if (candidates.length === 1) return candidates[0];
  return AMBIGUOUS_CODE_DEFAULTS[code];
}

/**
 * Where one runner code is refined by several classes, the one to assume before any
 * evidence has been read.
 *
 * `execution_failed` is refined by `runner_execution_failed` and
 * `runner_permission_required`, and the generic one is the honest default: claiming a
 * permission problem without having matched a denial signature would be an assertion
 * nobody measured. {@link classifyRunnerFailure} upgrades it when the signature is there.
 */
const AMBIGUOUS_CODE_DEFAULTS: Partial<Record<RunnerErrorCode, FailureClass>> = {
  execution_failed: 'runner_execution_failed',
  // `invalid_output` is refined by `malformed_runner_output` and by
  // `plan_rejected_by_checks`, and the generic one is the honest default for the
  // same reason `execution_failed` has one: only the pipeline knows the schema
  // passed before a plan rule turned the output down, and it asserts that class
  // explicitly. Assuming the sharper one from a bare code would be a guess.
  invalid_output: 'malformed_runner_output',
};

// ---------------------------------------------------------------------------
// Signature matching (AR-02, C-06)
// ---------------------------------------------------------------------------

/**
 * One way a runner says "local policy would not let me use a tool".
 *
 * **Every entry must describe a *tool confirmation*, never a bare denial.** That
 * constraint is the whole design. `permission denied` on its own appears in `EACCES`
 * messages, in shell output, in compiler errors and inside test assertions, and matching it
 * would send a person to grant a tool that was never the problem — while also marking the
 * attempt as not-consumed when the agent genuinely failed at its work. Both halves of that
 * mistake are worse than the generic class.
 *
 * `command` captures group 1 when present, so an escalation can name what to grant instead
 * of saying "grant something".
 */
interface DenialSignature {
  readonly pattern: RegExp;
  /** Why this wording is trusted. Kept beside the pattern so a future entry has to argue. */
  readonly seenIn: string;
}

const PERMISSION_DENIAL_SIGNATURES: readonly DenialSignature[] = [
  {
    // The AF-2026-002 wording, read out of the vendor's own log directory by hand because
    // the raw output was discarded at both persistence points.
    pattern: /soft-denying tool confirmation\s+["']([^"']+)["']/i,
    seenIn: 'AGY 1.1.13 — the evidence run',
  },
  {
    pattern: /(?:tool call|tool use|tool request)[^\n]{0,60}?requires? (?:approval|confirmation)(?:[^\n]*?[:\s]["']?([A-Za-z_][\w.-]*)\s*\()?/i,
    seenIn: 'generic CLI phrasing for an unattended approval prompt',
  },
  {
    pattern: /(?:permission|approval) (?:check )?(?:failed|denied) for tool\s+["']?([\w.-]+)/i,
    seenIn: 'generic CLI phrasing, tool named',
  },
];

/**
 * A second signal that must accompany a weak match, never a match on its own.
 *
 * `permission check failed` is strong evidence *in the company of* a tool request and
 * useless without one, which is exactly the shape a corroborating pattern has.
 */
const DENIAL_CORROBORATION = /permission check failed|could not continue without the requested tool/i;

/** A tool request line, used only to corroborate — never to classify by itself. */
const TOOL_REQUEST = /tool (?:request|call|use)\s*:?\s*["']?([A-Za-z_][\w.-]*)/i;

export interface RunnerFailureClassification {
  readonly failureClass: FailureClass;
  /** What the runner was refused, when the evidence names it (C-06). */
  readonly deniedCommand?: string;
}

/**
 * The class a runner failure deserves, given its code and — when it helps — its output.
 *
 * Table-driven, deterministic, and it never calls a model: an identical input classifies
 * identically every time, which is what lets a recovery decision be audited rather than
 * re-litigated.
 *
 * The signature pass runs **only** for a code that several classes refine. A code with one
 * refinement is already unambiguous, and reading prose could only make that answer worse.
 *
 * Falling back to the default refinement is always a correct outcome. This function is
 * built to be wrong in one direction only — it would rather report `runner_execution_failed`
 * for a genuine permission denial than the reverse, because the first costs a diagnosis and
 * the second costs a person's afternoon plus a miscounted attempt budget.
 *
 * `redactedRaw` is named for what it must be. Redaction happens at the boundary that
 * persists (AD-35), and this module is pure: it neither redacts nor checks, so a caller
 * handing it unredacted text gets a correct class and keeps its own I-21 problem.
 */
export function classifyRunnerFailure(input: {
  readonly errorCode: RunnerErrorCode;
  readonly redactedRaw?: string;
}): RunnerFailureClassification {
  const candidates = classesRefining(input.errorCode);
  const fallback =
    defaultClassForRunnerError(input.errorCode) ??
    // Unreachable for today's codes and not defaulted away: a code with no refinement at
    // all is a table that has drifted from the enum, and the generic runner class is the
    // only honest thing left to say about a runner that failed.
    'runner_execution_failed';

  const raw = input.redactedRaw;
  if (raw === undefined || raw.length === 0) return { failureClass: fallback };

  // One candidate means the code is already decided. Nothing in the text can improve it.
  if (candidates.length < 2) return { failureClass: fallback };
  if (!candidates.includes('runner_permission_required')) return { failureClass: fallback };

  for (const signature of PERMISSION_DENIAL_SIGNATURES) {
    const match = signature.pattern.exec(raw);
    if (match === null) continue;

    const named = match[1] ?? TOOL_REQUEST.exec(raw)?.[1];
    return {
      failureClass: 'runner_permission_required',
      ...(named === undefined ? {} : { deniedCommand: named }),
    };
  }

  // The corroborating signal, which is allowed to decide only when a tool request is also
  // present. On its own it is a sentence a build tool could plausibly print.
  if (DENIAL_CORROBORATION.test(raw)) {
    const named = TOOL_REQUEST.exec(raw)?.[1];
    if (named !== undefined) {
      return { failureClass: 'runner_permission_required', deniedCommand: named };
    }
  }

  return { failureClass: fallback };
}
