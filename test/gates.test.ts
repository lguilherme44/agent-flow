import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * One definition of "green", as an executable rule (M8 Phase A).
 *
 * M7 closed with `test:packaging` red for a whole milestone. CI ran it, CI blocked on it,
 * and CI said so on every push — and the local Definition of Done never asked, because
 * "the gates" existed as five hand-kept lists: `package.json`, two workflow files, the
 * README and `docs/testing.md`. Five copies of one contract is five chances to disagree,
 * and the disagreement was invisible in both directions: CI also ran neither
 * `typecheck:web` nor `typecheck:e2e`, which the local `check` did.
 *
 * `scripts/gates.mjs` is now the only copy. This file is what stops it becoming the sixth:
 * every rule below compares the manifest against something that would otherwise drift
 * away from it, and `checkGateDrift` is a pure function precisely so the last two tests
 * can prove the rules *fire* — a contract test that has never been seen to fail is a
 * contract test nobody has evidence for.
 */

const ROOT = join(import.meta.dirname, '..');

const LaneSchema = z.object({
  id: z.string().min(1),
  script: z.string().min(1),
  cost: z.number().int().positive(),
  summary: z.string().min(1),
  workflow: z.string().min(1),
  jobs: z.array(z.string().min(1)).min(1),
});

const GateSchema = z.object({
  id: z.string().min(1),
  lane: z.string().min(1),
  policy: z.enum(['required-local', 'required-ci', 'required-release', 'report-only']),
  recurrence: z.enum(['per-change', 'per-change-and-weekly', 'per-release']),
  command: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  needs: z.array(z.string().min(1)).optional(),
  ciEnv: z.record(z.string(), z.string()).optional(),
  why: z.string().min(1),
});

const ManifestSchema = z.object({
  lanes: z.array(LaneSchema).min(1),
  gates: z.array(GateSchema).min(1),
  infrastructure: z.array(z.string().min(1)),
});

type Manifest = z.infer<typeof ManifestSchema>;
type Gate = z.infer<typeof GateSchema>;

interface Step {
  readonly run?: string;
  readonly uses?: string;
}
interface Job {
  readonly steps?: readonly Step[];
}
/** Workflow files, by filename, already parsed. */
type Workflows = Record<string, { readonly jobs?: Record<string, Job> }>;

interface DriftInput {
  readonly manifest: Manifest;
  readonly workflows: Workflows;
  readonly scripts: Readonly<Record<string, string>>;
}

/**
 * Every way the manifest and the things derived from it can disagree.
 *
 * Returns violations rather than throwing, so a mutation test can assert *which* rule
 * caught a planted defect instead of only that something did.
 */
function checkGateDrift(input: DriftInput): string[] {
  const { manifest, workflows, scripts } = input;
  const violations: string[] = [];

  const laneById = new Map(manifest.lanes.map((lane) => [lane.id, lane]));
  const gatesInLane = (id: string): Gate[] => manifest.gates.filter((gate) => gate.lane === id);

  /** `npm run gate:node`, with or without a trailing `-- --ci`. */
  const laneInvocation = (command: string): string | undefined => {
    const match = /^npm run ([\w:-]+)(?: -- [\w -]+)?$/.exec(command.trim());
    const script = match?.[1];
    if (script === undefined) return undefined;
    return manifest.lanes.find((lane) => lane.script === script)?.id;
  };

  const stepsOf = (file: string, job: string): Step[] => [
    ...(workflows[file]?.jobs?.[job]?.steps ?? []),
  ];

  // ── R1 ─ every blocking command CI runs is one of this manifest's lanes ─────────
  //
  // The rule that would have caught the M7 gap from the CI side: a `run:` line naming a
  // command directly is a second gate list forming, however correct that command is.
  for (const [file, workflow] of Object.entries(workflows)) {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (step.run === undefined) continue;
        const command = step.run.trim();
        if (manifest.infrastructure.includes(command)) continue;
        if (laneInvocation(command) !== undefined) continue;
        violations.push(
          `R1 ${file}#${jobName} runs \`${command}\`, which is not a canonical lane`,
        );
      }
    }
  }

  // ── R2 ─ every lane the manifest claims CI runs, CI actually runs ──────────────
  for (const lane of manifest.lanes) {
    const invoked = lane.jobs.some((job) =>
      stepsOf(lane.workflow, job).some(
        (step) => step.run !== undefined && laneInvocation(step.run) === lane.id,
      ),
    );
    for (const job of lane.jobs) {
      if (workflows[lane.workflow]?.jobs?.[job] === undefined) {
        violations.push(`R2 lane \`${lane.id}\` names ${lane.workflow}#${job}, which does not exist`);
      }
    }
    if (!invoked) {
      violations.push(`R2 no job in ${lane.workflow} invokes \`npm run ${lane.script}\``);
    }
  }

  // ── R3 ─ every required gate sits in a lane CI runs ────────────────────────────
  //
  // A `required-local` gate in a lane no workflow names is a gate that blocks a person and
  // never blocks a merge, which is the M7 shape with the roles swapped.
  for (const gate of manifest.gates) {
    if (gate.policy === 'report-only') continue;
    const lane = laneById.get(gate.lane);
    if (lane === undefined) {
      violations.push(`R3 gate \`${gate.id}\` is in lane \`${gate.lane}\`, which does not exist`);
      continue;
    }
    if (gate.policy === 'required-release') continue;
    const reachable = lane.jobs.some(
      (job) => workflows[lane.workflow]?.jobs?.[job] !== undefined,
    );
    if (!reachable) {
      violations.push(`R3 required gate \`${gate.id}\` is in a lane no workflow job runs`);
    }
  }

  // ── R4 ─ GitHub-only evidence is actually wired to GitHub ──────────────────────
  //
  // `codeql` and `secrets` have no command a laptop can run. The only thing that makes
  // them real is a `uses:` in a workflow, so the manifest declaring them `required-ci` has
  // to be checkable against that and not taken on trust.
  for (const gate of manifest.gates) {
    if (gate.action === undefined) continue;
    const lane = laneById.get(gate.lane);
    if (lane === undefined) continue;
    const present = lane.jobs.some((job) =>
      stepsOf(lane.workflow, job).some((step) => step.uses?.startsWith(gate.action as string) === true),
    );
    if (!present) {
      violations.push(`R4 \`${gate.id}\` declares \`${gate.action}\`, which no job in ${lane.workflow} uses`);
    }
  }

  // ── R5 ─ `verify` is the single local entry point, and covers everything ───────
  for (const [name, expected] of [
    ['verify', 'node scripts/gate.mjs verify'],
    ['verify:release', 'node scripts/gate.mjs verify --release'],
  ] as const) {
    if (scripts[name] !== expected) {
      violations.push(`R5 \`${name}\` is \`${scripts[name] ?? '(absent)'}\`, expected \`${expected}\``);
    }
  }

  // ── R6 ─ packaging remains required (M8-A17) ──────────────────────────────────
  //
  // Named rather than derived, because the generic rules above would all still pass with
  // this gate downgraded to `report-only` — and that downgrade is exactly what a hurried
  // person does when the tarball smoke is the thing standing between them and a merge.
  // The milestone it was red for is the argument.
  const packaging = manifest.gates.find((gate) => gate.id === 'test:packaging');
  if (packaging === undefined) {
    violations.push('R6 `test:packaging` is not in the manifest');
  } else if (packaging.policy !== 'required-local') {
    violations.push(`R6 \`test:packaging\` is \`${packaging.policy}\`, and must be required-local`);
  }

  // ── R7 ─ every lane has a package script, and it runs that lane ────────────────
  for (const lane of manifest.lanes) {
    const expected = `node scripts/gate.mjs ${lane.id}`;
    if (scripts[lane.script] !== expected) {
      violations.push(
        `R7 \`${lane.script}\` is \`${scripts[lane.script] ?? '(absent)'}\`, expected \`${expected}\``,
      );
    }
    if (gatesInLane(lane.id).length === 0) {
      violations.push(`R7 lane \`${lane.id}\` has no gates`);
    }
  }

  // ── R8 ─ every command a gate runs is a script that exists ─────────────────────
  //
  // Renaming an npm script and leaving the manifest pointing at the old name produces a
  // lane that fails for a reason nobody can read. `npm audit` is not a script and is
  // checked only for shape.
  for (const gate of manifest.gates) {
    const match = /^npm run ([\w:-]+)$/.exec(gate.command ?? '');
    const script = match?.[1];
    if (script !== undefined && scripts[script] === undefined) {
      violations.push(`R8 gate \`${gate.id}\` runs \`npm run ${script}\`, which package.json does not define`);
    }
    for (const need of gate.needs ?? []) {
      if (!manifest.gates.some((candidate) => candidate.id === need)) {
        violations.push(`R8 gate \`${gate.id}\` needs \`${need}\`, which the manifest does not declare`);
      }
    }
  }

  return violations;
}

// ─────────────────────────────────────────────────────────────────────────────────

/**
 * Imported through a URL rather than a literal specifier.
 *
 * `scripts/` is plain ESM with no declaration file, and a literal `import` of it would be
 * a TS7016 under `strict`. A dynamic import of a computed specifier is typed `any`, and
 * everything crossing that boundary is parsed by `ManifestSchema` immediately below — so
 * nothing untyped survives past this line.
 */
async function loadManifest(): Promise<Manifest> {
  const specifier = new URL('../scripts/gates.mjs', import.meta.url).href;
  const module: unknown = await import(specifier);
  const { GATES, LANES, INFRASTRUCTURE } = module as Record<string, unknown>;
  return ManifestSchema.parse({ lanes: LANES, gates: GATES, infrastructure: INFRASTRUCTURE });
}

function loadWorkflows(): Workflows {
  const workflows: Workflows = {};
  for (const file of ['ci.yml', 'security.yml']) {
    workflows[file] = parse(readFileSync(join(ROOT, '.github/workflows', file), 'utf8')) as {
      jobs?: Record<string, Job>;
    };
  }
  return workflows;
}

function loadScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  return pkg.scripts;
}

describe('the repository has one definition of green', () => {
  let input: DriftInput;

  beforeAll(async () => {
    input = { manifest: await loadManifest(), workflows: loadWorkflows(), scripts: loadScripts() };
  });

  it('M8-ACC-02 does not drift between the manifest, CI and package.json', () => {
    expect(checkGateDrift(input)).toEqual([]);
  });

  it('M8-ACC-01 keeps packaging in the required set', () => {
    const packaging = input.manifest.gates.find((gate) => gate.id === 'test:packaging');

    expect(packaging?.policy).toBe('required-local');
    // And the lane it lives in is one CI blocks on, not a lane only a person runs.
    expect(input.manifest.lanes.find((lane) => lane.id === 'packaging')?.jobs).toContain('packaging');
  });

  it('M8-ACC-03 makes `verify` the single locally required entry point', () => {
    const requiredLocal = input.manifest.gates.filter((gate) => gate.policy === 'required-local');
    const lanes = new Set(requiredLocal.map((gate) => gate.lane));

    expect(input.scripts['verify']).toBe('node scripts/gate.mjs verify');
    // `verify` derives its lanes from the manifest, so the assertion that matters is that
    // every required-local gate is in a lane at all — there is no second list to compare.
    for (const lane of lanes) {
      expect(input.manifest.lanes.map((entry) => entry.id)).toContain(lane);
    }
    // The old `check` meant a fraction of the contract and read like all of it.
    expect(input.scripts['check']).toBe('node scripts/gate.mjs node');
  });

  it('separates evidence a laptop can produce from evidence only GitHub can', () => {
    const ciOnly = input.manifest.gates.filter((gate) => gate.policy === 'required-ci');

    expect(ciOnly.map((gate) => gate.id).sort()).toEqual(['codeql', 'secrets']);
    // Neither carries a command, which is what stops a local run from reporting them as
    // passing. `agent-flow` cannot run CodeQL and must not imply that it did.
    for (const gate of ciOnly) expect(gate.command).toBeUndefined();
  });

  it('gives every gate a reason a reader can act on', () => {
    for (const gate of input.manifest.gates) {
      expect(gate.why.length, gate.id).toBeGreaterThan(30);
      // A gate is either something to run or something to observe. Neither, or both, is a
      // shape the runner cannot report honestly.
      expect(
        (gate.command === undefined) !== (gate.action === undefined),
        `${gate.id} must declare exactly one of command/action`,
      ).toBe(true);
    }
  });

  // ── the positive controls the rules are worth nothing without ───────────────────

  it('fails when packaging leaves the required set (positive control)', () => {
    const downgraded: DriftInput = {
      ...input,
      manifest: {
        ...input.manifest,
        gates: input.manifest.gates.map((gate) =>
          gate.id === 'test:packaging' ? { ...gate, policy: 'report-only' as const } : gate,
        ),
      },
    };
    expect(checkGateDrift(downgraded)).toContainEqual(expect.stringContaining('R6'));

    const removed: DriftInput = {
      ...input,
      manifest: {
        ...input.manifest,
        gates: input.manifest.gates.filter((gate) => gate.id !== 'test:packaging'),
      },
    };
    expect(checkGateDrift(removed)).toContainEqual(expect.stringContaining('R6'));
  });

  it('fails when CI blocks on a command the manifest does not name (positive control)', () => {
    const smuggled: DriftInput = {
      ...input,
      workflows: {
        ...input.workflows,
        'ci.yml': {
          ...input.workflows['ci.yml'],
          jobs: {
            ...input.workflows['ci.yml']?.jobs,
            check: {
              steps: [
                ...(input.workflows['ci.yml']?.jobs?.['check']?.steps ?? []),
                { run: 'npm run test:visual' },
              ],
            },
          },
        },
      },
    };

    expect(checkGateDrift(smuggled)).toContainEqual(
      expect.stringContaining('R1 ci.yml#check runs `npm run test:visual`'),
    );
  });

  it('fails when a required gate lands in a lane no job runs (positive control)', () => {
    const orphaned: DriftInput = {
      ...input,
      manifest: {
        ...input.manifest,
        lanes: input.manifest.lanes.map((lane) =>
          lane.id === 'packaging' ? { ...lane, jobs: ['a-job-that-does-not-exist'] } : lane,
        ),
      },
    };

    const violations = checkGateDrift(orphaned);
    expect(violations).toContainEqual(expect.stringContaining('R2'));
    expect(violations).toContainEqual(expect.stringContaining('R3 required gate `test:packaging`'));
  });

  it('fails when a lane loses its package script (positive control)', () => {
    const { 'gate:packaging': _removed, ...rest } = input.scripts;

    expect(checkGateDrift({ ...input, scripts: rest })).toContainEqual(
      expect.stringContaining('R7 `gate:packaging` is `(absent)`'),
    );
  });
});
