/**
 * A run rich enough to test a composition.
 *
 * Layout is only wrong at the edges, and an empty run has no edges: every column
 * is a dash, the pipeline is nine identical pending chips, the donut has one
 * slice. Validating the design against that proves the components render, which
 * is what the previous milestone proved and why the layout drifted anyway.
 *
 * So this run has a stage in flight, a corrective task, four different models,
 * durations from seconds to minutes, a title long enough to test truncation and
 * a log long enough to fill the terminal.
 *
 * The clock is pinned by the test, so "Today at 19:34" is stable.
 */

import type {
  AnalyticsView,
  ApprovalGateView,
  ConfigView,
  ArtifactView,
  ProjectView,
  PromptContentView,
  PromptView,
  RoleRouteView,
  RunDagView,
  RunnerView,
  RunDetailView,
  RunSummaryView,
  RunnerHealthView,
  StageViewResponse,
  TaskDetailView,
  TaskSummaryView,
} from '@contracts/index.js';
import type { TelemetryResponse } from '../src/lib/api';

const RUN_ID = 'AF-2026-104';
const STARTED = '2026-08-10T19:34:00.000Z';

export const PROJECTS: ProjectView[] = [
  {
    id: 'beahub-api',
    name: 'beahub-api',
    path: '/Users/dev/wk/beahub-api',
    stack: 'node',
    currentRunId: RUN_ID,
    status: 'running',
    lastRun: {
      runId: 'AF-2026-103',
      feature: 'Adicionar cache de disponibilidade por profissional',
      status: 'completed',
      stage: 'final-review',
      updatedAt: '2026-08-09T15:30:00.000Z',
    },
    runCount: 12,
  },
  {
    id: 'beahub-web',
    name: 'beahub-web',
    path: '/Users/dev/wk/beahub-web',
    stack: 'node',
    currentRunId: 'AF-2026-097',
    status: 'completed',
    lastRun: {
      runId: 'AF-2026-097',
      feature: 'Migrar a listagem de profissionais para o novo endpoint',
      status: 'completed',
      stage: 'final-review',
      updatedAt: '2026-08-08T11:04:00.000Z',
    },
    runCount: 7,
  },
  {
    id: 'bflow',
    name: 'bflow',
    path: '/Users/dev/wk/bflow',
    stack: 'python',
    currentRunId: 'AF-2026-088',
    status: 'waiting_for_approval',
    lastRun: {
      runId: 'AF-2026-087',
      feature: 'Retry com backoff exponencial na fila de webhooks',
      status: 'failed',
      stage: 'implementation',
      updatedAt: '2026-08-07T18:22:00.000Z',
    },
    runCount: 4,
  },
  {
    // A project that has been initialised and never run. The row every list has
    // to render honestly, and the one a card layout makes look broken.
    id: 'company-project',
    name: 'company-project',
    path: '/Users/dev/wk/company-project',
    stack: 'go',
    currentRunId: null,
    status: null,
    runCount: 0,
  },
];

export const RUN: RunDetailView = {
  projectId: 'beahub-api',
  runId: RUN_ID,
  feature: 'Implementar Agendamentos Recorrentes com expansão semanal e limite de ocorrências',
  stage: 'implementation',
  status: 'running',
  approved: true,
  approvedAt: '2026-08-10T19:12:00.000Z',
  approvedPlanHash: 'a1b2c3d4e5f60718',
  createdAt: STARTED,
  updatedAt: '2026-08-10T20:15:22.000Z',
  taskCount: 9,
  // Three of the nine tasks below are completed, and `progress` is
  // round(3/9 × 100) — the only value the server can produce for this run. The
  // fixture used to say four and 78%, so the header, the task strip and the
  // execution summary contradicted each other in the reference screenshot.
  completedTasks: 3,
  degradations: 0,
  degradationDetail: [],
  progress: 33,
  startedAt: STARTED,
  durationMs: 2_482_000,
};

/** Six done, one in flight, two ahead — the shape the brief asks for. */
export const STAGES: StageViewResponse[] = [
  { stage: 'discovery', status: 'completed', runner: 'claude', model: 'Claude Opus', reasoning: 'high', durationMs: 133_000 },
  { stage: 'architecture-impact', status: 'completed', runner: 'claude', model: 'Claude Opus', reasoning: 'high', durationMs: 188_000 },
  { stage: 'sdd', status: 'completed', runner: 'claude', model: 'Claude Opus', reasoning: 'very_high', durationMs: 271_000 },
  { stage: 'planning', status: 'completed', runner: 'codex', model: 'GPT-5.6 Sol', reasoning: 'high', durationMs: 171_000 },
  { stage: 'plan-review', status: 'completed', runner: 'claude', model: 'Claude Opus', reasoning: 'high', durationMs: 94_000 },
  { stage: 'approval', status: 'completed', finishedAt: '2026-08-10T19:12:00.000Z' },
  { stage: 'implementation', status: 'running' },
  { stage: 'verification', status: 'pending' },
  { stage: 'final-review', status: 'pending' },
];

const task = (
  id: string,
  title: string,
  overrides: Partial<TaskSummaryView>,
): TaskSummaryView => ({
  id,
  title,
  complexity: 'normal',
  risk: 'low',
  state: 'queued',
  attempts: 0,
  requirements: ['FR-001'],
  dependencies: [],
  ...overrides,
});

/** The task the inspector opens. Named, so the detail below need not index. */
const RUNNING_TASK = task('TASK-003', 'Recurrence Repository', {
  state: 'running',
  attempts: 1,
  requirements: ['FR-002', 'FR-003'],
  dependencies: ['TASK-002'],
  runner: 'codex',
  model: 'GPT-5.6 Terra',
  reasoning: 'medium',
  durationMs: 222_000,
});

export const TASKS: TaskSummaryView[] = [
  task('TASK-001', 'Criar entidade Recurrence', {
    complexity: 'trivial',
    state: 'completed',
    attempts: 1,
    requirements: ['FR-001'],
    runner: 'codex',
    model: 'GPT-5.6 Terra',
    reasoning: 'medium',
    durationMs: 165_000,
    validationPassed: true,
  }),
  task('TASK-002', 'Migration de recurrence', {
    state: 'completed',
    attempts: 1,
    requirements: ['FR-002'],
    dependencies: ['TASK-001'],
    runner: 'codex',
    model: 'GPT-5.6 Terra',
    reasoning: 'medium',
    durationMs: 92_000,
    validationPassed: true,
  }),
  RUNNING_TASK,
  task('TASK-004', 'Recurrence Service', {
    complexity: 'complex',
    risk: 'high',
    state: 'running',
    attempts: 1,
    requirements: ['FR-003', 'FR-004'],
    dependencies: ['TASK-003'],
    runner: 'codex',
    model: 'GPT-5.6 Sol',
    reasoning: 'high',
    durationMs: 491_000,
  }),
  task('TASK-005', 'Gerar próximas ocorrências', {
    complexity: 'complex',
    risk: 'high',
    requirements: ['FR-004', 'FR-005'],
    dependencies: ['TASK-004'],
    runner: 'codex',
    model: 'GPT-5.6 Sol',
    reasoning: 'high',
  }),
  task('TASK-006', 'Validações de regras de recorrência', {
    requirements: ['FR-005'],
    dependencies: ['TASK-005'],
    runner: 'codex',
    model: 'GPT-5.6 Terra',
    reasoning: 'medium',
  }),
  task('TASK-007', 'API — criar recorrência', {
    requirements: ['FR-006'],
    dependencies: ['TASK-005'],
    runner: 'codex',
    model: 'GPT-5.6 Terra',
    reasoning: 'medium',
  }),
  task('TASK-008', 'API — listar recorrências', {
    requirements: ['FR-007'],
    dependencies: ['TASK-007'],
    runner: 'codex',
    model: 'GPT-5.6 Luna',
    reasoning: 'medium',
  }),
  // The one that exercises the corrective path: no requirement, because the
  // finding that produced it named none.
  task('FIX-001', 'Redact the token before logging the payload', {
    complexity: 'normal',
    risk: 'high',
    state: 'completed',
    attempts: 2,
    requirements: [],
    correctiveFor: { stage: 'final-review', findingType: 'security' },
    runner: 'claude',
    model: 'Claude Opus',
    reasoning: 'very_high',
    durationMs: 76_000,
    validationPassed: true,
  }),
];

/**
 * The graph the server would derive from the plan behind `TASKS` (UI-28).
 *
 * Written out rather than computed here: computing it would be a second
 * implementation of `describeRunGraph`, and a fixture that agrees with itself
 * proves nothing. `dag.spec.ts` checks these edges against the tasks' own
 * `dependencies`, so a fixture that drifts fails rather than draws.
 *
 * The shape is deliberate — a chain, a fan-out at TASK-005, a fan-in at
 * TASK-008, and a second root — because a straight line would prove nothing
 * about columns, rows or crossings.
 */
export const DAG: RunDagView = {
  runId: RUN_ID,
  projectId: 'beahub-api',
  nodes: [
    { taskId: 'TASK-001', depth: 0 },
    { taskId: 'FIX-001', depth: 0 },
    { taskId: 'TASK-002', depth: 1 },
    { taskId: 'TASK-003', depth: 2 },
    { taskId: 'TASK-004', depth: 3 },
    { taskId: 'TASK-005', depth: 4 },
    { taskId: 'TASK-006', depth: 5 },
    { taskId: 'TASK-007', depth: 5 },
    { taskId: 'TASK-008', depth: 6 },
  ],
  edges: [
    { from: 'TASK-001', to: 'TASK-002' },
    { from: 'TASK-002', to: 'TASK-003' },
    { from: 'TASK-003', to: 'TASK-004' },
    { from: 'TASK-004', to: 'TASK-005' },
    { from: 'TASK-005', to: 'TASK-006' },
    { from: 'TASK-005', to: 'TASK-007' },
    { from: 'TASK-007', to: 'TASK-008' },
  ],
  unresolved: [],
};

export const TASK_DETAIL: TaskDetailView = {
  ...RUNNING_TASK,
  description: 'Implementar repositório para recorrências, com expansão por janela.',
  acceptanceCriteria: [
    'findByAppointmentId retorna as ocorrências ordenadas.',
    'A janela de expansão respeita o limite configurado.',
  ],
  validation: ['test', 'lint'],
  validationExpectation: 'pass',
  files: ['src/recurrence/repository.ts'],
  filesChanged: [
    'src/recurrence/repository.ts',
    'src/recurrence/repository.test.ts',
    'src/recurrence/types.ts',
    'prisma/schema.prisma',
  ],
  notes: [],
  startedAt: '2026-08-10T19:56:42.000Z',
  finishedAt: '2026-08-10T20:00:24.000Z',
  reasoningClamped: false,
  commands: [
    {
      command: 'npm test -- recurrence',
      exitCode: 0,
      durationMs: 18_400,
      stdout: '18 passed, 0 failed',
      stderr: '',
    },
  ],
  log: [
    '[19:56:42] Task started',
    '[19:56:43] Analyzing codebase...',
    '[19:56:45] Reading recurrence entity...',
    '[19:56:48] Creating repository interface...',
    '[19:56:52] Implementing Prisma repository...',
    '[19:57:01] Adding methods: findById, findByAppointmentId, create, update, delete',
    '[19:59:02] Running tests...',
    '[19:59:12] All tests passed',
    '[19:59:14] Writing repository.test.ts',
    '[20:00:24] Task in progress...',
  ],
};

export const ARTIFACTS: ArtifactView[] = [
  { name: 'sdd', label: 'SDD', available: true, sizeBytes: 12_400, updatedAt: STARTED },
  { name: 'plan', label: 'Plan', available: true, sizeBytes: 8_100, updatedAt: STARTED },
  {
    name: 'architectureImpact',
    label: 'Architecture Impact',
    available: true,
    sizeBytes: 4_200,
    updatedAt: STARTED,
  },
  { name: 'planReview', label: 'Plan Review', available: true, sizeBytes: 1_900, updatedAt: STARTED },
  { name: 'verification', label: 'Verification', available: false },
  { name: 'finalReview', label: 'Final Review', available: false },
  { name: 'request', label: 'Request', available: true, sizeBytes: 220, updatedAt: STARTED },
];

const bucket = (count: number, durationMs: number, extra = {}) => ({
  count,
  durationMs,
  failures: 0,
  fallbacks: 0,
  retries: 0,
  ...extra,
});

export const TELEMETRY: TelemetryResponse = {
  entries: [],
  summary: {
    entries: 13,
    durationMs: 2_140_000,
    failures: 0,
    fallbacks: 1,
    retries: 2,
    reasoningClamped: 0,
    byRunner: {
      claude: bucket(7, 1_260_000),
      codex: bucket(6, 880_000, { fallbacks: 1, retries: 2 }),
    },
    byModel: {
      'GPT-5.6 Terra': bucket(7, 940_000, { retries: 2 }),
      'GPT-5.6 Sol': bucket(4, 620_000, { fallbacks: 1 }),
      'GPT-5.6 Luna': bucket(2, 310_000),
      'Claude Opus': bucket(1, 270_000),
    },
    byRole: {},
    byStage: {},
  },
};

export const RUNNER_HEALTH: RunnerHealthView[] = [
  { id: 'claude', installed: true, executable: true, auth: 'available', version: '2.1.226' },
  { id: 'codex', installed: true, executable: true, auth: 'available', version: '0.147.0' },
];

/**
 * History across every status the page can filter by, and two projects.
 *
 * An all-completed list is the one shape the Runs page cannot be wrong about:
 * every chip the same colour, every progress bar full, nothing degraded. The
 * statuses below are the ones the filter offers, so the screenshot shows what
 * each of them actually looks like — including a rejected plan, which is the only
 * row where a full-looking bar would be a lie.
 */
export const RUNS: RunSummaryView[] = [
  {
    projectId: 'beahub-api',
    runId: RUN_ID,
    feature: RUN.feature,
    stage: 'implementation',
    status: 'running',
    approved: true,
    createdAt: STARTED,
    updatedAt: RUN.updatedAt,
    taskCount: 9,
    completedTasks: 3,
    degradations: 0,
    progress: 33,
    durationMs: 2_482_000,
  },
  {
    projectId: 'beahub-api',
    runId: 'AF-2026-103',
    feature: 'Adicionar cache de disponibilidade por profissional',
    stage: 'final-review',
    status: 'completed',
    approved: true,
    createdAt: '2026-08-09T14:02:00.000Z',
    updatedAt: '2026-08-09T15:30:00.000Z',
    taskCount: 6,
    completedTasks: 6,
    degradations: 1,
    progress: 100,
    durationMs: 5_280_000,
  },
  {
    projectId: 'beahub-api',
    runId: 'AF-2026-102',
    feature: 'Recomendação de produtos na home do marketplace',
    stage: 'implementation',
    status: 'failed',
    approved: true,
    createdAt: '2026-08-08T09:15:00.000Z',
    updatedAt: '2026-08-08T10:41:00.000Z',
    taskCount: 8,
    completedTasks: 3,
    degradations: 2,
    progress: 38,
    durationMs: 5_160_000,
  },
  {
    projectId: 'bflow',
    runId: 'AF-2026-088',
    feature: 'Expor métricas de fila no endpoint de health',
    stage: 'plan-review',
    status: 'waiting_for_approval',
    approved: false,
    createdAt: '2026-08-08T08:00:00.000Z',
    updatedAt: '2026-08-08T08:26:00.000Z',
    taskCount: 5,
    completedTasks: 0,
    degradations: 0,
    progress: 0,
    durationMs: 1_560_000,
  },
  {
    projectId: 'bflow',
    runId: 'AF-2026-087',
    feature: 'Retry com backoff exponencial na fila de webhooks',
    stage: 'planning',
    status: 'plan_rejected',
    approved: false,
    createdAt: '2026-08-07T17:40:00.000Z',
    updatedAt: '2026-08-07T18:22:00.000Z',
    taskCount: 4,
    completedTasks: 0,
    degradations: 0,
    progress: 0,
    durationMs: 2_520_000,
  },
];


/**
 * The routing table (§82), with the three cases worth looking at.
 *
 * A run where every role resolves cleanly proves nothing about the layout: the
 * columns that matter are the ones that only appear when something is off. So one
 * role has its effort clamped, one points at a runner that does not exist, and the
 * fallbacks cover all three reasons a role can have none.
 */
export const AGENTS: RoleRouteView[] = [
  {
    role: 'architect',
    prompts: ['discovery', 'architecture-impact'],
    requiresReadOnly: true,
    requiresNativeStructuredOutput: false,
    configured: { runner: 'claude', model: 'Claude Opus', reasoning: 'high', timeoutSeconds: 900 },
    resolved: {
      runner: 'claude',
      model: 'Claude Opus',
      reasoning: 'high',
      reasoningClamped: false,
      structuredOutput: 'prompted',
    },
    fallback: {
      runner: 'codex',
      model: 'GPT-5.6 Sol',
      reasoning: 'high',
      reasoningClamped: false,
      structuredOutput: 'native',
    },
  },
  {
    role: 'sdd',
    prompts: ['sdd'],
    requiresReadOnly: true,
    requiresNativeStructuredOutput: false,
    configured: {
      runner: 'claude',
      model: 'Claude Opus',
      reasoning: 'very_high',
      timeoutSeconds: 1_200,
    },
    resolved: {
      runner: 'claude',
      model: 'Claude Opus',
      reasoning: 'high',
      reasoningClamped: true,
      structuredOutput: 'prompted',
    },
    fallbackAbsent: 'not_configured',
  },
  {
    role: 'planner',
    prompts: ['planning'],
    requiresReadOnly: true,
    requiresNativeStructuredOutput: true,
    configured: { runner: 'codex', model: 'GPT-5.6 Sol', reasoning: 'high', timeoutSeconds: 900 },
    resolved: {
      runner: 'codex',
      model: 'GPT-5.6 Sol',
      reasoning: 'high',
      reasoningClamped: false,
      structuredOutput: 'native',
    },
    fallback: {
      runner: 'claude',
      model: 'Claude Opus',
      reasoning: 'high',
      reasoningClamped: false,
      structuredOutput: 'prompted',
    },
  },
  {
    role: 'planReviewer',
    prompts: ['plan-review'],
    requiresReadOnly: true,
    requiresNativeStructuredOutput: false,
    configured: { runner: 'claude', model: 'Claude Opus', reasoning: 'high', timeoutSeconds: 900 },
    resolved: {
      runner: 'claude',
      model: 'Claude Opus',
      reasoning: 'high',
      reasoningClamped: false,
      structuredOutput: 'prompted',
    },
    fallbackAbsent: 'unusable',
  },
  {
    role: 'executor.trivial',
    prompts: ['implementation'],
    requiresReadOnly: false,
    requiresNativeStructuredOutput: false,
    configured: {
      runner: 'codex',
      model: 'GPT-5.6 Luna',
      reasoning: 'medium',
      timeoutSeconds: 600,
    },
    resolved: {
      runner: 'codex',
      model: 'GPT-5.6 Luna',
      reasoning: 'medium',
      reasoningClamped: false,
      structuredOutput: 'native',
    },
    fallbackAbsent: 'disabled',
  },
  {
    role: 'executor.normal',
    prompts: ['implementation'],
    requiresReadOnly: false,
    requiresNativeStructuredOutput: false,
    configured: {
      runner: 'codex',
      model: 'GPT-5.6 Terra',
      reasoning: 'medium',
      timeoutSeconds: 900,
    },
    resolved: {
      runner: 'codex',
      model: 'GPT-5.6 Terra',
      reasoning: 'medium',
      reasoningClamped: false,
      structuredOutput: 'native',
    },
    fallbackAbsent: 'disabled',
  },
  {
    role: 'executor.complex',
    prompts: ['implementation'],
    requiresReadOnly: false,
    requiresNativeStructuredOutput: false,
    configured: { runner: 'codex', model: 'GPT-5.6 Sol', reasoning: 'high', timeoutSeconds: 1_800 },
    resolved: {
      runner: 'codex',
      model: 'GPT-5.6 Sol',
      reasoning: 'high',
      reasoningClamped: false,
      structuredOutput: 'native',
    },
    fallbackAbsent: 'disabled',
  },
  {
    role: 'verification',
    prompts: ['verification'],
    requiresReadOnly: true,
    requiresNativeStructuredOutput: true,
    configured: { runner: 'nowhere', reasoning: 'high', timeoutSeconds: 900 },
    error: {
      kind: 'unknown_runner',
      message:
        'Role "verification" is configured to use runner "nowhere", which is not registered.',
    },
    fallbackAbsent: 'not_configured',
  },
  {
    role: 'finalReviewer',
    prompts: ['final-review'],
    requiresReadOnly: true,
    requiresNativeStructuredOutput: false,
    configured: { runner: 'claude', model: 'Claude Opus', reasoning: 'high', timeoutSeconds: 900 },
    resolved: {
      runner: 'claude',
      model: 'Claude Opus',
      reasoning: 'high',
      reasoningClamped: false,
      structuredOutput: 'prompted',
    },
    fallback: {
      runner: 'codex',
      model: 'GPT-5.6 Sol',
      reasoning: 'high',
      reasoningClamped: false,
      structuredOutput: 'native',
    },
  },
];

export const RUNNERS: RunnerView[] = [
  {
    id: 'claude',
    provider: 'claude-code-cli',
    reasoningLevels: ['low', 'medium', 'high'],
    structuredOutput: 'prompted',
  },
  {
    id: 'codex',
    provider: 'codex-cli',
    reasoningLevels: ['low', 'medium', 'high', 'very_high'],
    structuredOutput: 'native',
  },
];

const prompt = (
  name: string,
  overrides: Partial<PromptView>,
): PromptView => ({
  name,
  source: `prompts/${name}.md`,
  sizeBytes: 2_800,
  updatedAt: '2026-08-09T22:56:00.000Z',
  digest: 'a1b2c3d4e5f6',
  permissions: 'read-only',
  outputFormat: 'markdown',
  requiredVars: ['repositoryMap'],
  nativeStructuredOutput: false,
  roles: [],
  stages: [],
  ...overrides,
});

export const PROMPTS: PromptView[] = [
  prompt('architecture-impact', {
    digest: '3f1a9c02be71',
    roles: ['architect'],
    stages: ['architecture-impact'],
  }),
  prompt('discovery', { digest: '7c40e1b9aa02', roles: ['architect'], stages: ['discovery'] }),
  prompt('final-review', {
    digest: 'd91b0c4e7712',
    outputFormat: 'json',
    nativeStructuredOutput: true,
    requiredVars: ['sdd', 'plan', 'diff'],
    roles: ['finalReviewer'],
    stages: ['final-review'],
  }),
  prompt('implementation', {
    digest: '5b2ae90c1d38',
    sizeBytes: 3_005,
    permissions: 'write',
    outputFormat: 'json',
    requiredVars: ['task', 'sdd'],
    roles: ['executor.trivial', 'executor.normal', 'executor.complex'],
    stages: [],
  }),
  prompt('plan-review', {
    digest: 'ba71cc0e2f45',
    outputFormat: 'json',
    nativeStructuredOutput: true,
    requiredVars: ['sdd', 'plan'],
    roles: ['planReviewer'],
    stages: ['plan-review'],
  }),
  prompt('planning', {
    digest: '0f0e0d0c0b0a',
    sizeBytes: 5_040,
    outputFormat: 'json',
    nativeStructuredOutput: true,
    requiredVars: ['sdd', 'repositoryMap'],
    roles: ['planner'],
    stages: ['planning'],
  }),
  prompt('sdd', { digest: 'cc19ab7740de', roles: ['sdd'], stages: ['sdd'] }),
  prompt('verification', {
    digest: 'e2f0aa910c73',
    outputFormat: 'json',
    roles: ['verification'],
    stages: ['verification'],
  }),
];

export const PROMPT_CONTENT: PromptContentView = {
  ...(PROMPTS[0] as PromptView),
  content: [
    '# Architecture Impact',
    '',
    'You are given a repository map and a feature request. Report which components',
    'the change reaches, which contracts it crosses, and what it must not touch.',
    '',
    '## Repository',
    '',
    '{{repositoryMap}}',
    '',
    '## Rules',
    '',
    '- Name components that already exist. Do not propose new ones here.',
    '- A component is affected if its behaviour, its contract or its tests change.',
    '- Say what you could not determine. A gap named is cheaper than a gap guessed.',
  ].join('\n'),
  truncated: false,
};

/** Aggregates across a history rich enough for every bar to differ. */
export const ANALYTICS: AnalyticsView = {
  scope: { projectIds: ['beahub-api', 'bflow'], runsAvailable: 23, runsConsidered: 23, truncated: false },
  runsByProject: [
    { projectId: 'beahub-api', total: 16, byStatus: { completed: 11, failed: 3, running: 1, waiting_for_approval: 1 } },
    { projectId: 'bflow', total: 7, byStatus: { completed: 5, plan_rejected: 2 } },
  ],
  tasksByState: { completed: 118, failed: 9, queued: 14, blocked: 3, review_required: 2 },
  totals: {
    entries: 238,
    durationMs: 11_940_000,
    failures: 9,
    fallbacks: 4,
    retries: 13,
    reasoningClamped: 5,
  },
  byRunner: [
    { key: 'codex', count: 152, durationMs: 7_420_000, failures: 6, fallbacks: 4, retries: 10 },
    { key: 'claude', count: 86, durationMs: 4_520_000, failures: 3, fallbacks: 0, retries: 3 },
  ],
  byModel: [
    { key: 'GPT-5.6 Terra', count: 88, durationMs: 3_620_000, failures: 3, fallbacks: 1, retries: 6 },
    { key: 'Claude Opus', count: 86, durationMs: 4_520_000, failures: 3, fallbacks: 0, retries: 3 },
    { key: 'GPT-5.6 Sol', count: 46, durationMs: 2_980_000, failures: 3, fallbacks: 3, retries: 4 },
    { key: 'GPT-5.6 Luna', count: 18, durationMs: 820_000, failures: 0, fallbacks: 0, retries: 0 },
  ],
  byRole: [
    { key: 'executor.complex', count: 34, durationMs: 3_480_000, failures: 4, fallbacks: 2, retries: 7 },
    { key: 'executor.normal', count: 58, durationMs: 2_610_000, failures: 2, fallbacks: 1, retries: 3 },
    { key: 'architect', count: 46, durationMs: 2_040_000, failures: 0, fallbacks: 0, retries: 0 },
    { key: 'planner', count: 23, durationMs: 1_180_000, failures: 1, fallbacks: 1, retries: 2 },
    { key: 'executor.trivial', count: 22, durationMs: 520_000, failures: 0, fallbacks: 0, retries: 0 },
  ],
  byStage: [
    { key: 'discovery', count: 23, durationMs: 1_020_000, failures: 0, fallbacks: 0, retries: 0 },
    { key: 'architecture-impact', count: 23, durationMs: 1_240_000, failures: 0, fallbacks: 0, retries: 0 },
    { key: 'sdd', count: 23, durationMs: 2_180_000, failures: 0, fallbacks: 0, retries: 1 },
    { key: 'planning', count: 23, durationMs: 1_180_000, failures: 1, fallbacks: 1, retries: 2 },
    { key: 'plan-review', count: 21, durationMs: 640_000, failures: 0, fallbacks: 0, retries: 0 },
    { key: 'verification', count: 12, durationMs: 380_000, failures: 1, fallbacks: 0, retries: 0 },
    { key: 'final-review', count: 12, durationMs: 460_000, failures: 0, fallbacks: 0, retries: 0 },
  ],
};


/**
 * The gate, with a verdict worth looking at (§90).
 *
 * A PASS with no findings proves nothing about the modal: the parts that matter are
 * the findings list, the degradation warning and the two hashes side by side. So the
 * fixture is a FAIL whose review judged this exact plan — which is the case where
 * approving is possible and deliberate rather than impossible.
 */
export const APPROVAL_GATE: ApprovalGateView = {
  runId: RUN_ID,
  approved: false,
  canApprove: false,
  refusal: { kind: 'review_failed', forcible: true },
  warnings: [
    'the plan review was same-provider: it does not protect against an assumption repeated from planning',
  ],
  planHash: 'a1b2c3d4e5f60718',
  taskCount: 9,
  sddDigest: 'ff00aa11bb22',
  review: {
    verdict: 'FAIL',
    independence: 'same-provider-fresh-context',
    planHash: 'a1b2c3d4e5f60718',
    coversThisPlan: true,
    findings: [
      {
        severity: 'high',
        type: 'missing_test',
        description: 'TASK-005 changes the expansion window and declares no validation.',
        suggestedAction: 'Give it a validation id the project config declares.',
      },
      {
        severity: 'medium',
        type: 'task_too_large',
        description: 'TASK-004 covers the service and the scheduling rules at once.',
        suggestedAction: 'Split it so each half can fail on its own.',
        requirement: 'FR-004',
      },
    ],
  },
  degradations: [],
};

export const CONFIG: ConfigView = {
  sources: {
    globalPath: '/Users/dev/.agent-flow/config.yaml',
    globalPresent: true,
    projectPath: '/Users/dev/wk/beahub-api/.agent-flow/config.yaml',
    projectPresent: true,
  },
  sections: [
    {
      id: 'general',
      title: 'General',
      settings: [
        { key: 'version', label: 'Config version', value: '1', origin: 'default' },
        {
          key: 'sources.global',
          label: 'Global config',
          value: '/Users/dev/.agent-flow/config.yaml',
          origin: 'global',
        },
        {
          key: 'sources.project',
          label: 'Project config',
          value: '/Users/dev/wk/beahub-api/.agent-flow/config.yaml',
          origin: 'project',
        },
      ],
    },
    {
      id: 'workspace',
      title: 'Workspace',
      settings: [
        { key: 'project.name', label: 'Project name', value: 'beahub-api', origin: 'project' },
        { key: 'project.type', label: 'Detected stack', value: 'node', origin: 'project' },
        { key: 'paths.source', label: 'Source paths', value: 'src', origin: 'project' },
        { key: 'paths.tests', label: 'Test paths', value: 'test', origin: 'project' },
        {
          key: 'rules.architecture',
          label: 'Architecture rules',
          value: '3 declared',
          origin: 'project',
        },
      ],
    },
    {
      id: 'runners',
      title: 'Runners',
      settings: [
        { key: 'runners.claude', label: 'claude', value: 'claude-code-cli · enabled', origin: 'default' },
        { key: 'runners.codex', label: 'codex', value: 'codex-cli · enabled', origin: 'global' },
      ],
    },
    {
      id: 'models',
      title: 'Models',
      note: 'Role routing has its own page, which resolves each role against what its runner can actually do.',
      settings: [],
    },
    {
      id: 'execution',
      title: 'Execution',
      settings: [
        {
          key: 'approval.requiredBeforeImplementation',
          label: 'Approval before implementation',
          value: 'required',
          origin: 'default',
        },
        { key: 'parallelism.maxTasks', label: 'Parallel tasks', value: '1', origin: 'default' },
        { key: 'retry.maxAttempts', label: 'Attempts per task', value: '3', origin: 'project' },
        { key: 'git.useWorktrees', label: 'Git worktrees', value: 'off', origin: 'default' },
        { key: 'fallback.enabled', label: 'Fallback', value: 'enabled', origin: 'global' },
        {
          key: 'fallback.on',
          label: 'Fallback triggers',
          value: 'runner_unavailable, auth_required, quota_exceeded',
          origin: 'default',
          note: 'infrastructure failures only — a capability gap is never routed around',
        },
        {
          key: 'validationCommands',
          label: 'Extra validation commands',
          value: '2 declared',
          origin: 'project',
          note: 'a plan names one of these by id; nothing a model writes reaches a shell',
        },
      ],
    },
    {
      id: 'ui',
      title: 'UI',
      note: 'Everything else the dashboard remembers — filters, tabs, which task is open — lives in the browser.',
      settings: [
        {
          key: 'ui.workspaceDepth',
          label: 'Workspace scan depth',
          value: '2',
          origin: 'default',
          note: 'how far under a workspace root `agent-flow ui ~/wk` looks for projects; a directory beyond it is not discovered and not served',
        },
      ],
    },
    {
      id: 'retention',
      title: 'Retention',
      note: 'Run history is pruned on request rather than on a policy: agent-flow clean --keep <n>. There is no retention setting to read.',
      settings: [],
    },
  ],
};

/** Path → body. The visual tests answer every call the dashboard makes. */
export const ROUTES: Record<string, unknown> = {
  '/api/v1/health': { status: 'ok', version: '0.1.0', projects: 4, host: '127.0.0.1', port: 4782 },
  '/api/v1/projects': PROJECTS,
  '/api/v1/runs': RUNS,
  '/api/v1/runners/health': RUNNER_HEALTH,
  [`/api/v1/runs/${RUN_ID}`]: RUN,
  [`/api/v1/runs/${RUN_ID}/stages`]: STAGES,
  [`/api/v1/runs/${RUN_ID}/tasks`]: TASKS,
  [`/api/v1/runs/${RUN_ID}/dag`]: DAG,
  [`/api/v1/runs/${RUN_ID}/tasks/TASK-003`]: TASK_DETAIL,
  [`/api/v1/runs/${RUN_ID}/artifacts`]: ARTIFACTS,
  [`/api/v1/runs/${RUN_ID}/telemetry`]: TELEMETRY,
  '/api/v1/runners': RUNNERS,
  '/api/v1/agents': AGENTS,
  '/api/v1/prompts': PROMPTS,
  '/api/v1/prompts/architecture-impact': PROMPT_CONTENT,
  '/api/v1/analytics': ANALYTICS,
  '/api/v1/config': CONFIG,
  [`/api/v1/runs/${RUN_ID}/approval`]: APPROVAL_GATE,
  // Nothing in flight, which is the state the buttons are drawn for.
  [`/api/v1/runs/${RUN_ID}/job`]: null,
};

export const FIXTURE_RUN_ID = RUN_ID;
/** Matches the pinned clock, so "Today at …" is stable across days. */
export const FIXTURE_NOW = new Date('2026-08-10T20:15:22.000Z');
