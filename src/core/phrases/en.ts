import type { Phrases } from './index.js';

/**
 * English, and it reproduces what these modules said before the book existed.
 *
 * Byte-for-byte on purpose: every test that asserts one of these sentences was written
 * against the behaviour, not against the mechanism, and a translation layer that quietly
 * reworded the product would be a refactor pretending to be a rename.
 */
export const en: Phrases = {
  gate: {
    approval: 'Review the plan and run `agent-flow approve`',
    taskReview: (tasks) => `Review ${tasks}, then requeue with \`agent-flow retry\` or accept the outcome`,
    agentBlocked: (tasks) => `Answer what ${tasks} reported as blocking, then requeue`,
    taskFailed: (tasks, waiting) => `Fix what stopped ${tasks}, then \`agent-flow retry\` it.${waiting}`,
    waitingOn: (tasks) => ` ${tasks} are waiting on it.`,
    finalAcceptance: 'Run `agent-flow review`, then accept and merge',
  },







  config: {
    general: 'General',
    workspace: 'Workspace',
    runners: 'Runners',
    models: 'Models',
    execution: 'Execution',
    ui: 'UI',
    retention: 'Retention',

    configUnreadable: 'The configuration could not be read.',
    correctBeforeSaving: 'Correct the request before saving.',
    configVersion: 'Config version',
    globalConfig: 'Global config',
    projectConfig: 'Project config',
    notPresentDefaults: 'not present — the built-in defaults are in force',
    notPresent: 'not present',
    projectName: 'Project name',
    detectedStack: 'Detected stack',
    notDetected: 'not detected',
    sourcePaths: 'Source paths',
    testPaths: 'Test paths',
    architectureRules: 'Architecture rules',
    enabled: 'enabled',
    disabled: 'disabled',
    commandIs: (command) => `command ${command}`,
    roleRoutingHasItsOwnPage:
      'Role routing has its own page, which resolves each role against what its runner can actually do.',
    approvalBeforeImplementation: 'Approval before implementation',
    required: 'required',
    notRequired: 'not required',
    canStartWithoutGate: 'implementation can start without a human opening the gate',
    parallelTasks: 'Parallel tasks',
    attemptsPerTask: 'Attempts per task',
    gitWorktrees: 'Git worktrees',
    on: 'on',
    off: 'off',
    fallback: 'Fallback',
    fallbackTriggers: 'Fallback triggers',
    infrastructureOnly:
      'infrastructure failures only — a capability gap is never routed around',
    extraValidationCommands: 'Extra validation commands',
    planNamesById: 'a plan names one of these by id; nothing a model writes reaches a shell',
    everythingElseInBrowser:
      'Everything else the dashboard remembers — filters, tabs, which task is open — lives in the browser.',
    workspaceScanDepth: 'Workspace scan depth',
    scanDepthNote:
      'how far under a workspace root `agent-flow ui ~/wk` looks for projects; a directory beyond it is not discovered and not served',
    uiPairing: 'Device pairing',
    uiPairingNote:
      'whether remote devices can pair with this server via a short-lived pairing code',
    retentionNote:
      'Run history is pruned on request rather than on a policy: agent-flow clean --keep <n>. There is no retention setting to read.',
    notSet: 'not set',
    none: 'none',
    declared: (total) => `${String(total)} declared`,
    configuredNotEffective: (effective) =>
      `configured, not effective: without isolated workspaces a run executes ` +
      `${String(effective)} task at a time — turn on git.useWorktrees, then start a new run`,
    newRunsExecuteUpTo: (isolated, shared) =>
      `new runs execute up to ${String(isolated)} at a time in isolated workspaces; ` +
      `a run created before worktrees were on still executes ${String(shared)}`,
  },
  doctor: {
    authNotVerified: (runners) =>
      `authentication not verified for: ${runners} ` +
      '(use `doctor --deep` to check for real)',
    runnerNotUsable: (runner) => `runner "${runner}" is not usable`,
    rolesWillRunOn: (from, to) => `roles configured for "${from}" will run on "${to}" instead`,
    onlyOneUsable: (provider) => `only "${provider}" is usable`,
    noCrossProviderReview:
      'plan review and final review cannot be cross-provider; they will run same-provider ' +
      'with a fresh context, which does not protect against a repeated wrong assumption',
    nodeMissing: 'Node.js is missing from PATH',
    installNode: 'Install Node.js 20+ (https://nodejs.org or via fnm/nvm)',
    gitMissingOrOld: 'Git is missing or older than 2.38',
    installGit: 'Install Git 2.38+ (https://git-scm.com or via your package manager)',
    runnerNotInstalled: (runner) => `Runner "${runner}" is not installed or executable`,
    runnerMissingCredentials: (runner) => `Runner "${runner}" is missing credentials`,
    installAndEnsurePath: (product, command) =>
      `Install ${product} and ensure \`${command}\` is available in PATH`,
    runLoginOrExport: (command, variable) => `Run \`${command}\` or export ${variable}`,
    runInTerminal: (command) => `Run \`${command}\` in your terminal`,
    installProbeReason: 'agent-flow doctor install probe',
    remoteAccessUndetermined:
      'remote access status cannot be determined from a terminal; ask the running server',
  },
  delivery: {
    noForgeConfigured: 'no forge is configured, so this run delivers nowhere',
    nothingPublished: 'nothing has been published for this run yet',
    onBranchNoPr: (commit, branch) => `${commit} is on ${branch}, with no pull request`,
    prPointsElsewhere: (number, head, approved) =>
      `pull request #${number} points at ${head}, and this run approved ${approved}`,
    prOpenNoChecks: (number) => `pull request #${number} is open; no checks were observed`,
    checksUnfinished: (pending, total) =>
      `${String(pending)} of ${String(total)} checks have not finished`,
    checksFailed: (red) =>
      `${String(red)} remote check(s) failed. This is delivery, not quality: ` +
      'the local run is unaffected',
    allChecksPassed: (total) => `all ${String(total)} remote checks passed`,
  },
  server: {
    noSuchCandidate: 'no such candidate',
    noSuchProject: 'no such project',
    noSuchRun: 'no such run',
    noSuchTask: 'no such task',
    noSuchArtifact: 'no such artifact',
    noSuchPrompt: 'no such prompt',
    noSuchJob: 'no such job',
    expectedCandidateId: 'expected a candidate id',
    invalidProjectId: 'invalid projectId',
    unknownPipelineStage: 'unknown pipeline stage',
    invalidRunOrTaskId: 'invalid run or task id',
    unknownArtifact: 'unknown artifact',
    invalidDoctorOptions: 'invalid doctor options',
    invalidCleanupOptions: 'invalid cleanup options',
    invalidConfigurationTarget: 'invalid configuration target',
    invalidConfigurationRequest: 'invalid configuration request',
    unknownPrompt: 'unknown prompt',
    invalidAnalyticsScope: 'invalid analytics scope',
    featureNeedsDescription: 'a feature needs a description',
    invalidPlanResumeRequest: 'invalid plan resume request',
    invalidApproveRequest: 'invalid approve request',
    invalidRejectRequest: 'invalid reject request',
    invalidRetryRequest: 'invalid retry request',
    invalidStartRequest: 'invalid start request',
    revisionNeedsInstruction: 'a revision needs an instruction saying what should change',
    invalidReviewRequest: 'invalid review request',
    invalidJobId: 'invalid job id',
    invalidFilter: 'invalid filter',
    invalidRunId: 'invalid run id',
    plannedTasks: (tasks, review) => `Planned ${String(tasks)} tasks${review}.`,
    replannedInto: (tasks, review) => `Re-planned into ${String(tasks)} tasks${review}.`,
    reviewVerdictSuffix: (verdict) => `; review ${verdict}`,
    initRunActive: (runId, status) =>
      `Run ${runId} is still active (${status}). init writes files that have to be committed, and that commit moves HEAD.`,
    finishOrAbandonFirst: 'Finish or abandon the run first, or retry with force to proceed anyway.',
    writtenButNotScanned: 'The project was written but the workspace scan did not pick it up.',
    restartUiCheckRoot: 'Restart `agent-flow ui` and check the workspace root and depth.',
    configChangedAfterLoad: 'The configuration changed after it was loaded.',
    reviewFreshAndRetry: 'Review the fresh state and retry your changes.',
    noSuchRunShort: (runId) => `No such run ${runId}`,
    checkTheRunId: 'Check the run id.',
    alreadyBusyHere: (runId, what) => `${runId} is already ${what} in this server.`,
    busyRunning: 'running',
    busyBeingReviewed: 'being reviewed',
    busyPlanning: 'planning',
    busyReplanning: 're-planning',
    busyRetrying: 'modified by a retry',
    waitForExecution: 'Wait for the active execution to finish.',
    waitOrWatch: 'Wait for it to finish, or watch it on the run page.',
    noSuchEndpoint: 'no such endpoint',
    lockedByAnother: (runId) => `${runId} is locked by another process.`,
    beingByOwner: (runId, operation, owner, where) =>
      `${runId} is already being ${operation} by the ${owner}${where}.`,
    wherePid: (pid) => ` (pid ${pid})`,
    whereHost: (hostname) => ` on ${hostname}`,
    lockFromAnotherMachine:
      'The lock was written by another machine, which this server will not judge.',
    configNotEditable: 'The configuration source cannot be edited safely.',
    correctYamlRetry: 'Correct the YAML source and retry.',
    configUnreadable: 'The configuration could not be read or saved.',
    checkFsRetry: 'Check filesystem access and retry.',
    pairingNotEnabled: 'pairing is not enabled on this server',
    invalidPairRequest: 'invalid pairing request',
    invalidPairingCode: 'invalid pairing code',
    sessionLimitReached: 'the limit of 16 live device sessions has been reached',
    noSuchDeviceSession: 'no such device session',
    invalidDeviceSessionRequest: 'invalid device session request',
  },
  git: {
    notAGitRepository: 'Run `git init`, or turn worktree mode off with `git.useWorktrees: false`.',
    repositoryIsBare: 'Worktree mode needs a working tree. Use a normal clone.',
    repositoryHasNoCommits: 'Make the first commit; there is no base to cut a branch from yet.',
    repositoryHasSubmodules:
      'Worktree mode does not populate submodules. Turn it off for this project.',
    gitVersionUnsupported: (version) => `Upgrade Git to ${version} or newer.`,
    repositoryRootUnresolvable:
      'The repository root could not be resolved. Check for a broken symlink above it.',
    worktreePathTooLong:
      'Use a shorter home directory path, or enable long paths on this platform.',
    gitIdentityMissing: 'This run has no Git namespace. Start a new run.',
    agentFlowStateNotIgnored:
      'Add `.agent-flow/runs/`, `.agent-flow/cache/` and `.agent-flow/current-run` to .gitignore.',
    workingTreeDirty: 'Commit or stash your changes, then try again.',
    planningBaseMoved: 'Check out the commit this run was planned against, or start a new run.',
    gitRunKeyCollision:
      'This run’s Git namespace already holds refs it did not create. Start a new run.',
    namespaceMissing:
      'The integration branch this run recorded work on is gone. It cannot be rebuilt from here.',
    integrationHeadDiverged:
      'The integration branch was rewound or replaced under this run. Start a new run.',
    gitUnavailable: 'Git could not be run. Check that it is installed and on PATH.',

    headNamesNoCommit: 'HEAD does not name a commit, so there is no base to cut the run from',
    noConfigAt: (path) => `there is no Agent Flow configuration at ${path}`,
    bareHasNoWorkingTree: 'a bare repository has no working tree',
    notInsideWorkingTree: (dir) => `${dir} is not inside a Git working tree`,
    headIsUnborn: 'HEAD is unborn, so there is no commit to cut the run from',
    submoduleStatusUnreadable: 'git submodule status could not be read',
    worktreeAddSkipsSubmodules:
      'git worktree add does not populate submodules, so the worktree would be incomplete',
    rootUnresolvable: 'the repository root could not be resolved, so its identity would not be stable',
    worstCasePathUncomposable:
      'a worst-case workspace path could not be composed from this repository key',
    pathNotIgnored: (path) =>
      `${path} is not ignored by this repository, so Agent Flow's own state would dirty the tree`,
    treeHasUncommitted: (files, more) =>
      `the working tree has uncommitted changes: ${files}${more ? ' …' : ''}`,
    noNamespaceRecorded: 'this run has no Git namespace recorded',
    namespaceNotThisRun: (key, runId) =>
      `the recorded Git namespace "${key}" does not belong to ${runId}`,
    noNamespace: 'this run has no Git namespace',
    plannedAgainstHeadNow: (base, head) =>
      `this run was planned against ${base} and HEAD is now ${head}`,
    unborn: 'unborn',
    integrationNoLongerContains: (commit) =>
      `the integration branch no longer contains ${commit}, which this run recorded as integrated`,

    worktreeCannotSupport: (code, detail) =>
      `Worktree mode was requested and this repository cannot support it (${code}): ${detail}`,
    notInitialised: (detail) => `This project has not been initialised for Agent Flow: ${detail}`,
    runInitFirst: 'Run `agent-flow init`, then commit what it writes.',
    worktreeRequestedNotReady: (code, detail) =>
      `Worktree mode was requested and this repository is not ready (${code}): ${detail}`,
  },
  actions: {
    noSuchRun: (runId) => `There is no run ${runId} in this project.`,

    lockUnreadable: (runId) => `${runId} is locked, and the claim on it could not be read.`,
    lockUnreadableAction:
      'Agent Flow refuses a claim it cannot read rather than guessing, because guessing ' +
      'is how a run gets executed twice. Confirm no Agent Flow process is working on this ' +
      'run — then remove the highest-numbered execution.lock.* file in the run directory.',
    atPid: (pid) => `pid ${pid}`,
    atHost: (hostname) => `host ${hostname}, which is not this machine`,
    alreadyBeing: (runId, operation, owner, where, since) =>
      `${runId} is already being ${operation} by the ${owner} (${where}), since ${since}.`,
    waitForExecution: 'Wait for the active execution to finish.',
    lockOnAnotherHost:
      'Agent Flow does not judge a lock from another machine. Stop the execution on that ' +
      'host, or — if that host is gone — remove the highest-numbered execution.lock.* file ' +
      'in the run directory here.',
    beingExecuted: 'executed',
    beingReplanned: 're-planned',
    beingRetried: 'modified by a retry',
    beingApproved: 'approved',
    beingRejected: 'rejected',
    beingReviewed: 'reviewed',
    heldByPidOn: (pid, hostname) => ` (pid ${pid} on ${hostname})`,

    noPlanYetToApprove: (runId) => `${runId} has no plan yet, so there is nothing to approve.`,
    finishPlanningFirst: 'Finish planning first.',
    noPlanToApprove: 'There is no plan to approve.',
    repositoryNotReady: (runId, detail) =>
      `${runId} is an isolated run and this repository is not ready: ${detail}.`,

    alreadyRejected: (runId) => `${runId} was already rejected.`,
    completedCannotReject: (runId) =>
      `${runId} has already completed. Its plan cannot be rejected after the fact.`,
    startNewRunIfRevisiting: 'Start a new run if the work needs revisiting.',

    taskNeverRan: (taskId, runId) => `${taskId} has not run in ${runId}.`,
    onlyAttemptedCanRetry: 'Only a task that has already been attempted can be retried.',
    taskAlreadyCompleted: (taskId, integrated) =>
      `${taskId} is already completed${integrated ? ', which in worktree mode means integrated' : ''}.`,
    retryingFinishedWork:
      'Retrying finished work would build a second attempt for something the run already ' +
      'has. Revise the plan and start a new run if the work needs to change.',
    taskMarkedRunning: (taskId) =>
      `${taskId} is marked running, so either it is executing now or a process died holding it.`,
    runReconcilesFirst:
      'Run `agent-flow run`: it reconciles what the interrupted attempt actually left before ' +
      'requeuing anything, so a validated attempt is finished rather than repeated.',
    taskAnsweredBlocked: (taskId) =>
      `${taskId} is BLOCKED: its agent answered BLOCKED, so it stopped because of ` +
      'something the SDD does not answer.',
    fixSddOrForce: 'Fix the SDD or the plan — or force the retry deliberately.',

    runPausedAt: (runId, at) => `${runId} was paused at ${at}.`,
    resumeIt: 'Resume it with `agent-flow resume`.',
    runCancelledTerminal: (runId, at) => `${runId} was cancelled${at}, and a cancelled run is terminal.`,
    cancelledAt: (at) => ` at ${at}`,
    evidenceStillOnDisk:
      'Its evidence, its integration branch and its worktrees are all still on disk. ' +
      'Start a new run with `agent-flow feature`.',
    finishedNothingToRun: (runId, status) =>
      `${runId} has finished (${status}), so there is nothing to run.`,
    noRunnableAtReview: (runId, tasks, count) =>
      `${runId} has no runnable task: ${tasks} ${count === 1 ? 'is' : 'are'} at review_required.`,
    noRunnableBlocked: (runId, tasks, count) =>
      `${runId} has no runnable task: ${tasks} ${count === 1 ? 'is' : 'are'} blocked.`,
    noRunnableFailed: (runId, tasks, count) =>
      `${runId} has no runnable task: ${tasks} ${count === 1 ? 'failed' : 'have failed'}.`,
    noRunnableInState: (runId, status) =>
      `${runId} has no runnable task in its current state (${status}).`,
    reviewEvidenceThenRetry: (taskId) =>
      `Review the task's evidence, then \`agent-flow retry ${taskId}\`.`,
    answerBlockedThenRetry: 'Answer what the blocked task reported, then retry it.',
    startNewOrCheckStatus:
      'Start a new run, or check `agent-flow status` for what this one is waiting on.',
    planRejected: (runId) => `The plan for ${runId} was rejected, so it will not be executed.`,
    revisePlanOrStartNew: 'Revise the plan and approve the result, or start a new run.',
    runHasNoPlan: (runId) => `${runId} has no plan yet.`,
    finishPlanningBeforeStarting: 'Finish planning before starting implementation.',
    planNotApproved: (runId) => `The plan for ${runId} has not been approved.`,
    reviewAndApproveBeforeStarting: 'Review and approve the current plan before starting.',
    approvalStale:
      'The plan changed after it was approved. Approval applies to a specific plan, ' +
      'not to the run.',
    readPlanApproveAgain: 'Read the current plan and approve it again.',
    runHasNoSdd: (runId, workflow) =>
      `${runId} has no SDD, which the ${workflow} workflow requires.`,
    rerunSddStage: 'Re-run the SDD stage before starting implementation.',
    noSuchTaskInPlan: (taskId, runId) => `No task ${taskId} in the plan for ${runId}.`,
    dependsOnUnmet: (taskId, unmet) => `${taskId} depends on ${unmet}, which has not completed.`,
    runInOrder: 'Run the plan in order, or run the dependencies first.',

    cancelledNothingToPause: (runId) =>
      `${runId} was cancelled, so there is nothing left to pause.`,
    startNewRunFeature: 'Start a new run with `agent-flow feature`.',
    finishedNothingToPause: (runId, status) =>
      `${runId} has finished (${status}), so there is nothing to pause.`,

    runNotPaused: (runId) => `${runId} is not paused.`,
    runItWithRun: 'Run it with `agent-flow run`.',
    stillExecuting: (runId, holder) => `${runId} is still executing${holder}.`,
    waitForBoundary: 'Wait for the paused run to reach its boundary, then resume.',

    finishedNothingToCancel: (runId, status) =>
      `${runId} has finished (${status}), so there is nothing to cancel.`,

    revisionNeedsInstruction: 'A revision needs an instruction saying what should change.',
    trivialNoRevision: 'TRIVIAL workflow does not support automated revision cycles (budget = 0).',
    approveAsIsOrStandard: 'Approve the plan as is, or start a new run with STANDARD workflow.',
    ceremonyBudget: (workflow, cycles) =>
      `STOP_AND_ASK_HUMAN: ${workflow} workflow reached its ceremony budget limit ` +
      `(${String(cycles)} revision cycle${cycles === 1 ? '' : 's'}). ` +
      'Unresolved findings require human approval or workflow elevation.',
    reviewResidualFindings:
      'Review residual findings in Approval dialog and approve over them, or start a new run with a higher workflow class.',

    featureNeedsDescription: 'A feature needs a description.',
    sayWhatFeatureDoes:
      'Say what the feature should do. A sentence is enough; a paragraph is better.',

    promptsMismatch:
      'The installed prompts do not match this build. Reinstall agent-flow, or run `agent-flow doctor`.',
    stageFailed: (stage, failureClass, errorCode, message) =>
      `Stage "${stage}" failed: ${failureClass} (${errorCode}). ${message}`,
    stagesBeforeKept: (stage, kept, rerun) =>
      (kept === '' ? 'Nothing before it is reused' : `Kept: ${kept}`) +
      (rerun === '' ? '' : `. Runs again: ${rerun}`) +
      `. Resume with: agent-flow feature "<same description>" --from ${stage}`,

    noPlanToReviewAgainst: (runId) => `${runId} has no plan to review against.`,
    finishPlanningBeforeReviewing: 'Finish planning before reviewing the implementation.',

    integrationTreeUnreadable: (runId, detail) =>
      `${runId} is an isolated run and its integration tree cannot be read: ${detail}.`,
    integrationBranchIsProduct:
      'The integration branch is the product of the run. Restore it, or start a new run.',

    notActiveRunAndNone: (runId) => `${runId} is not the active run, and this project has none.`,
    notActiveRunButIs: (runId, current) => `${runId} is not the active run — ${current} is.`,
    onlyActiveRun: 'Only the active run can be started or re-planned.',

    processWasExecuting: (holder) =>
      `A process was executing this run${holder}. ` +
      'It observes the cancellation and terminates its agents.',
    noActiveRun: 'There is no active run.',
    thisRunHasNoPlan: 'This run has no plan yet.',
    planNotReviewed: 'This plan has not been reviewed.',
    runReviewOrApproveOver: 'Run the review, or approve deliberately over it.',
    reviewJudgedAnother:
      'The plan review on file judged a different version of this plan. A verdict ' +
      'about another document is not a verdict about this one.',
    requestRevisionOrApprove:
      'Request a revision, or approve deliberately — which is recorded on the run.',
    reviewUnverifiable:
      'The plan review on file does not say which plan it judged, so nothing ' +
      'connects it to the plan in hand.',
    reviewFailedWith: (findings) => `The plan review returned FAIL with ${String(findings)} finding(s).`,
    requestRevisionAddressing:
      'Request a revision addressing them, or approve over the verdict deliberately.',
    alreadyApproved: 'This run is already approved.',
    planWasRejected:
      'This plan was rejected. Approving it now would leave the run recording both, ' +
      'and nothing would execute either way.',
    revisePlanOrApproveOver:
      'Revise the plan and approve the result — or approve over the rejection ' +
      'deliberately, which is recorded on the run.',
    approvalNotPossible: 'Approval is not possible in the current state.',
  },
  board: {
    completed: 'completed',
    unknownState: (state) => `state \`${state}\` is not one this build knows`,
    failed: (attempts) =>
      `failed${attempts > 1 ? ` after ${String(attempts)} attempts` : ''} — decide what to change, then requeue`,
    interruptedByStop: 'interrupted by a stopped run — resume to let recovery reconcile it',
    heldBackBy: (tasks) => `held back by ${tasks}`,
    heldByUpstreamFailure: 'held back by an upstream failure',
    agentReportedSdd: 'the agent reported the SDD does not answer something it needs',
    waitingForReviewDecision: 'waiting for a review decision',
    changesRequested: (blocking) =>
      `changes requested — ${String(blocking)} blocking ${blocking === 1 ? 'finding' : 'findings'}`,
    reviewMovedPast: 'the review describes a tree this task has moved past',
    inReviewRound: (round) => `in review, round ${String(round)}`,
    waitingToMerge: 'validated, waiting to be merged onto the integration branch',
    interruptedWillRequeue: 'interrupted — recovery will requeue it',
    running: (attempt, ownWorktree) =>
      `${attempt > 1 ? `attempt ${String(attempt)}` : 'running'}${ownWorktree ? ' in its own worktree' : ''}`,
    readyToStart: 'ready to start',
    waitingOn: (tasks) => `waiting on ${tasks}`,
    plannedNotReady: 'planned, not ready to start',
    everyEligibleAgent: 'every eligible agent',
    heldOneWave: (who) => `held one wave — ${who} at capacity`,
    anExclusiveArea: 'an exclusive area',
    ownershipConflict: (area, holder) => `ownership conflict on ${area}${holder}`,
    heldBy: (who) => `, held by ${who}`,
  },

  attention: {
    remoteDiverged: 'the remote branch moved under this run',
    inspectRemote: 'Inspect the remote',
    couldNotMerge: (task) => `${task} could not be merged`,
    conflictingPaths: (paths) => `conflicting paths: ${paths}`,
    integratedFirst: (task, paths) =>
      `${task} integrated first and moved the head; conflicting paths: ${paths}`,
    open: (task) => `Open ${task}`,
    heldByOwnership: (task) => `${task} is held by an ownership conflict`,
    reviewOwnership: 'Review the ownership areas',

    planWaiting: 'the plan is waiting for a decision',
    nothingRunsUntilGate: 'nothing runs until the gate opens',
    reviewThePlan: 'Review the plan',
    exhaustedRecovery: (task) => `${task} exhausted automatic recovery`,
    repairsTried: (failureClass, repairs) => `${failureClass}; ${String(repairs)} repair steps tried`,
    waitingForReview: (task) => `${task} is waiting for a review decision`,
    nothingAcceptedIt: 'the attempt finished and nothing has accepted or requeued it',
    reportedBlocked: (task) => `${task} reported it is blocked`,
    sddDoesNotAnswer:
      'the SDD does not answer something the task needs; recovery does not release this',
    readWhatAsked: (task) => `Read what ${task} asked`,

    taskFailed: (task) => `${task} failed`,
    attemptsNoneSatisfied: (attempts) =>
      `${String(attempts)} attempts, none of which satisfied the contract`,
    attemptDidNotSatisfy: 'the attempt did not satisfy the contract',
    requeue: (task) => `Requeue ${task}`,
    gateDidNotRun: (gate) => `required gate \`${gate}\` did not run`,
    gateFailed: (gate) => `required gate \`${gate}\` failed`,
    nothingRecordedResult:
      'nothing recorded a result for it, which blocks exactly as a failure does',
    exitCode: (code) => `exit ${code}`,
    openQualityGates: 'Open the quality gates',
    blockingFindings: (task, count) =>
      `${task} has ${String(count)} blocking ${count === 1 ? 'finding' : 'findings'}`,
    reviewRequestedChanges: 'the review requested changes',
    readTheFindings: 'Read the findings',
    remoteChecksFailed: (red) => `${String(red)} remote ${red === 1 ? 'check' : 'checks'} failed`,
    deliveryNotLocalQuality:
      'this is delivery, not local quality — the run’s own gates are unaffected',
    openTheDelivery: 'Open the delivery',
    deliveryFailed: 'delivery to the forge failed',
    runForgeSync: 'Run `agent-flow forge sync`',

    reviewMovedPast: 'the newest review describes a state this run has moved past',
    stageStartedAfter:
      'a stage started after it was written, so its verdict is about a different tree',
    openTheReview: 'Open the review',
    reviewOfIsStale: (task) => `the review of ${task} is stale`,
    namesATreeMovedPast: 'it names a tree the task has moved past, so its approval does not apply',
    openTheReviewThread: 'Open the review thread',
    operatorAskedToStop: 'an operator asked this run to stop',
    noNewTaskStarts: 'no new task starts until it is resumed; the task in flight runs to its end',
    resumeTheRun: 'Resume the run',
    readyAndNobodyTakes: (task) => `${task} is ready and nothing can take it`,
    everyMemberAtCapacity: 'every member whose skills match is at maxConcurrentTasks',
    openTheTeam: 'Open the team',
    runIsDegraded: (kind) => `this run is degraded: ${kind}`,
    reasonAndImpact: (reason, impact) => `${reason} — ${impact}`,
    finishedNothingPublished: 'this run has finished and nothing has been published',
    runForgePublish: 'Run `agent-flow forge publish`',
    checksPending: (pending) => `${String(pending)} remote checks have not reported`,
    checksAreObservation: 'remote checks are an observation and never a local verdict',
    openTheRunSummary: 'Open the run summary',
  },
  pairing: {
    title: 'Pair Device',
    description: 'Enter the pairing code printed in the server terminal to connect this device.',
    codeLabel: 'Pairing Code',
    deviceLabel: 'Device Name',
    pairButton: 'Pair Device',
    codeExpired: 'The pairing code has expired. Type `code` in the server terminal for a new one.',
    codeUsed: 'This pairing code has already been used.',
    codeBurned:
      'This pairing code has been burned after too many failed attempts. Type `code` in the server terminal for a new one.',
    codeUnknown: 'The pairing code is invalid.',
    limitReached:
      'The limit of 16 live device sessions has been reached. Revoke a session to pair a new device.',
    pairingDisabled: 'Remote device pairing is not enabled on this server.',
    restartWarning:
      'Restarting the server unpairs every device and invalidates any outstanding code.',
  },
  devices: {
    title: 'Connected Devices',
    description: 'Manage active device sessions. Revoking a session disconnects that device immediately.',
    noSessions: 'No remote devices are currently paired.',
    revoke: 'Revoke',
    revoked: 'Device session revoked',
    pairedAt: 'Paired at',
    lastSeenAt: 'Last seen',
    activeSessions: (count) =>
      `${String(count)} active device session${count === 1 ? '' : 's'}`,
  },
};
