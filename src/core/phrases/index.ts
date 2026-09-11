import type { Locale } from '../../contracts/index.js';
import { en } from './en.js';
import { ptBR } from './pt-BR.js';

/**
 * The sentences the *product* writes, in the reader's language.
 *
 * **Why this exists at all.** The Deck learned Portuguese and the screen came out
 * bilingual: every label the browser authored was translated, and every sentence the
 * *server* sent was not — the attention queue, a card's reason, a refusal, the doctor's
 * advice. A screen in two languages is worse than a screen in the wrong one, because the
 * reader cannot tell which half is stale.
 *
 * **The core takes a phrase book; it does not look one up.** These functions are folds
 * over state, and a module-level locale would make them functions of when they ran — the
 * same reason `formatRelative` and the audit-log sentences take theirs as an argument.
 * The book arrives with the input.
 *
 * **The CLI always passes English, by construction rather than by discipline.** A
 * terminal's output is quoted into issues, pasted into scripts and grepped by people who
 * did not write it. Nothing in `src/cli` reads a locale, so nothing there can change
 * language; `DEFAULT_LOCALE` is what a caller that does not ask receives.
 *
 * **What no book can translate.** A reviewer's finding, an SDD, a feature description, a
 * message one agent sent another: those are written by a model, in whatever language it
 * answered in, and they reach the screen verbatim because rewriting a model's words is
 * the one thing a renderer must never do.
 *
 * **And what it deliberately does not: prose that was written into a run's evidence.** A
 * rejected inbox message's reason, a delivery failure's detail, a Definition of Done
 * condition, a fallback audit entry — each is computed once, during execution, and
 * persisted. Translating those would mean a record whose language depends on who
 * happened to press the button, and a run whose log is half Portuguese because two
 * people worked on it. The book covers what is folded *at read time*, which is what the
 * screen actually asks for; the record stays English, like a commit message.
 */
export interface Phrases {
  /**
   * What holds the run, in one imperative sentence (`RuntimeGate.action`, C-19 … C-22).
   *
   * The command names inside these are identifiers — `agent-flow approve` is typed, not
   * read — so they survive translation unchanged, and the words around them do not.
   */
  readonly gate: {
    readonly approval: string;
    readonly taskReview: (tasks: string) => string;
    readonly agentBlocked: (tasks: string) => string;
    readonly taskFailed: (tasks: string, waiting: string) => string;
    /** Appended to `taskFailed` when a failure has dependents; empty when it has none. */
    readonly waitingOn: (tasks: string) => string;
    readonly finalAcceptance: string;
  };







  /**
   * The settings catalogue: section titles, row labels, and the notes under them (M8 §12).
   *
   * Configuration *keys* are never translated — `parallelism.maxTasks` is what a person
   * types into a YAML file — and neither are the values, which are the file's own words.
   * What translates is the label beside the key and the sentence under it.
   */
  readonly config: {
    readonly general: string;
    readonly workspace: string;
    readonly runners: string;
    readonly models: string;
    readonly execution: string;
    readonly ui: string;
    readonly retention: string;

    readonly configUnreadable: string;
    readonly correctBeforeSaving: string;
    readonly configVersion: string;
    readonly globalConfig: string;
    readonly projectConfig: string;
    readonly notPresentDefaults: string;
    readonly notPresent: string;
    readonly projectName: string;
    readonly detectedStack: string;
    readonly notDetected: string;
    readonly sourcePaths: string;
    readonly testPaths: string;
    readonly architectureRules: string;
    readonly enabled: string;
    readonly disabled: string;
    readonly commandIs: (command: string) => string;
    readonly roleRoutingHasItsOwnPage: string;
    readonly approvalBeforeImplementation: string;
    readonly required: string;
    readonly notRequired: string;
    readonly canStartWithoutGate: string;
    readonly parallelTasks: string;
    readonly attemptsPerTask: string;
    readonly gitWorktrees: string;
    readonly on: string;
    readonly off: string;
    readonly fallback: string;
    readonly fallbackTriggers: string;
    readonly infrastructureOnly: string;
    readonly extraValidationCommands: string;
    readonly planNamesById: string;
    readonly everythingElseInBrowser: string;
    readonly workspaceScanDepth: string;
    readonly scanDepthNote: string;
    readonly retentionNote: string;
    readonly notSet: string;
    readonly none: string;
    readonly declared: (total: number) => string;
    readonly configuredNotEffective: (effective: number) => string;
    readonly newRunsExecuteUpTo: (isolated: number, shared: number) => string;
  };
  /**
   * What the doctor found wrong with the machine, and the one command that fixes it (§8).
   *
   * Install and login commands are typed verbatim — `npm install -g @openai/codex` is not
   * a sentence — so only the verb around them changes. Runner ids are identifiers.
   */
  readonly doctor: {
    readonly authNotVerified: (runners: string) => string;
    readonly runnerNotUsable: (runner: string) => string;
    readonly rolesWillRunOn: (from: string, to: string) => string;
    readonly onlyOneUsable: (provider: string) => string;
    readonly noCrossProviderReview: string;
    readonly nodeMissing: string;
    readonly installNode: string;
    readonly gitMissingOrOld: string;
    readonly installGit: string;
    readonly runnerNotInstalled: (runner: string) => string;
    readonly runnerMissingCredentials: (runner: string) => string;
    /**
     * Written around the command rather than about the runner (§3, §58).
     *
     * `src/core` names no provider, and these sentences would have named four. The
     * command, the product and the variable arrive from `src/app`, which is the layer
     * entitled to know that `codex` exists; the book only supplies the verb.
     */
    readonly installAndEnsurePath: (product: string, command: string) => string;
    readonly runLoginOrExport: (command: string, variable: string) => string;
    readonly runInTerminal: (command: string) => string;
    readonly installProbeReason: string;
  };
  /**
   * Where the work has got to on the forge, in one sentence (M7 §40).
   *
   * Commit hashes, branch names, `owner/repo` and pull-request numbers are the facts a
   * reader copies into a browser; only the words between them belong here. A delivery
   * *failure*'s own detail is not in the book — it is the forge's answer, quoted.
   */
  readonly delivery: {
    readonly noForgeConfigured: string;
    readonly nothingPublished: string;
    readonly onBranchNoPr: (commit: string, branch: string) => string;
    readonly prPointsElsewhere: (number: string, head: string, approved: string) => string;
    readonly prOpenNoChecks: (number: string) => string;
    readonly checksUnfinished: (pending: number, total: number) => string;
    readonly checksFailed: (red: number) => string;
    readonly allChecksPassed: (total: number) => string;
  };
  /**
   * What the HTTP layer itself refuses, as opposed to what a use case refuses (§60).
   *
   * A short list on purpose. The server owns four kinds of answer a use case cannot give
   * — a run already busy *in this process*, a config edit racing another, a route that
   * does not exist, and a project written but not yet visible to the scan — and every
   * other refusal it returns is a use case's, passed through untouched.
   */
  readonly server: {
    readonly noSuchCandidate: string;
    readonly noSuchProject: string;
    readonly noSuchRun: string;
    readonly noSuchTask: string;
    readonly noSuchArtifact: string;
    readonly noSuchPrompt: string;
    readonly noSuchJob: string;
    readonly expectedCandidateId: string;
    readonly invalidProjectId: string;
    readonly unknownPipelineStage: string;
    readonly invalidRunOrTaskId: string;
    readonly unknownArtifact: string;
    readonly invalidDoctorOptions: string;
    readonly invalidCleanupOptions: string;
    readonly invalidConfigurationTarget: string;
    readonly invalidConfigurationRequest: string;
    readonly unknownPrompt: string;
    readonly invalidAnalyticsScope: string;
    readonly featureNeedsDescription: string;
    readonly invalidPlanResumeRequest: string;
    readonly invalidApproveRequest: string;
    readonly invalidRejectRequest: string;
    readonly invalidRetryRequest: string;
    readonly invalidStartRequest: string;
    readonly revisionNeedsInstruction: string;
    readonly invalidReviewRequest: string;
    readonly invalidJobId: string;
    readonly invalidFilter: string;
    readonly invalidRunId: string;
    readonly plannedTasks: (tasks: number, review: string) => string;
    readonly replannedInto: (tasks: number, review: string) => string;
    /** Appended to a planning summary when a plan review ran; empty when none did. */
    readonly reviewVerdictSuffix: (verdict: string) => string;
    readonly initRunActive: (runId: string, status: string) => string;
    readonly finishOrAbandonFirst: string;
    readonly writtenButNotScanned: string;
    readonly restartUiCheckRoot: string;
    readonly configChangedAfterLoad: string;
    readonly reviewFreshAndRetry: string;
    readonly noSuchRunShort: (runId: string) => string;
    readonly checkTheRunId: string;
    readonly alreadyBusyHere: (runId: string, what: string) => string;
    readonly busyRunning: string;
    readonly busyBeingReviewed: string;
    readonly busyPlanning: string;
    readonly busyReplanning: string;
    readonly busyRetrying: string;
    readonly waitForExecution: string;
    readonly waitOrWatch: string;
    readonly noSuchEndpoint: string;
    readonly lockedByAnother: (runId: string) => string;
    readonly beingByOwner: (runId: string, operation: string, owner: string, where: string) => string;
    readonly wherePid: (pid: string) => string;
    readonly whereHost: (hostname: string) => string;
    readonly lockFromAnotherMachine: string;
    readonly configNotEditable: string;
    readonly correctYamlRetry: string;
    readonly configUnreadable: string;
    readonly checkFsRetry: string;
  };
  /**
   * What is wrong with the repository, and the one command that fixes it (§6.3, C-01).
   *
   * Two halves that travel together and are written apart: a *detail* naming the state
   * the repository is in, and an *action* naming what to do about it. The action is
   * derived from the refusal code, so it is a closed set; the detail is not, because some
   * of them are Git's own stderr passed through — and Git answers in Git's language, not
   * in one this book can choose.
   *
   * Commit hashes, branch names, paths and refusal codes stay as they are.
   */
  readonly git: {
    readonly notAGitRepository: string;
    readonly repositoryIsBare: string;
    readonly repositoryHasNoCommits: string;
    readonly repositoryHasSubmodules: string;
    readonly gitVersionUnsupported: (version: string) => string;
    readonly repositoryRootUnresolvable: string;
    readonly worktreePathTooLong: string;
    readonly gitIdentityMissing: string;
    readonly agentFlowStateNotIgnored: string;
    readonly workingTreeDirty: string;
    readonly planningBaseMoved: string;
    readonly gitRunKeyCollision: string;
    readonly namespaceMissing: string;
    readonly integrationHeadDiverged: string;
    readonly gitUnavailable: string;

    readonly headNamesNoCommit: string;
    readonly noConfigAt: (path: string) => string;
    readonly bareHasNoWorkingTree: string;
    readonly notInsideWorkingTree: (dir: string) => string;
    readonly headIsUnborn: string;
    readonly submoduleStatusUnreadable: string;
    readonly worktreeAddSkipsSubmodules: string;
    readonly rootUnresolvable: string;
    readonly worstCasePathUncomposable: string;
    readonly pathNotIgnored: (path: string) => string;
    readonly treeHasUncommitted: (files: string, more: boolean) => string;
    readonly noNamespaceRecorded: string;
    readonly namespaceNotThisRun: (key: string, runId: string) => string;
    readonly noNamespace: string;
    readonly plannedAgainstHeadNow: (base: string, head: string) => string;
    /** Substituted for a commit hash when HEAD has none. */
    readonly unborn: string;
    readonly integrationNoLongerContains: (commit: string) => string;

    readonly worktreeCannotSupport: (code: string, detail: string) => string;
    readonly notInitialised: (detail: string) => string;
    readonly runInitFirst: string;
    readonly worktreeRequestedNotReady: (code: string, detail: string) => string;
  };
  /**
   * Every refusal a use case can answer with, and the one thing to do about it (§95).
   *
   * These are the sentences behind a button that did not work: approve, run, pause,
   * resume, cancel, retry, revise. The CLI prints them and the Deck shows them, which is
   * exactly why they are here rather than in either — a screen that refuses in English
   * and labels its button in Portuguese has told the reader nothing about which half is
   * current.
   *
   * Run ids, task ids, stage names, statuses and workflow names pass through untranslated:
   * `TASK-004`, `sdd`, `completed` and `STANDARD` are typed back into a terminal or matched
   * against a file, and a translated one matches nothing.
   */
  readonly actions: {
    readonly noSuchRun: (runId: string) => string;

    readonly lockUnreadable: (runId: string) => string;
    readonly lockUnreadableAction: string;
    readonly atPid: (pid: string) => string;
    readonly atHost: (hostname: string) => string;
    readonly alreadyBeing: (
      runId: string,
      operation: string,
      owner: string,
      where: string,
      since: string,
    ) => string;
    readonly waitForExecution: string;
    readonly lockOnAnotherHost: string;
    readonly beingExecuted: string;
    readonly beingReplanned: string;
    readonly beingRetried: string;
    readonly beingApproved: string;
    readonly beingRejected: string;
    readonly beingReviewed: string;
    /** Appended to a resume refusal when the lock names a holder; empty when it does not. */
    readonly heldByPidOn: (pid: string, hostname: string) => string;

    readonly noPlanYetToApprove: (runId: string) => string;
    readonly finishPlanningFirst: string;
    readonly noPlanToApprove: string;
    readonly repositoryNotReady: (runId: string, detail: string) => string;

    readonly alreadyRejected: (runId: string) => string;
    readonly completedCannotReject: (runId: string) => string;
    readonly startNewRunIfRevisiting: string;

    readonly taskNeverRan: (taskId: string, runId: string) => string;
    readonly onlyAttemptedCanRetry: string;
    readonly taskAlreadyCompleted: (taskId: string, integrated: boolean) => string;
    readonly retryingFinishedWork: string;
    readonly taskMarkedRunning: (taskId: string) => string;
    readonly runReconcilesFirst: string;
    readonly taskAnsweredBlocked: (taskId: string) => string;
    readonly fixSddOrForce: string;

    readonly runPausedAt: (runId: string, at: string) => string;
    readonly resumeIt: string;
    readonly runCancelledTerminal: (runId: string, at: string) => string;
    /** Appended to `runCancelledTerminal` when the cancellation has an instant. */
    readonly cancelledAt: (at: string) => string;
    readonly evidenceStillOnDisk: string;
    readonly finishedNothingToRun: (runId: string, status: string) => string;
    readonly noRunnableAtReview: (runId: string, tasks: string, count: number) => string;
    readonly noRunnableBlocked: (runId: string, tasks: string, count: number) => string;
    readonly noRunnableFailed: (runId: string, tasks: string, count: number) => string;
    readonly noRunnableInState: (runId: string, status: string) => string;
    readonly reviewEvidenceThenRetry: (taskId: string) => string;
    readonly answerBlockedThenRetry: string;
    readonly startNewOrCheckStatus: string;
    readonly planRejected: (runId: string) => string;
    readonly revisePlanOrStartNew: string;
    readonly runHasNoPlan: (runId: string) => string;
    readonly finishPlanningBeforeStarting: string;
    readonly planNotApproved: (runId: string) => string;
    readonly reviewAndApproveBeforeStarting: string;
    readonly approvalStale: string;
    readonly readPlanApproveAgain: string;
    readonly runHasNoSdd: (runId: string, workflow: string) => string;
    readonly rerunSddStage: string;
    readonly noSuchTaskInPlan: (taskId: string, runId: string) => string;
    readonly dependsOnUnmet: (taskId: string, unmet: string) => string;
    readonly runInOrder: string;

    readonly cancelledNothingToPause: (runId: string) => string;
    readonly startNewRunFeature: string;
    readonly finishedNothingToPause: (runId: string, status: string) => string;

    readonly runNotPaused: (runId: string) => string;
    readonly runItWithRun: string;
    readonly stillExecuting: (runId: string, holder: string) => string;
    readonly waitForBoundary: string;

    readonly finishedNothingToCancel: (runId: string, status: string) => string;

    readonly revisionNeedsInstruction: string;
    readonly trivialNoRevision: string;
    readonly approveAsIsOrStandard: string;
    readonly ceremonyBudget: (workflow: string, cycles: number) => string;
    readonly reviewResidualFindings: string;

    readonly featureNeedsDescription: string;
    readonly sayWhatFeatureDoes: string;

    readonly promptsMismatch: string;
    readonly stageFailed: (
      stage: string,
      failureClass: string,
      errorCode: string,
      message: string,
    ) => string;
    /**
     * What a resume keeps and what it pays for again (D7).
     *
     * Three arguments rather than one, because the sentence used to assert that everything
     * before the stage survived and a measured resume redid discovery. `kept` and `rerun`
     * arrive already joined — they are stage names, which are identifiers.
     */
    readonly stagesBeforeKept: (stage: string, kept: string, rerun: string) => string;

    readonly noPlanToReviewAgainst: (runId: string) => string;
    readonly finishPlanningBeforeReviewing: string;

    readonly integrationTreeUnreadable: (runId: string, detail: string) => string;
    readonly integrationBranchIsProduct: string;

    readonly notActiveRunAndNone: (runId: string) => string;
    readonly notActiveRunButIs: (runId: string, current: string) => string;
    readonly onlyActiveRun: string;

    readonly processWasExecuting: (holder: string) => string;
    readonly noActiveRun: string;
    readonly thisRunHasNoPlan: string;
    readonly planNotReviewed: string;
    readonly runReviewOrApproveOver: string;
    readonly reviewJudgedAnother: string;
    readonly requestRevisionOrApprove: string;
    readonly reviewUnverifiable: string;
    readonly reviewFailedWith: (findings: number) => string;
    readonly requestRevisionAddressing: string;
    readonly alreadyApproved: string;
    readonly planWasRejected: string;
    readonly revisePlanOrApproveOver: string;
    readonly approvalNotPossible: string;
  };
  /**
   * A board card's one-line reason, and it is the sentence, not the lane (M7 §12).
   *
   * The lane is an enum the Deck styles; this is the prose beneath it, and the only part
   * of a card a reader actually reads. Task ids inside it are pass-through — `held back by
   * TASK-004` names a task, and a translated id names nothing.
   *
   * Counts arrive as numbers rather than as formatted text because Portuguese agrees with
   * them: *1 achado bloqueante*, *2 achados bloqueantes*.
   */
  readonly board: {
    readonly completed: string;
    readonly unknownState: (state: string) => string;
    /** `attempts` is the count, not an index: 1 says nothing, 2 and up name themselves. */
    readonly failed: (attempts: number) => string;
    readonly interruptedByStop: string;
    readonly heldBackBy: (tasks: string) => string;
    readonly heldByUpstreamFailure: string;
    readonly agentReportedSdd: string;
    readonly waitingForReviewDecision: string;
    readonly changesRequested: (blocking: number) => string;
    readonly reviewMovedPast: string;
    readonly inReviewRound: (round: number) => string;
    readonly waitingToMerge: string;
    readonly interruptedWillRequeue: string;
    readonly running: (attempt: number, ownWorktree: boolean) => string;
    readonly readyToStart: string;
    readonly waitingOn: (tasks: string) => string;
    readonly plannedNotReady: string;
    readonly everyEligibleAgent: string;
    readonly heldOneWave: (who: string) => string;
    readonly anExclusiveArea: string;
    readonly ownershipConflict: (area: string, holder: string) => string;
    /** Appended to `ownershipConflict` when the area has a holder; empty when it has none. */
    readonly heldBy: (who: string) => string;
  };

  /**
   * The attention queue: one row's *what*, its *why*, and the single thing to do (M8 §8).
   *
   * Several `why` values are not here and cannot be: they are another module's prose
   * passed through — a delivery's detail, an escalation's human action, a deferral's
   * explanation. Those arrive already written, and they are that module's to translate.
   */
  readonly attention: {
    readonly remoteDiverged: string;
    readonly inspectRemote: string;
    readonly couldNotMerge: (task: string) => string;
    readonly conflictingPaths: (paths: string) => string;
    readonly integratedFirst: (task: string, paths: string) => string;
    readonly open: (task: string) => string;
    readonly heldByOwnership: (task: string) => string;
    readonly reviewOwnership: string;

    readonly planWaiting: string;
    readonly nothingRunsUntilGate: string;
    readonly reviewThePlan: string;
    readonly exhaustedRecovery: (task: string) => string;
    readonly repairsTried: (failureClass: string, repairs: number) => string;
    readonly waitingForReview: (task: string) => string;
    readonly nothingAcceptedIt: string;
    readonly reportedBlocked: (task: string) => string;
    readonly sddDoesNotAnswer: string;
    readonly readWhatAsked: (task: string) => string;

    readonly taskFailed: (task: string) => string;
    readonly attemptsNoneSatisfied: (attempts: number) => string;
    readonly attemptDidNotSatisfy: string;
    readonly requeue: (task: string) => string;
    readonly gateDidNotRun: (gate: string) => string;
    readonly gateFailed: (gate: string) => string;
    readonly nothingRecordedResult: string;
    readonly exitCode: (code: string) => string;
    readonly openQualityGates: string;
    readonly blockingFindings: (task: string, count: number) => string;
    readonly reviewRequestedChanges: string;
    readonly readTheFindings: string;
    readonly remoteChecksFailed: (red: number) => string;
    readonly deliveryNotLocalQuality: string;
    readonly openTheDelivery: string;
    readonly deliveryFailed: string;
    readonly runForgeSync: string;

    readonly reviewMovedPast: string;
    readonly stageStartedAfter: string;
    readonly openTheReview: string;
    readonly reviewOfIsStale: (task: string) => string;
    readonly namesATreeMovedPast: string;
    readonly openTheReviewThread: string;
    readonly operatorAskedToStop: string;
    readonly noNewTaskStarts: string;
    readonly resumeTheRun: string;
    readonly readyAndNobodyTakes: (task: string) => string;
    readonly everyMemberAtCapacity: string;
    readonly openTheTeam: string;
    readonly runIsDegraded: (kind: string) => string;
    readonly reasonAndImpact: (reason: string, impact: string) => string;
    readonly finishedNothingPublished: string;
    readonly runForgePublish: string;
    readonly checksPending: (pending: number) => string;
    readonly checksAreObservation: string;
    readonly openTheRunSummary: string;
  };
}

const BOOKS: Readonly<Record<Locale, Phrases>> = { en, 'pt-BR': ptBR };

export function phrasesFor(locale: Locale): Phrases {
  return BOOKS[locale];
}

export { en, ptBR };
