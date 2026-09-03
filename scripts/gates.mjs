/**
 * What has to be green before this repository can be delivered — declared once.
 *
 * M7 closed with `test:packaging` red for an entire milestone. Nothing was broken about
 * the check: CI ran it, CI blocked on it, and CI said so. What failed is that the list of
 * gates a milestone runs and the list of gates CI blocks on were **two hand-kept lists**,
 * living in `package.json`, `.github/workflows/*.yml`, `README.md`, `docs/testing.md` and
 * a prompt. Five copies of one contract is five chances to disagree, and they did — so
 * "green" had two meanings and only one of them was checked before calling the work done.
 *
 * This module is the one copy. Everything else derives from it:
 *
 *   scripts/gate.mjs        runs a lane, and says what it did *not* run
 *   package.json            `gate:*` and `verify` are thin wrappers over that
 *   .github/workflows       every blocking job invokes `npm run gate:<lane>`
 *   test/gates.test.ts      fails if any of the above drifts from this file
 *
 * **This is not the M6 validation registry.** That one answers "did the feature this run
 * implemented pass its quality gates" — it is about somebody else's code, evaluated
 * inside a run, and it lives in `src/core/validation-registry.ts` where the product can
 * reach it. This file answers "may Agent Flow itself ship", it is about *this* checkout,
 * and nothing in `src/` imports it. Two questions, two registries, and conflating them
 * would put a repository's CI contract inside the product's runtime.
 */

/**
 * A lane is one CI job's executable contract.
 *
 * `cost` orders `verify`: cheapest first, so a broken type is reported in four seconds
 * rather than after eight minutes of Playwright. It is a rank, not a measurement, and it
 * exists here rather than in the runner because a second ordered list of lanes living
 * next to this one is the exact shape of the defect this file was written to remove.
 *
 * The split is by *environment*, not by taste: `node` needs nothing but Node, `browser`
 * and `visual` need a Playwright container, `packaging` needs a clean install outside the
 * checkout, `security` needs GitHub for two of its four gates. CI is allowed to run the
 * same lane on several Node versions — that is one contract in two environments, which is
 * the point of naming the lane rather than the commands.
 */
export const LANES = [
  {
    id: 'node',
    script: 'gate:node',
    cost: 1,
    summary: 'Types, lint, unit and integration suites, both builds',
    workflow: 'ci.yml',
    /** The matrix job. Two Node versions, one lane. */
    jobs: ['check'],
  },
  {
    id: 'browser',
    script: 'gate:browser',
    cost: 4,
    summary: 'Playwright E2E through the real local server',
    workflow: 'ci.yml',
    jobs: ['e2e'],
  },
  {
    id: 'visual',
    script: 'gate:visual',
    cost: 5,
    summary: 'Screenshot regression against this platform’s baselines',
    workflow: 'ci.yml',
    jobs: ['visual'],
  },
  {
    id: 'packaging',
    script: 'gate:packaging',
    cost: 3,
    summary: 'Pack, install elsewhere, drive the installed product',
    workflow: 'ci.yml',
    jobs: ['packaging'],
  },
  {
    id: 'security',
    script: 'gate:security',
    cost: 2,
    summary: 'Dependency advisories, secrets over history, static analysis',
    workflow: 'security.yml',
    jobs: ['dependencies', 'secrets', 'codeql'],
  },
  {
    id: 'coverage',
    script: 'gate:coverage',
    cost: 6,
    summary: 'Coverage thresholds — a report, deliberately not a gate',
    workflow: 'ci.yml',
    jobs: ['coverage'],
  },
];

/**
 * What a gate's result is worth, which is the distinction M7 did not have.
 *
 *   required-local    a person can run it, and must see it green before calling work done
 *   required-ci       blocking, and only GitHub can produce the evidence
 *   required-release  blocking before publishing, not before committing
 *   report-only       runs every time, never blocks, stays visible
 *
 * §7 of the M8 brief lists a fourth class, `scheduled`. It is modelled here as
 * `recurrence` instead, and the reason is that scheduling and blocking are independent:
 * the secret scan runs weekly *and* blocks on every push, and collapsing the two would
 * have to call it one or the other. A gate that reruns on a cron is still either
 * authoritative or not, and this file has to be able to say which.
 */
export const POLICIES = ['required-local', 'required-ci', 'required-release', 'report-only'];

/** How often a gate's answer is refreshed. */
export const RECURRENCES = ['per-change', 'per-change-and-weekly', 'per-release'];

/**
 * Commands a lane runs that are not gates: getting the checkout into a runnable state.
 *
 * Listed so the drift test can tell "CI runs a command this file does not know about"
 * from "CI installs dependencies". Anything not here and not `npm run gate:<lane>` is a
 * second gate list forming, which is the failure this whole file exists to prevent.
 */
export const INFRASTRUCTURE = ['npm ci'];

/**
 * Every gate, and what its result is worth.
 *
 * `needs` names gates from this same list that must run first — the packaging smoke drives
 * a tarball, so it needs both builds, and saying so here keeps the ordering canonical
 * rather than repeated in a workflow file.
 *
 * `ciEnv` is the environment a lane needs *in CI only*. It lives here rather than in the
 * workflow for one measured reason: `AF_VISUAL_BROWSER=chromium` on macOS invalidates
 * every darwin baseline at once, because the darwin set was captured with real Chrome and
 * the bundled Chromium rasterises type differently. A developer who copied the env line
 * out of the workflow to "run it like CI does" would get forty screenshot failures on
 * pages they never touched. So the workflow says nothing, and `gate.mjs --ci` applies it.
 */
export const GATES = [
  // ── node ───────────────────────────────────────────────────────────────────────
  {
    id: 'typecheck',
    lane: 'node',
    policy: 'required-local',
    recurrence: 'per-change',
    command: 'npm run typecheck',
    why: 'The CLI, the core, the services and the server, under `strict`.',
  },
  {
    id: 'typecheck:web',
    lane: 'node',
    policy: 'required-local',
    recurrence: 'per-change',
    command: 'npm run typecheck:web',
    why: 'The dashboard is a separate workspace with its own compiler settings. It was absent from CI’s check job until M8, so a type error in browser code only surfaced when somebody ran `agent-flow ui`.',
  },
  {
    id: 'typecheck:e2e',
    lane: 'node',
    policy: 'required-local',
    recurrence: 'per-change',
    command: 'npm run typecheck:e2e',
    why: 'Playwright specs compile under their own tsconfig. Also absent from CI until M8.',
  },
  {
    id: 'lint',
    lane: 'node',
    policy: 'required-local',
    recurrence: 'per-change',
    command: 'npm run lint',
    why: 'Source, tests, bin and the dashboard.',
  },
  {
    id: 'test',
    lane: 'node',
    policy: 'required-local',
    recurrence: 'per-change',
    command: 'npm run test',
    why: 'Unit, integration against real Git, and the architecture rules.',
  },
  {
    id: 'test:web',
    lane: 'node',
    policy: 'required-local',
    recurrence: 'per-change',
    command: 'npm run test:web',
    why: 'The dashboard’s components, in jsdom.',
  },
  {
    id: 'build',
    lane: 'node',
    policy: 'required-local',
    recurrence: 'per-change',
    command: 'npm run build',
    why: 'The CLI ships as a build artifact, so a green suite over source proves less than it looks.',
  },
  {
    id: 'build:web',
    lane: 'node',
    policy: 'required-local',
    recurrence: 'per-change',
    command: 'npm run build:web',
    why: 'The dashboard ships as a bundle, and the server serves that bundle.',
  },

  // ── browser ────────────────────────────────────────────────────────────────────
  {
    id: 'test:e2e',
    lane: 'browser',
    policy: 'required-local',
    recurrence: 'per-change',
    command: 'npm run test:e2e',
    ciEnv: { AF_E2E_CHANNEL: 'chromium' },
    why: 'Browser → Fastify → services → StateStore → disk, stubbing nothing but the coding CLI.',
  },

  // ── visual ─────────────────────────────────────────────────────────────────────
  {
    id: 'test:visual',
    lane: 'visual',
    policy: 'required-local',
    recurrence: 'per-change',
    command: 'npm run test:visual',
    ciEnv: { AF_VISUAL_BROWSER: 'chromium' },
    why: 'Screenshot regression. Baselines are per-platform; a developer runs the darwin set and CI runs the linux set, from the same command.',
  },

  // ── packaging ──────────────────────────────────────────────────────────────────
  {
    id: 'test:packaging',
    lane: 'packaging',
    policy: 'required-local',
    recurrence: 'per-change',
    command: 'npm run test:packaging',
    needs: ['build', 'build:web'],
    why: 'The one gate that was red for a whole milestone. It answers a question no suite inside the checkout can: does the *tarball* work, with the source tree hidden.',
  },
  {
    id: 'test:packaging:browser',
    lane: 'packaging',
    policy: 'required-release',
    recurrence: 'per-release',
    command: 'npm run test:packaging:browser',
    needs: ['build', 'build:web'],
    why: 'The same tarball, driven by a browser that knows nothing about this codebase. Local rather than CI on purpose — gsd-browser is a pinned native binary with no published checksum, and CI already has a deterministic browser gate.',
  },

  // ── security ───────────────────────────────────────────────────────────────────
  {
    id: 'audit:runtime',
    lane: 'security',
    policy: 'required-local',
    recurrence: 'per-change-and-weekly',
    command: 'npm audit --omit=dev --audit-level=high',
    why: 'What ships is `dependencies`. An advisory here is an advisory in somebody’s install. Runnable on a laptop, so there is no excuse for a person not to have seen it.',
  },
  {
    id: 'audit:toolchain',
    lane: 'security',
    policy: 'report-only',
    recurrence: 'per-change-and-weekly',
    command: 'npm audit --audit-level=high',
    why: 'vitest and vite carry advisories about dev servers nobody runs from a published package. Fixing them needs major upgrades that belong in their own reviewed change — so this reports, every time, and never blocks.',
  },
  {
    id: 'secrets',
    lane: 'security',
    policy: 'required-ci',
    recurrence: 'per-change-and-weekly',
    action: 'gitleaks/gitleaks-action',
    why: 'Over history, not the working tree, so it needs the full clone GitHub gives it. A credential deleted in the next commit is still published.',
  },
  {
    id: 'codeql',
    lane: 'security',
    policy: 'required-ci',
    recurrence: 'per-change',
    action: 'github/codeql-action/analyze',
    why: 'Injection and path-traversal queries against a codebase that spawns processes on an agent’s behalf. GitHub-hosted; a Mac cannot produce this evidence and must not report it as passing.',
  },

  // ── coverage ───────────────────────────────────────────────────────────────────
  {
    id: 'test:coverage',
    lane: 'coverage',
    policy: 'report-only',
    recurrence: 'per-change',
    command: 'npm run test:coverage',
    why: 'A drop is worth seeing without failing a change over a number. `src/core/**` still carries thresholds inside the suite itself.',
  },
];

/** The one command a person runs to see everything that is locally required. */
export const VERIFY_SCRIPT = 'verify';
/** The same, plus what must be green before publishing. */
export const VERIFY_RELEASE_SCRIPT = 'verify:release';

export const laneById = (id) => LANES.find((lane) => lane.id === id);
export const gatesInLane = (id) => GATES.filter((gate) => gate.lane === id);

/** Lanes holding at least one gate of the given policy. */
export function lanesWithPolicy(policy) {
  return LANES.filter((lane) => gatesInLane(lane.id).some((gate) => gate.policy === policy));
}

/**
 * The lanes `verify` must cover: everything a person is expected to have seen.
 *
 * Derived rather than listed, so adding a `required-local` gate to a lane nobody verifies
 * is not a thing this repository can do quietly.
 */
export function requiredLocalLanes() {
  return lanesWithPolicy('required-local');
}

export function requiredReleaseLanes() {
  return lanesWithPolicy('required-release');
}

/** The lanes `verify` runs, cheapest first. Derived, never listed. */
export function verifyOrder() {
  return [...requiredLocalLanes()].sort((a, b) => a.cost - b.cost).map((lane) => lane.id);
}
