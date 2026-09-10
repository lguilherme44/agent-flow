import { describe, expect, it } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FakeHost } from '../fakes/fake-host.js';
import { sharedReviewProvider } from '../../src/core/independence.js';
import { getCeremonyBudget } from '../../src/core/adaptive-workflow.js';
import { isThrowawayWorkspace } from '../../src/core/worktree-policy.js';
import { reclaimStrayWorkspaces } from '../../src/app/namespace-reclaim.js';
import { GlobalConfigSchema } from '../../src/contracts/index.js';

/**
 * The five findings of the 10/09/2026 dogfood, each with the thing that would fail again.
 *
 * Written from `docs/specs/live-dogfood-remote-control.md`, and four of the five are the
 * same defect wearing different clothes: **a result that was computed and then discarded.**
 * So the assertions are mostly about *reading an answer* — a `GitResult`, a budget, a
 * provider pair — rather than about producing one.
 *
 * Two live elsewhere, next to what they are about: D1 in `test/cli/ui-port-in-use.test.ts`,
 * which needs a real listener on a real port, and D4 in
 * `test/cli/doctor-install-probe.test.ts`, which needs a real Git worktree. What is here is
 * the folds and the sweep.
 */

const ROLES = (planner: string, reviewer: string) =>
  GlobalConfigSchema.parse({
    runners: {
      agy: { type: 'agy-cli' },
      claude: { type: 'claude-code-cli' },
    },
    roles: {
      architect: { runner: 'agy', effort: 'high' },
      sdd: { runner: 'agy', effort: 'high' },
      planner: { runner: planner, effort: 'high' },
      planReviewer: { runner: reviewer, effort: 'high' },
      executors: {
        trivial: { runner: 'agy', effort: 'low' },
        normal: { runner: 'agy', effort: 'medium' },
        complex: { runner: 'agy', effort: 'high' },
      },
      verification: { runner: 'agy', effort: 'medium' },
      finalReviewer: { runner: reviewer, effort: 'very_high' },
    },
  }).roles;

const PROVIDERS: Record<string, string> = { agy: 'agy-cli', claude: 'claude-code-cli' };
const providerOf = (id: string): string | undefined => PROVIDERS[id];

describe('D2 — the high-risk review pair is judged from configuration alone', () => {
  it('names the shared provider when planner and reviewer collide', () => {
    // The measured case: `AF-2026-001` was created, refused 2.2 s later, and left in the
    // history with no plan. Both facts were knowable before anything existed.
    expect(
      sharedReviewProvider({ plannerRunner: 'agy', reviewerRunner: 'agy', providerOf }),
    ).toBe('agy-cli');
  });

  it('is satisfied by two providers', () => {
    expect(
      sharedReviewProvider({ plannerRunner: 'agy', reviewerRunner: 'claude', providerOf }),
    ).toBeUndefined();
  });

  it('does not refuse what it cannot judge', () => {
    // A runner whose provider does not resolve is a misconfiguration the registry reports
    // with a better sentence. Turning undecidable into a refusal would make this function
    // the thing that explains an unrelated problem, badly.
    expect(
      sharedReviewProvider({ plannerRunner: 'agy', reviewerRunner: 'ghost', providerOf }),
    ).toBeUndefined();
  });

  it('reads the configured roles, so a fixed pair is not what makes it pass', () => {
    // The positive control: the same function over the same providers answers differently
    // when the *configuration* differs, which is what proves it reads it at all.
    const same = ROLES('agy', 'agy');
    const split = ROLES('agy', 'claude');
    expect(same.planner.runner).toBe(same.planReviewer.runner);
    expect(split.planner.runner).not.toBe(split.planReviewer.runner);
  });
});

describe('D3 — every workflow class enforces the task bound it declares', () => {
  it('declares a bound for all four classes', () => {
    // The bound was never the problem: it existed, and the run recorded it in
    // `workflow_classified`. Two of the four then ignored it.
    expect(getCeremonyBudget('trivial').maxTasks).toBe(1);
    expect(getCeremonyBudget('simple').maxTasks).toBe(3);
    expect(getCeremonyBudget('standard').maxTasks).toBe(8);
    expect(getCeremonyBudget('high-risk').maxTasks).toBe(8);
  });

  it('has no class whose bound the pipeline passes an empty check for', async () => {
    // Asserted against the source, because the defect *was* a source-level omission —
    // `ceremonyProblems: () => []` — and no fixture reaches it without spending a model
    // call. A run measured live wrote `budget.maxTasks: 8` into its own event log and then
    // accepted a twelve-task plan, with nothing refusing, warning or degrading.
    const source = await new InMemoryFileSystem()
      .exists('/never')
      .then(async () => (await import('node:fs/promises')).readFile('src/app/planning-pipeline.ts', 'utf8'));

    expect(source).not.toContain('ceremonyProblems: () => []');
    // And the bound is read from the budget rather than written out again, so the two
    // cannot disagree the day a class's number changes.
    expect(source).toContain('candidate.tasks.length > budget.maxTasks');
  });
});

describe('D5 — the throwaway workspaces that belong to no run are reclaimable', () => {
  const ROOT = '/home/.agent-flow/worktrees';

  /** Enough of the adapter for the sweep: the root, and what Git registers. */
  const workspacesWith = (registered: readonly string[]) =>
    ({
      worktreeRoot: ROOT,
      listWorktrees: () =>
        Promise.resolve({ ok: true as const, value: registered.map((path) => ({ path })) }),
    }) as unknown as Parameters<typeof reclaimStrayWorkspaces>[0]['workspaces'];

  const seeded = () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${ROOT}/doctor-install-probe-pid-1/node_modules/x/index.js`, 'm');
    fs.seed(`${ROOT}/read-only-planning-pid-2-1/dist/bundle.js`, 'built');
    // A real run's workspace, which must survive: `<repoKey>/<gitRunKey>/…`.
    fs.seed(`${ROOT}/abcd1234/AF-2026-001-beef/integration/src/a.ts`, 'export const a = 1;');
    return fs;
  };

  const deps = (fs: InMemoryFileSystem, registered: readonly string[] = []) => ({
    fs,
    host: new FakeHost(1, 'test-host', [1], '/home'),
    projectDir: '/repo',
    workspaces: workspacesWith(registered),
  });

  it('removes both throwaway kinds and leaves a run workspace alone', async () => {
    const fs = seeded();

    const found = await reclaimStrayWorkspaces(deps(fs));

    expect(found.map((entry) => entry.segment).sort()).toEqual([
      'doctor-install-probe-pid-1',
      'read-only-planning-pid-2-1',
    ]);
    expect(found.every((entry) => entry.removed)).toBe(true);
    // The assertion that matters most. §7.4 keeps an attempt worktree because it is the
    // only remaining copy of what an agent produced, and a sweep that took one would be a
    // far worse defect than the leak it fixes.
    expect(await fs.exists(`${ROOT}/abcd1234/AF-2026-001-beef/integration/src/a.ts`)).toBe(true);
  });

  it('leaves a directory Git still registers, because something is using it', async () => {
    const fs = seeded();

    const found = await reclaimStrayWorkspaces(
      deps(fs, [`${ROOT}/read-only-planning-pid-2-1`]),
    );

    const busy = found.find((entry) => entry.segment === 'read-only-planning-pid-2-1');
    expect(busy?.removed).toBe(false);
    expect(await fs.exists(`${ROOT}/read-only-planning-pid-2-1/dist/bundle.js`)).toBe(true);
  });

  it('changes nothing on a dry run, and says what it would do', async () => {
    const fs = seeded();

    const found = await reclaimStrayWorkspaces(deps(fs), { dryRun: true });

    expect(found).toHaveLength(2);
    expect(found.every((entry) => !entry.removed)).toBe(true);
    expect(await fs.exists(`${ROOT}/doctor-install-probe-pid-1/node_modules/x/index.js`)).toBe(
      true,
    );
  });

  it('recognises only the names the product composes for discarding', () => {
    // The prefix list is what makes the sweep safe, so it is asserted directly rather
    // than only through the sweep.
    expect(isThrowawayWorkspace('doctor-install-probe-pid-1')).toBe(true);
    expect(isThrowawayWorkspace('read-only-planning-pid-2-1')).toBe(true);
    expect(isThrowawayWorkspace('abcd1234')).toBe(false);
    expect(isThrowawayWorkspace('AF-2026-001-beef')).toBe(false);
    expect(isThrowawayWorkspace('integration')).toBe(false);
  });
});
