import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { createProgram, main } from '../../src/cli/index.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { projectHubPath } from '../../src/app/project-hub.js';
import { resolveGuidesDir } from '../../src/app/prompt-paths.js';
import { FLOW_GUIDES } from '../../src/core/flow-guides.js';
import * as contracts from '../../src/contracts/index.js';

/**
 * `agent-flow instructions [guide]` — how an AI learns to operate agent-flow from the
 * tool itself, without reading the source.
 */

let root: string;
let output: { stdout: () => string; stderr: () => string };

function captureOutput() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { stdout: () => out.join(''), stderr: () => err.join('') };
}

/** Runs the CLI against a throwaway home and directory, so no test can touch the real hub. */
function run(...args: string[]): Promise<number> {
  return main([
    'node',
    'agent-flow',
    '--cwd',
    root,
    '--config',
    join(root, 'home', 'config.yaml'),
    ...args,
  ]);
}

function guideText(key: string): string {
  return readFileSync(join(resolveGuidesDir(), `${key}.md`), 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'af-instructions-'));
  mkdirSync(join(root, 'home'), { recursive: true });
  output = captureOutput();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('agent-flow instructions', () => {
  it('with no guide, prints the overview and then a one-line index of the others', async () => {
    expect(await run('instructions')).toBe(ExitCode.OK);

    const stdout = output.stdout();
    expect(stdout.startsWith(guideText('overview').trimEnd())).toBe(true);

    const others = FLOW_GUIDES.filter((g) => g.key !== 'overview').map((g) => g.key);
    const index = stdout.trimEnd().split(/\r?\n/).at(-1) ?? '';
    for (const key of others) expect(index).toContain(key);
    expect(index).toContain('agent-flow instructions <guide>');
  });

  it('prints the guide it was asked for', async () => {
    expect(await run('instructions', 'gate')).toBe(ExitCode.OK);
    expect(output.stdout().trimEnd()).toBe(guideText('gate').trimEnd());
  });

  it('refuses an unknown guide with a configuration error, listing the valid ones', async () => {
    expect(await run('instructions', 'deploy')).toBe(ExitCode.CONFIG_ERROR);

    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain('Unknown guide "deploy"');
    for (const guide of FLOW_GUIDES) expect(output.stderr()).toContain(guide.key);
  });

  it('--list prints one `key — description` line per guide', async () => {
    expect(await run('instructions', '--list')).toBe(ExitCode.OK);

    const lines = output.stdout().trimEnd().split(/\r?\n/);
    expect(lines).toEqual(FLOW_GUIDES.map((g) => `${g.key} — ${g.description}`));
  });
});

/**
 * A read-only command must not register the project in the hub.
 *
 * `postAction` adds the directory of every command to the hub. For `instructions` that
 * would be a write performed by a command whose whole contract is to print text — and an
 * AI calls it first, in whatever directory it happens to be in.
 */
describe('instructions leaves the project hub alone', () => {
  function project(): { config: string; hub: string; dir: string } {
    const dir = join(root, 'api');
    mkdirSync(join(dir, '.agent-flow'), { recursive: true });
    writeFileSync(join(dir, '.agent-flow', 'config.yaml'), 'project:\n  name: api\n  type: node\n');
    const config = join(root, 'home', 'config.yaml');
    return { config, hub: projectHubPath(config), dir };
  }

  it('does not add the project it ran in', async () => {
    const { config, hub, dir } = project();

    await main(['node', 'agent-flow', '--cwd', dir, '--config', config, 'instructions']);

    expect(existsSync(hub)).toBe(false);
  });

  it('positive control: another command in the same world does add it', async () => {
    // Without this the test above passes for the wrong reason the day the hub stops
    // filling itself for every command.
    const { config, hub, dir } = project();

    await main(['node', 'agent-flow', '--cwd', dir, '--config', config, 'config', 'list', '--global']);

    expect(JSON.parse(readFileSync(hub, 'utf8'))).toEqual([dir]);
  });
});

/**
 * The guides cannot drift from the CLI and the API they describe.
 *
 * A guide is read by a model that will run what it says, verbatim. A renamed command or
 * a removed flag left in a guide is an instruction that fails at the worst moment — in
 * front of the human the AI was supposed to spare. So every `agent-flow <command>` and
 * `--flag` in a guide's code must be registered with commander, and every HTTP route it
 * names must be one `server.ts` declares.
 */
describe('the guides name only what exists', () => {
  const SERVER = readFileSync(join(import.meta.dirname, '../../src/server/server.ts'), 'utf8');

  /** The code a guide shows: fenced blocks and inline spans. Prose is not an instruction. */
  function codeOf(markdown: string): string[] {
    const fenced = [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
    const withoutFences = markdown.replace(/```[\s\S]*?```/g, '');
    const inline = [...withoutFences.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? '');
    return [...fenced.flatMap((block) => block.split(/\r?\n/)), ...inline];
  }

  function longFlags(command: Command): string[] {
    return command.options.map((option) => option.long).filter((flag): flag is string => !!flag);
  }

  /** Every unknown command or flag in this markdown, described. Empty means honest. */
  function dishonesty(markdown: string): string[] {
    const { program } = createProgram();
    const global = [...longFlags(program), '--help'];
    const problems: string[] = [];

    for (const line of codeOf(markdown)) {
      for (const match of line.matchAll(/\bagent-flow\s+([a-z][a-z-]*)([^|;&]*)/g)) {
        const name = match[1] ?? '';
        const command = program.commands.find((c) => c.name() === name);
        if (command === undefined) {
          problems.push(`unknown command: agent-flow ${name}`);
          continue;
        }
        const allowed = [...global, ...longFlags(command)];
        // Digits too: `--e2e-observed` read as `--e` was the first false alarm.
        for (const flag of (match[2] ?? '').match(/--[a-z][a-z0-9-]*/g) ?? []) {
          if (!allowed.includes(flag)) problems.push(`unknown flag: agent-flow ${name} ${flag}`);
        }
      }
    }
    return problems;
  }

  function routes(markdown: string): Array<{ method: string; path: string }> {
    return codeOf(markdown).flatMap((line) =>
      [...line.matchAll(/\b(GET|POST|PATCH)\s+(\/api\/v1\/[^\s`?]*)/g)].map((m) => ({
        method: m[1] ?? '',
        path: m[2] ?? '',
      })),
    );
  }

  it('mentions only registered commands and flags', () => {
    for (const guide of FLOW_GUIDES) {
      expect(dishonesty(guideText(guide.key)), guide.key).toEqual([]);
    }
  });

  /** Every route in this markdown that `server.ts` does not declare. */
  function missingRoutes(markdown: string): string[] {
    return routes(markdown)
      .filter(({ method, path }) => !SERVER.includes(`app.${method.toLowerCase()}('${path}'`))
      .map(({ method, path }) => `${method} ${path}`);
  }

  it('names only routes the server declares', () => {
    for (const guide of FLOW_GUIDES) {
      expect(missingRoutes(guideText(guide.key)), guide.key).toEqual([]);
    }
  });

  it('is not vacuous: the guides do name commands and routes', () => {
    const all = FLOW_GUIDES.map((g) => guideText(g.key)).join('\n');
    const commands = codeOf(all).join('\n').match(/\bagent-flow\s+[a-z]/g) ?? [];
    expect(commands.length).toBeGreaterThanOrEqual(15);
    expect(routes(all).length).toBeGreaterThanOrEqual(10);
  });

  it('positive control: a fabricated command, flag or route is caught', () => {
    expect(dishonesty('Run `agent-flow approvee`.')).toEqual(['unknown command: agent-flow approvee']);
    expect(dishonesty('Run `agent-flow cancel --now`.')).toEqual(['unknown flag: agent-flow cancel --now']);
    // Prose is not checked, so prose mentioning the tool by name stays legal.
    expect(dishonesty('agent-flow is an orchestrator.')).toEqual([]);
    expect(missingRoutes('`POST /api/v1/runs/:runId/ship`')).toEqual(['POST /api/v1/runs/:runId/ship']);
    expect(missingRoutes('`POST /api/v1/runs/:runId/approve`')).toEqual([]);
  });

  /**
   * A flag in its own span — "add `--decision`" — names no command, so the check above never
   * saw it. It must at least be a flag some command registers; which command the prose
   * means is the reader's job, and a guide that says it is the gate guide's job.
   */
  function strayFlags(markdown: string): string[] {
    const { program } = createProgram();
    const known = new Set([
      ...longFlags(program),
      '--help',
      ...program.commands.flatMap((command) => longFlags(command)),
    ]);
    return codeOf(markdown)
      .map((line) => line.replace(/\bagent-flow\s+[a-z][a-z-]*[^|;&]*/g, ''))
      .flatMap((rest) => rest.match(/(?<![\w-])--[a-z][a-z0-9-]*/g) ?? [])
      .filter((flag) => !known.has(flag))
      .map((flag) => `unknown flag: ${flag}`);
  }

  it('mentions only flags some command registers, even on their own', () => {
    for (const guide of FLOW_GUIDES) {
      expect(strayFlags(guideText(guide.key)), guide.key).toEqual([]);
    }
  });

  /**
   * The request schema each POST route parses, read from `server.ts` itself — the
   * `<Name>RequestSchema.safeParse` the handler opens with — so the map cannot drift
   * from the server the way a hand-written one would.
   */
  const SCHEMAS = contracts as unknown as Record<string, unknown>;

  /** An object schema's fields, through `.optional()` wrappers; `undefined` for a leaf. */
  function shapeOf(schema: unknown): Record<string, unknown> | undefined {
    let current = schema as { shape?: Record<string, unknown>; unwrap?: () => unknown } | undefined;
    while (current !== undefined && current.shape === undefined && typeof current.unwrap === 'function') {
      current = current.unwrap() as typeof current;
    }
    return current?.shape;
  }

  /** The fields of the body schema a POST route parses; `undefined` when no route matches. */
  function bodySchemaOf(path: string): Record<string, unknown> | undefined {
    const start = SERVER.indexOf(`app.post('${path}'`);
    if (start < 0) return undefined;
    const next = SERVER.indexOf('app.', start + 1);
    const handler = SERVER.slice(start, next < 0 ? undefined : next);
    const name = /(\w+RequestSchema)\.safeParse\(request\.body/.exec(handler)?.[1];
    const schema = name === undefined ? undefined : SCHEMAS[name];
    if (schema === undefined || typeof schema !== 'object' || schema === null) return {};
    return shapeOf(schema) ?? {};
  }

  /**
   * Every key path in a body that its schema does not accept. A nested object is checked
   * against the nested schema (`decidedBy.by`), so its keys are neither taken for the route's
   * own nor left unchecked.
   */
  function unknownKeysOf(body: unknown, shape: Record<string, unknown>, prefix = ''): string[] {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return [];
    return Object.entries(body as Record<string, unknown>).flatMap(([key, value]) => {
      if (!(key in shape)) return [`${prefix}${key}`];
      const nested = shapeOf(shape[key]);
      return nested === undefined ? [] : unknownKeysOf(value, nested, `${prefix}${key}.`);
    });
  }

  /**
   * Every body key a guide names that the route it belongs to does not accept.
   *
   * **Zod drops unknown keys without a word**, so a guide that says
   * `{"instruction": "…", "decision": true}` sends a body the server answers 202 to and
   * then ignores half of. A body belongs to the nearest route named before it.
   */
  function unknownBodyKeys(markdown: string): string[] {
    const problems: string[] = [];
    const spans = [...markdown.matchAll(/`(POST\s+\/api\/v1\/[^\s`?]*)[^`]*`|`(\{[^`]*\})`/g)];
    let route: string | undefined;
    for (const span of spans) {
      if (span[1] !== undefined) {
        route = span[1].replace(/^POST\s+/, '');
        continue;
      }
      const text = span[2] ?? '';
      const keys = [...text.matchAll(/"([A-Za-z]+)"\s*:/g)].map((m) => m[1] ?? '');
      if (keys.length === 0) continue;
      const accepted = route === undefined ? undefined : bodySchemaOf(route);
      if (accepted === undefined) {
        problems.push(`body ${text} follows no POST route the server declares`);
        continue;
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON a reader could send as written; it is still judged key by key.
        body = Object.fromEntries(keys.map((key) => [key, '']));
      }
      for (const key of unknownKeysOf(body, accepted)) {
        problems.push(`POST ${route ?? ''} does not accept "${key}"`);
      }
    }
    return problems;
  }

  /**
   * The gate guide is what an AI reads before moving the gate, and the use cases refuse a
   * move with no named human. A guide command without `--decided-by` would fail in front of
   * the human — or teach the AI to fill the name in itself.
   */
  it('the gate guide names the human on every gate command it shows', () => {
    const gate = guideText('gate');
    const moves = codeOf(gate).filter((line) => /\bagent-flow\s+(approve|reject|revise)\b/.test(line));
    expect(moves.length).toBeGreaterThanOrEqual(3);
    for (const line of moves) expect(line, line).toMatch(/--decided-by .+--words/);
    expect(gate).toContain('"decidedBy"');
    // The human is told the channel is recorded, so a decision made over the API shows.
    expect(gate).toMatch(/channel/);
  });

  it('names only body keys the route it belongs to accepts', () => {
    for (const guide of FLOW_GUIDES) {
      expect(unknownBodyKeys(guideText(guide.key)), guide.key).toEqual([]);
    }
  });

  it('positive control: a stray flag and an ignored body key are caught', () => {
    expect(strayFlags('add `--decisive`')).toEqual(['unknown flag: --decisive']);
    expect(dishonesty('`agent-flow review --e2e-observd "x"`')).toEqual([
      'unknown flag: agent-flow review --e2e-observd',
    ]);
    expect(strayFlags('add `--decision`')).toEqual([]);
    // The defect the gate guide had: CLI-only knobs implied over HTTP.
    expect(
      unknownBodyKeys('`POST /api/v1/runs/:runId/revise` with `{"instruction": "x", "decision": true}`'),
    ).toEqual(['POST /api/v1/runs/:runId/revise does not accept "decision"']);
    expect(unknownBodyKeys('`POST /api/v1/runs/:runId/revise` with `{"instruction": "x"}`')).toEqual([]);
    expect(unknownBodyKeys('use `{"force": true}`')).toEqual([
      'body {"force": true} follows no POST route the server declares',
    ]);
    expect(unknownBodyKeys('`POST /api/v1/runs/:runId/review` with `{"e2eObserved": "x"}`')).toEqual([]);
    // A nested object is judged against the nested schema: its keys are not the route's.
    const approve = '`POST /api/v1/runs/:runId/approve` with ';
    expect(unknownBodyKeys(`${approve}\`{"decidedBy": {"by": "x", "words": "y"}}\``)).toEqual([]);
    expect(unknownBodyKeys(`${approve}\`{"decidedBy": {"name": "x", "words": "y"}}\``)).toEqual([
      'POST /api/v1/runs/:runId/approve does not accept "decidedBy.name"',
    ]);
    expect(unknownBodyKeys(`${approve}\`{"decidedby": {"by": "x"}}\``)).toEqual([
      'POST /api/v1/runs/:runId/approve does not accept "decidedby"',
    ]);
  });
});
