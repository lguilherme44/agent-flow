import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectTestClient, type McpTestClient } from '../fakes/mcp-test-client.js';
import { projectHubPath } from '../../src/app/project-hub.js';
import { resolveGuidesDir } from '../../src/app/prompt-paths.js';
import { FLOW_GUIDES } from '../../src/core/flow-guides.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import type * as McpModule from '../../src/cli/mcp.js';

/**
 * `agent-flow mcp`: the command, and one round trip through a real MCP client.
 *
 * `runMcpCommand` is replaced for the `main` tests below: the real one serves stdio until
 * its input closes, which in a test process would read the runner's own stdin. What those
 * tests are about is the command tree and the hub hook, not the transport — the transport
 * is exercised in memory at the bottom of this file.
 */
const served = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock('../../src/cli/mcp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof McpModule>();
  return {
    ...actual,
    runMcpCommand: (options: unknown) => {
      served.options.push(options);
      return Promise.resolve(0);
    },
  };
});

const { createProgram, main } = await import('../../src/cli/index.js');
const { resolveHubUrl, DEFAULT_HUB_URL, createMcpServerForHub } = await import('../../src/cli/mcp.js');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'af-mcp-'));
  mkdirSync(join(root, 'home'), { recursive: true });
  served.options.length = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function guideText(key: string): string {
  return readFileSync(join(resolveGuidesDir(), `${key}.md`), 'utf8');
}

describe('agent-flow mcp, the command', () => {
  it('is registered, with --hub and --allow-remote-hub', () => {
    const { program } = createProgram();
    const command = program.commands.find((c) => c.name() === 'mcp');

    expect(command).toBeDefined();
    expect(command?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--hub', '--allow-remote-hub']),
    );
  });

  it('passes --allow-remote-hub through', async () => {
    const config = join(root, 'home', 'config.yaml');

    await main(['node', 'agent-flow', '--cwd', root, '--config', config, 'mcp', '--hub', 'http://10.0.0.5:4782', '--allow-remote-hub']);

    expect(served.options).toEqual([{ hub: 'http://10.0.0.5:4782', allowRemoteHub: true }]);
  });

  it('passes --hub through to the server', async () => {
    const config = join(root, 'home', 'config.yaml');

    const code = await main(['node', 'agent-flow', '--cwd', root, '--config', config, 'mcp', '--hub', 'http://127.0.0.1:9999']);

    expect(code).toBe(ExitCode.OK);
    expect(served.options).toEqual([{ hub: 'http://127.0.0.1:9999' }]);
  });
});

/**
 * `mcp` reads and relays; it must not register the project it was started in. Claude Code
 * starts it from whatever directory the session opened — the same reason `instructions`
 * is left out of the hook.
 */
describe('mcp leaves the project hub alone', () => {
  function project(): { config: string; hub: string; dir: string } {
    const dir = join(root, 'api');
    mkdirSync(join(dir, '.agent-flow'), { recursive: true });
    writeFileSync(join(dir, '.agent-flow', 'config.yaml'), 'project:\n  name: api\n  type: node\n');
    const config = join(root, 'home', 'config.yaml');
    return { config, hub: projectHubPath(config), dir };
  }

  it('does not add the project it ran in', async () => {
    const { config, hub, dir } = project();

    await main(['node', 'agent-flow', '--cwd', dir, '--config', config, 'mcp']);

    expect(served.options).toHaveLength(1);
    expect(existsSync(hub)).toBe(false);
  });

  it('positive control: another command in the same world does add it', async () => {
    const { config, hub, dir } = project();

    await main(['node', 'agent-flow', '--cwd', dir, '--config', config, 'config', 'list', '--global']);

    expect(JSON.parse(readFileSync(hub, 'utf8'))).toEqual([dir]);
  });
});

describe('resolveHubUrl', () => {
  it('prefers --hub, then AGENT_FLOW_HUB_URL, then the default the dashboard serves', () => {
    expect(DEFAULT_HUB_URL).toBe('http://127.0.0.1:4782');
    expect(resolveHubUrl('http://127.0.0.1:1', 'http://localhost:2')).toEqual({ ok: true, url: 'http://127.0.0.1:1' });
    expect(resolveHubUrl(undefined, 'http://localhost:2')).toEqual({ ok: true, url: 'http://localhost:2' });
    expect(resolveHubUrl('http://[::1]:4782', undefined)).toEqual({ ok: true, url: 'http://[::1]:4782' });
    expect(resolveHubUrl(undefined, undefined)).toEqual({ ok: true, url: DEFAULT_HUB_URL });
    expect(resolveHubUrl(undefined, '  ')).toEqual({ ok: true, url: DEFAULT_HUB_URL });
  });

  it('refuses a value that is not an http(s) URL, naming it', () => {
    const outcome = resolveHubUrl('127.0.0.1:4782', undefined);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('127.0.0.1:4782');

    expect(resolveHubUrl('file:///etc/passwd', undefined).ok).toBe(false);
  });

  it('refuses a hub off this machine unless allowed, and says why', () => {
    for (const url of ['http://10.0.0.5:4782', 'http://hub.example.com', 'http://127.0.0.1.nip.io:4782']) {
      const outcome = resolveHubUrl(url, undefined);
      expect(outcome.ok, url).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.message).toContain('--allow-remote-hub');
      expect(outcome.message).toMatch(/no authentication/);
    }
    // Positive control: the same URL with the deliberate flag.
    expect(resolveHubUrl('http://10.0.0.5:4782', undefined, true)).toEqual({ ok: true, url: 'http://10.0.0.5:4782' });
  });
});

describe('the guides send an MCP client to the MCP tools', () => {
  it('the feature guide names run_execute beside the CLI and HTTP ways to execute', () => {
    const execute = guideText('feature').split(/\r?\n/).find((line) => line.startsWith('- Execute:')) ?? '';
    expect(execute).toContain('run_execute');
    expect(execute).toContain('agent-flow run');
  });

  it('the gate guide points at run_artifacts, and keeps force a CLI-only human choice', () => {
    const gate = guideText('gate');
    expect(gate).toContain('run_artifacts');
    expect(gate).toMatch(/--force` overrules the review \(CLI only, and only on the human's explicit/);
    expect(gate).toContain('the MCP tools have no force');
    expect(gate).not.toContain('{"force": true}');
  });

  it('the blocked and recover guides name the human on an answer and a cancel', () => {
    expect(guideText('blocked')).toMatch(/task_answer[\s\S]*"decidedBy"/);
    expect(guideText('recover')).toMatch(/cancel` with `\{"decidedBy"[\s\S]*run_cancel/);
  });

  it('every CLI answer, cancel and overriding retry a guide shows names the human', () => {
    const code = [guideText('blocked'), guideText('recover')]
      .join('\n')
      .split(/\r?\n/)
      .filter((line) => /agent-flow (answer|cancel)\b|agent-flow retry .*--(force|expect-no-change)|`--force/.test(line));
    expect(code.length).toBeGreaterThanOrEqual(3);
    for (const line of code) expect(line, line).toContain('--decided-by');
  });

  it('the answer and retry tools point at run_execute to continue', async () => {
    const { TOOL_DESCRIPTIONS } = await import('../../src/cli/mcp-server.js');
    expect(TOOL_DESCRIPTIONS.task_answer).toContain('run_execute');
    expect(TOOL_DESCRIPTIONS.task_retry).toContain('run_execute');
  });
});

/** The one in-process round trip: what a model sees first, over a real MCP session. */
describe('an MCP session against the shipped guides', () => {
  async function session(): Promise<McpTestClient> {
    // The hub is never reached here: the guide tool and the resources are local reads.
    const server = createMcpServerForHub(DEFAULT_HUB_URL, root);
    return connectTestClient(server);
  }

  it('lists the tools, each with a description', async () => {
    const client = await session();
    const { tools } = await client.listTools();

    expect(tools.length).toBe(17);
    for (const tool of tools) expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(20);
  });

  it('serves the overview from flow_instructions, with the other guides named', async () => {
    const client = await session();

    const result = await client.callTool({ name: 'flow_instructions', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

    expect(result.isError).not.toBe(true);
    expect(text.startsWith(guideText('overview').trimEnd())).toBe(true);
    for (const guide of FLOW_GUIDES.filter((g) => g.key !== 'overview')) expect(text).toContain(guide.key);
  });

  it('serves a named guide verbatim', async () => {
    const client = await session();

    const result = await client.callTool({ name: 'flow_instructions', arguments: { key: 'gate' } });

    expect((result.content as Array<{ text: string }>)[0]?.text).toBe(guideText('gate').trimEnd());
  });

  it('lists every guide as a resource and reads one by its URI', async () => {
    const client = await session();

    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri).sort()).toEqual(FLOW_GUIDES.map((g) => g.uri).sort());

    const read = await client.readResource({ uri: 'agent-flow://flows/gate' });
    const content = read.contents[0];
    expect(content?.text).toBe(guideText('gate'));
    expect(content?.mimeType).toBe('text/markdown');
  });
});
