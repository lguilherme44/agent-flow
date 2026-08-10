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

const RUN_ID = 'AF-2026-104';
const STARTED = '2026-08-10T19:34:00.000Z';

export const PROJECTS = [
  {
    id: 'beahub-api',
    name: 'beahub-api',
    path: '/Users/dev/wk/beahub-api',
    stack: 'node',
    currentRunId: RUN_ID,
    status: 'running',
  },
  {
    id: 'beahub-web',
    name: 'beahub-web',
    path: '/Users/dev/wk/beahub-web',
    stack: 'node',
    currentRunId: 'AF-2026-097',
    status: 'completed',
  },
  {
    id: 'bflow',
    name: 'bflow',
    path: '/Users/dev/wk/bflow',
    stack: 'python',
    currentRunId: 'AF-2026-088',
    status: 'waiting_for_approval',
  },
  {
    id: 'company-project',
    name: 'company-project',
    path: '/Users/dev/wk/company-project',
    stack: 'go',
    currentRunId: null,
    status: null,
  },
];

export const RUN = {
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
  completedTasks: 4,
  degradations: 0,
  degradationDetail: [],
  progress: 78,
  startedAt: STARTED,
  durationMs: 2_482_000,
};

/** Six done, one in flight, two ahead — the shape the brief asks for. */
export const STAGES = [
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
  overrides: Record<string, unknown>,
): Record<string, unknown> => ({
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

export const TASKS = [
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
  task('TASK-003', 'Recurrence Repository', {
    state: 'running',
    attempts: 1,
    requirements: ['FR-002', 'FR-003'],
    dependencies: ['TASK-002'],
    runner: 'codex',
    model: 'GPT-5.6 Terra',
    reasoning: 'medium',
    durationMs: 222_000,
  }),
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

export const TASK_DETAIL = {
  ...TASKS[2],
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

export const ARTIFACTS = [
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

export const TELEMETRY = {
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

export const RUNNER_HEALTH = [
  { id: 'claude', installed: true, executable: true, auth: 'available', version: '2.1.226' },
  { id: 'codex', installed: true, executable: true, auth: 'available', version: '0.147.0' },
];

export const RUNS = [
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
    completedTasks: 4,
    degradations: 0,
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
  },
];

/** Path → body. The visual tests answer every call the dashboard makes. */
export const ROUTES: Record<string, unknown> = {
  '/api/v1/health': { status: 'ok', version: '0.1.0', projects: 4, host: '127.0.0.1', port: 4782 },
  '/api/v1/projects': PROJECTS,
  '/api/v1/runs': RUNS,
  '/api/v1/runners/health': RUNNER_HEALTH,
  [`/api/v1/runs/${RUN_ID}`]: RUN,
  [`/api/v1/runs/${RUN_ID}/stages`]: STAGES,
  [`/api/v1/runs/${RUN_ID}/tasks`]: TASKS,
  [`/api/v1/runs/${RUN_ID}/tasks/TASK-003`]: TASK_DETAIL,
  [`/api/v1/runs/${RUN_ID}/artifacts`]: ARTIFACTS,
  [`/api/v1/runs/${RUN_ID}/telemetry`]: TELEMETRY,
};

export const FIXTURE_RUN_ID = RUN_ID;
/** Matches the pinned clock, so "Today at …" is stable across days. */
export const FIXTURE_NOW = new Date('2026-08-10T20:15:22.000Z');
