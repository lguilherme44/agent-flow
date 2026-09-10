import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { GlobalConfigSchema, type GlobalConfig } from '../../src/contracts/index.js';
import { describeStageRouting, describeUnusedRunners } from '../../src/app/diagnostics.js';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { renderStageRouting, renderUnusedRunners } from '../../src/cli/render/routing.js';

const promptsDir = fileURLToPath(new URL('../../prompts', import.meta.url));
const fs = new NodeFileSystem();

const config = (over: Record<string, unknown> = {}) =>
  GlobalConfigSchema.parse({
    runners: {
      claude: { type: 'claude-code-cli' },
      local: { type: 'openai-compatible', baseUrl: 'http://x/v1' },
      spare: { type: 'codex-cli' },
    },
    roles: {
      architect: { runner: 'claude', effort: 'high' },
      sdd: { runner: 'claude', effort: 'high' },
      planner: { runner: 'claude', effort: 'high' },
      planReviewer: { runner: 'claude', effort: 'high' },
      executors: {
        trivial: { runner: 'claude', effort: 'low' },
        normal: { runner: 'claude', effort: 'high' },
        complex: { runner: 'claude', effort: 'high' },
      },
      verification: { runner: 'claude', effort: 'medium' },
      finalReviewer: { runner: 'claude', effort: 'high' },
    },
    ...over,
  });

/**
 * The two halves, joined the way `doctor` joins them.
 *
 * The judgement moved to `app/diagnostics.ts` so the Deck could ask for it too; the lines
 * stayed in `cli/render`. Testing through both is what keeps the finding and its sentence
 * from drifting apart — a row marked `overpowered` that no longer renders a suggestion
 * would pass a test of either half alone.
 */
const routingLines = async (c: GlobalConfig = config()): Promise<string[]> =>
  renderStageRouting(await describeStageRouting({ config: c, promptsDir, fs }));

const unusedLines = (c: GlobalConfig = config()): string[] =>
  renderUnusedRunners(describeUnusedRunners(c));

describe('stage routing is reported by stage, not only by role', () => {
  it('lists every pipeline stage with the runner that serves it', async () => {
    const lines = await routingLines();
    for (const stage of ['discovery', 'architecture-impact', 'sdd', 'planning', 'implementation']) {
      expect(
        lines.find((l) => l.trimStart().startsWith(stage)),
        stage,
      ).toBeDefined();
    }
  });

  it('says which stages read the repository, from the prompt frontmatter', async () => {
    const lines = await routingLines();
    const find = (stage: string) => lines.find((l) => l.trimStart().startsWith(stage));
    expect(find('discovery')).toContain('reads the repository');
    expect(find('implementation')).toContain('reads the repository');
    expect(find('sdd')).toContain('text in, text out');
  });

  it('flags a text-only stage served by a process-spawning runner', async () => {
    // `architecture-impact` opens no file and rides on `architect`, which
    // `discovery` forces onto a CLI. That is the whole finding.
    const lines = await routingLines();
    const at = lines.findIndex((l) => l.trimStart().startsWith('architecture-impact'));
    expect(lines[at + 1]).toContain('openai-compatible');
  });

  it('does not flag a stage that genuinely reads files', async () => {
    const lines = await routingLines();
    const at = lines.findIndex((l) => l.trimStart().startsWith('discovery'));
    expect(lines[at + 1] ?? '').not.toContain('could serve it');
  });

  it('stops flagging once the stage is on an endpoint', async () => {
    const onLocal = await routingLines(
      config({
        roles: {
          ...config().roles,
          sdd: { runner: 'local', effort: 'high', timeoutSeconds: 900 },
        },
      }),
    );
    const at = onLocal.findIndex((l) => l.trimStart().startsWith('sdd'));
    expect(onLocal[at + 1] ?? '').not.toContain('could serve it');
  });
});

describe('the finding is decided once, where both surfaces can read it', () => {
  it('marks the overpowered stage in the data, not only in the sentence', async () => {
    // The reason the split exists: `GET /api/v1/doctor` renders nothing, so a finding
    // that lived only in a rendered line would be invisible to the Deck.
    const rows = await describeStageRouting({ config: config(), promptsDir, fs });
    const impact = rows.find((row) => row.stage === 'architecture-impact');

    expect(impact?.overpowered).toBe(true);
    expect(impact?.readsRepository).toBe(false);
    expect(impact?.runner).toBe('claude');
    expect(rows.find((row) => row.stage === 'discovery')?.overpowered).toBe(false);
  });

  it('names the runner type, so a reader can see why a stage is flagged', async () => {
    const rows = await describeStageRouting({ config: config(), promptsDir, fs });
    expect(rows.find((row) => row.stage === 'discovery')?.runnerType).toBe('claude-code-cli');
  });
});

describe('a runner nobody routes to is listed rather than invisible', () => {
  it('names the unrouted runners', () => {
    const lines = unusedLines();
    expect(lines.join('\n')).toContain('local');
    expect(lines.join('\n')).toContain('spare');
  });

  it('does not list a runner a role points at', () => {
    expect(unusedLines().join('\n')).not.toContain('claude ');
  });

  it('says nothing when every runner is routed', () => {
    const lean = GlobalConfigSchema.parse({
      runners: { claude: { type: 'claude-code-cli' } },
      roles: config().roles,
    });
    expect(unusedLines(lean)).toEqual([]);
  });
});

describe('the routing table is anchored to the real stage definitions', () => {
  it('names the same role and prompt each definition does', async () => {
    // The table is written out rather than derived, because the definitions carry
    // planning variants only one of which ever runs. That is only safe if a drift is a
    // red test, which is what this is — the comment on `PIPELINE_ROUTING` promises it.
    const defs = await import('../../src/app/stages/definitions.js');
    const { PIPELINE_ROUTING } = await import('../../src/app/diagnostics.js');

    // The definitions are already typed; no predicate needed, and one that widened
    // the type would be the assertion this test exists to prevent.
    const byName = new Map(
      Object.values(defs)
        .filter((d) => typeof d === 'object' && d !== null && 'name' in d && 'prompt' in d)
        // Several definitions share a stage name (planning has trivial and simple
        // variants); the standard one is what the report describes.
        .map((d) => [`${String(d.name)}:${String(d.prompt)}`, d] as const),
    );

    for (const entry of PIPELINE_ROUTING) {
      const real = byName.get(`${entry.stage}:${entry.prompt}`);
      if (real === undefined) continue; // implementation and the reviews live elsewhere
      expect(String(real.role), `${entry.stage} role`).toBe(entry.role);
    }
  });

  it('covers every prompt the repository ships, minus the variants', async () => {
    const { PIPELINE_ROUTING } = await import('../../src/app/diagnostics.js');
    // Nine stages in the pipeline view; the planning/plan-review variants are the
    // same stage rendered differently and are not separate rows.
    expect(PIPELINE_ROUTING).toHaveLength(9);
  });
});

describe('the report follows the stage override', () => {
  it('shows the runner the stage will actually use', async () => {
    // Caught by running `doctor`, not by a unit test: the first version of this
    // report resolved through `roleConfigOf` and described a routing the run
    // would not take.
    const withOverride = GlobalConfigSchema.parse({
      runners: {
        claude: { type: 'claude-code-cli' },
        local: { type: 'openai-compatible', baseUrl: 'http://x/v1' },
      },
      roles: {
        ...config().roles,
        architect: {
          runner: 'claude',
          effort: 'high',
          stages: { 'architecture-impact': { runner: 'local' } },
        },
      },
    });

    const lines = await routingLines(withOverride);
    const at = lines.findIndex((l) => l.trimStart().startsWith('architecture-impact'));
    expect(lines[at]).toContain('local');
    // And the finding is gone, because there is nothing left to point out.
    expect(lines[at + 1] ?? '').not.toContain('could serve it');
  });

  it('counts a runner used only by an override as routed', () => {
    const lines = unusedLines(
      GlobalConfigSchema.parse({
        runners: {
          claude: { type: 'claude-code-cli' },
          local: { type: 'openai-compatible', baseUrl: 'http://x/v1' },
        },
        roles: {
          ...config().roles,
          architect: {
            runner: 'claude',
            effort: 'high',
            stages: { 'architecture-impact': { runner: 'local' } },
          },
        },
      }),
    );
    expect(lines.join('\n')).not.toContain('local');
  });
});
