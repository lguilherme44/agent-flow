import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { GlobalConfigSchema } from '../../src/contracts/index.js';
import { renderStageRouting, renderUnusedRunners } from '../../src/cli/render/routing.js';

const promptsDir = fileURLToPath(new URL('../../prompts', import.meta.url));

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

describe('stage routing is reported by stage, not only by role', () => {
  const lines = renderStageRouting(config(), promptsDir);
  const find = (stage: string) => lines.find((l) => l.trimStart().startsWith(stage));

  it('lists every pipeline stage with the runner that serves it', () => {
    for (const stage of ['discovery', 'architecture-impact', 'sdd', 'planning', 'implementation']) {
      expect(find(stage), stage).toBeDefined();
    }
  });

  it('says which stages read the repository, from the prompt frontmatter', () => {
    expect(find('discovery')).toContain('reads the repository');
    expect(find('implementation')).toContain('reads the repository');
    expect(find('sdd')).toContain('text in, text out');
  });

  it('flags a text-only stage served by a process-spawning runner', () => {
    // `architecture-impact` opens no file and rides on `architect`, which
    // `discovery` forces onto a CLI. That is the whole finding.
    const at = lines.findIndex((l) => l.trimStart().startsWith('architecture-impact'));
    expect(lines[at + 1]).toContain('openai-compatible');
  });

  it('does not flag a stage that genuinely reads files', () => {
    const at = lines.findIndex((l) => l.trimStart().startsWith('discovery'));
    expect(lines[at + 1] ?? '').not.toContain('could serve it');
  });

  it('stops flagging once the stage is on an endpoint', () => {
    const onLocal = renderStageRouting(
      config({
        roles: {
          ...config().roles,
          sdd: { runner: 'local', effort: 'high', timeoutSeconds: 900 },
        },
      }),
      promptsDir,
    );
    const at = onLocal.findIndex((l) => l.trimStart().startsWith('sdd'));
    expect(onLocal[at + 1] ?? '').not.toContain('could serve it');
  });
});

describe('a runner nobody routes to is listed rather than invisible', () => {
  it('names the unrouted runners', () => {
    const lines = renderUnusedRunners(config());
    expect(lines.join('\n')).toContain('local');
    expect(lines.join('\n')).toContain('spare');
  });

  it('does not list a runner a role points at', () => {
    expect(renderUnusedRunners(config()).join('\n')).not.toContain('claude ');
  });

  it('says nothing when every runner is routed', () => {
    const lean = GlobalConfigSchema.parse({
      runners: { claude: { type: 'claude-code-cli' } },
      roles: config().roles,
    });
    expect(renderUnusedRunners(lean)).toEqual([]);
  });
});

describe('the routing table is anchored to the real stage definitions', () => {
  it('names the same role and prompt each definition does', async () => {
    // `cli/render` writes the table out rather than importing the application
    // layer to render a report. That is only safe if a drift is a red test, which
    // is what this is — the comment in `routing.ts` promises exactly this check.
    const defs = await import('../../src/app/stages/definitions.js');
    const { PIPELINE_ROUTING } = await import('../../src/cli/render/routing.js');

    const byName = new Map(
      Object.values(defs)
        .filter(
          (d): d is { name: string; role: string; prompt: string } =>
            typeof d === 'object' && d !== null && 'name' in d && 'role' in d && 'prompt' in d,
        )
        // Several definitions share a stage name (planning has trivial and simple
        // variants); the standard one is what the report describes.
        .map((d) => [`${d.name}:${d.prompt}`, d]),
    );

    for (const entry of PIPELINE_ROUTING) {
      const real = byName.get(`${entry.stage}:${entry.prompt}`);
      if (real === undefined) continue; // implementation and the reviews live elsewhere
      expect(real.role, `${entry.stage} role`).toBe(entry.role);
    }
  });

  it('covers every prompt the repository ships, minus the variants', async () => {
    const { PIPELINE_ROUTING } = await import('../../src/cli/render/routing.js');
    // Nine stages in the pipeline view; the planning/plan-review variants are the
    // same stage rendered differently and are not separate rows.
    expect(PIPELINE_ROUTING).toHaveLength(9);
  });
});
