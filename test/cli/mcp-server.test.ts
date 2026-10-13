import { describe, it, expect } from 'vitest';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { FetchHubClient, type FetchLike } from '../../src/adapters/hub/fetch-hub-client.js';
import { resolveGuidesDir } from '../../src/app/prompt-paths.js';
import {
  RUN_DESCRIPTION_MAX_LENGTH,
  TOOL_DESCRIPTIONS,
  createAgentFlowMcpServer,
  describeHubFailure,
  type RequestFileOutcome,
} from '../../src/cli/mcp-server.js';
import { en } from '../../src/core/phrases/index.js';
import { SECOND_PERSON_OBSERVING } from '../fakes/second-person.js';
import { connectTestClient, type McpTestClient } from '../fakes/mcp-test-client.js';

/**
 * The MCP tools, driven through a minimal MCP client over the server package's in-memory
 * transport, with the network replaced by a fake `fetch` behind the real hub adapter.
 *
 * So each assertion covers the whole path a model's call takes — the tool's input schema,
 * the handler, the HTTP request the hub would receive — and the only thing faked is the
 * socket. What is asserted is the request: method, URL, body and the two header facts
 * (client header present, no `Origin`) the hub's channel record depends on.
 */

const HUB = 'http://127.0.0.1:4782';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type Answer = { status: number; body?: unknown; raw?: string } | Error;

const PROJECTS = [
  { id: 'api', name: 'api', path: 'C:\\wk\\api' },
  { id: 'web', name: 'web', path: 'C:\\wk\\web' },
];

/**
 * What a current hub answers: the projects for `GET /projects`, and for a write that carried
 * `decidedBy`, the decision echoed back as recorded (with the channel the hub derived) — in
 * `detail` for a synchronous action and at the top for a job, as the hub does.
 */
function currentHub(call: Call): Answer {
  if (call.method === 'GET' && call.url.endsWith('/api/v1/projects')) return { status: 200, body: PROJECTS };
  const given = (call.body as { decidedBy?: Record<string, string> } | undefined)?.decidedBy;
  if (given === undefined) return { status: 200, body: { ok: true } };
  const recorded = { ...given, channel: 'api' };
  return { status: 200, body: { runId: RUN, warnings: [], decidedBy: recorded, detail: { decidedBy: recorded } } };
}

function hub(answer: (call: Call) => Answer = currentHub) {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    const call: Call = {
      url,
      method: init.method,
      headers: { ...init.headers },
      body: init.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
    };
    calls.push(call);
    const reply = answer(call);
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve({
      status: reply.status,
      ok: reply.status < 300,
      text: () => Promise.resolve(reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body))),
    });
  };
  return { client: new FetchHubClient({ baseUrl: HUB, fetch }), calls };
}

interface FileWorld {
  readonly files?: Record<string, string>;
  readonly refusals?: Record<string, string>;
  readonly roots?: string[][];
}

async function connect(hubClient: FetchHubClient, world: FileWorld = {}): Promise<McpTestClient> {
  const server = createAgentFlowMcpServer({
    hub: hubClient,
    guides: { fs: new NodeFileSystem(), guidesDir: resolveGuidesDir() },
    readRequestFile: (path, projectDirs): Promise<RequestFileOutcome> => {
      world.roots?.push([...projectDirs]);
      const refusal = world.refusals?.[path];
      if (refusal !== undefined) return Promise.resolve({ ok: false, message: refusal });
      const text = world.files?.[path];
      return Promise.resolve(
        text === undefined ? { ok: false, message: `could not read ${path}` } : { ok: true, text },
      );
    },
    version: '0.0.0-test',
  });
  return connectTestClient(server);
}

interface ToolOutcome {
  readonly isError: boolean;
  readonly text: string;
}

/**
 * A tool call as the model sees it. An input that fails the tool's schema may come back as
 * an `isError` result or as a rejected call; both are "refused before the handler ran", so
 * both are folded into one outcome here.
 */
async function call(client: McpTestClient, name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  try {
    const result = await client.callTool({ name, arguments: args });
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    return { isError: result.isError === true, text: content.map((part) => part.text ?? '').join('\n') };
  } catch (error) {
    return { isError: true, text: error instanceof Error ? error.message : String(error) };
  }
}

const RUN = 'AF-2026-001';
const DECIDED = { by: 'Luis', words: 'aprovado' };

const READ_ONLY_TOOLS = [
  'flow_instructions',
  'project_list',
  'run_list',
  'run_status',
  'run_timeline',
  'job_status',
  'gate_get',
  'run_artifacts',
];

describe('the tool list', () => {
  it('is exactly the tools of the design', async () => {
    const client = await connect(hub().client);
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        ...READ_ONLY_TOOLS,
        'run_start',
        'gate_decide',
        'task_answer',
        'task_retry',
        'run_control',
        'run_cancel',
        'run_complete',
        'run_execute',
        'review_run',
      ].sort(),
    );
  });

  it('marks the reads read-only, cancel destructive, and nothing else read-only', async () => {
    const client = await connect(hub().client);
    const { tools } = await client.listTools();
    const hints = (name: string) =>
      (tools.find((tool) => tool.name === name) as { annotations?: Record<string, unknown> } | undefined)
        ?.annotations ?? {};

    for (const name of READ_ONLY_TOOLS) expect(hints(name)['readOnlyHint'], name).toBe(true);
    expect(hints('run_cancel')['destructiveHint']).toBe(true);
    // Terminal, and over a Definition of Done that did not hold: a client should confirm it.
    expect(hints('run_complete')['destructiveHint']).toBe(true);
    for (const tool of tools.filter((entry) => !READ_ONLY_TOOLS.includes(entry.name))) {
      expect(hints(tool.name)['readOnlyHint'], tool.name).not.toBe(true);
    }
  });

  it('keeps cancel out of run_control: it has its own tool, which asks the human first', async () => {
    const client = await connect(hub().client);
    const { tools } = await client.listTools();
    const control = JSON.stringify(tools.find((tool) => tool.name === 'run_control')?.inputSchema);

    expect(control).toContain('pause');
    expect(control).not.toContain('cancel');
    expect(TOOL_DESCRIPTIONS.run_cancel).toMatch(/ask the human/i);
    expect(TOOL_DESCRIPTIONS.run_cancel).toMatch(/not reversible|irreversible/i);
  });
});

describe('each tool is one hub request', () => {
  const cases: Array<{
    tool: string;
    args: Record<string, unknown>;
    method: string;
    url: string;
    body: unknown;
  }> = [
    { tool: 'project_list', args: {}, method: 'GET', url: '/api/v1/projects', body: undefined },
    { tool: 'run_list', args: { projectId: 'api' }, method: 'GET', url: '/api/v1/runs?projectId=api', body: undefined },
    {
      tool: 'run_status',
      args: { projectId: 'api', runId: RUN },
      method: 'GET',
      url: `/api/v1/runs/${RUN}?projectId=api`,
      body: undefined,
    },
    {
      tool: 'run_timeline',
      args: { projectId: 'api', runId: RUN },
      method: 'GET',
      url: `/api/v1/runs/${RUN}/timeline?projectId=api`,
      body: undefined,
    },
    { tool: 'job_status', args: { jobId: 'job-0007' }, method: 'GET', url: '/api/v1/jobs/job-0007', body: undefined },
    {
      tool: 'gate_get',
      args: { projectId: 'api', runId: RUN },
      method: 'GET',
      url: `/api/v1/runs/${RUN}/approval?projectId=api`,
      body: undefined,
    },
    {
      tool: 'run_artifacts',
      args: { projectId: 'api', runId: RUN },
      method: 'GET',
      url: `/api/v1/runs/${RUN}/artifacts?projectId=api`,
      body: undefined,
    },
    {
      tool: 'run_artifacts',
      args: { projectId: 'api', runId: RUN, artifact: 'sdd' },
      method: 'GET',
      url: `/api/v1/runs/${RUN}/artifacts/sdd?projectId=api`,
      body: undefined,
    },
    {
      tool: 'run_start',
      args: { projectId: 'api', description: 'Story 1: do the thing', grounded: true },
      method: 'POST',
      url: '/api/v1/runs?projectId=api',
      body: { description: 'Story 1: do the thing', grounded: true },
    },
    {
      tool: 'gate_decide',
      args: { projectId: 'api', runId: RUN, decision: 'approve', decidedBy: DECIDED },
      method: 'POST',
      url: `/api/v1/runs/${RUN}/approve?projectId=api`,
      body: { decidedBy: DECIDED },
    },
    {
      tool: 'gate_decide',
      args: { projectId: 'api', runId: RUN, decision: 'reject', decidedBy: DECIDED, instruction: 'wrong scope' },
      method: 'POST',
      url: `/api/v1/runs/${RUN}/reject?projectId=api`,
      body: { decidedBy: DECIDED, reason: 'wrong scope' },
    },
    {
      tool: 'gate_decide',
      args: { projectId: 'api', runId: RUN, decision: 'revise', decidedBy: DECIDED, instruction: 'split TASK-002' },
      method: 'POST',
      url: `/api/v1/runs/${RUN}/revise?projectId=api`,
      body: { instruction: 'split TASK-002', decidedBy: DECIDED },
    },
    {
      tool: 'task_answer',
      args: { projectId: 'api', runId: RUN, taskId: 'TASK-002', answer: 'use the v2 endpoint', decidedBy: DECIDED },
      method: 'POST',
      url: `/api/v1/runs/${RUN}/tasks/TASK-002/answer?projectId=api`,
      body: { text: 'use the v2 endpoint', decidedBy: DECIDED },
    },
    {
      tool: 'task_retry',
      args: { projectId: 'api', runId: RUN, taskId: 'TASK-002' },
      method: 'POST',
      url: `/api/v1/runs/${RUN}/tasks/TASK-002/retry?projectId=api`,
      body: {},
    },
    {
      tool: 'task_retry',
      args: { projectId: 'api', runId: RUN, taskId: 'FIX-001', force: true, expectNoChange: true, decidedBy: DECIDED },
      method: 'POST',
      url: `/api/v1/runs/${RUN}/tasks/FIX-001/retry?projectId=api`,
      body: { force: true, expectNoChange: true, decidedBy: DECIDED },
    },
    {
      tool: 'run_execute',
      args: { projectId: 'api', runId: RUN },
      method: 'POST',
      url: `/api/v1/runs/${RUN}/start?projectId=api`,
      body: undefined,
    },
    ...(['pause', 'resume'] as const).map((action) => ({
      tool: 'run_control',
      args: { projectId: 'api', runId: RUN, action },
      method: 'POST',
      url: `/api/v1/runs/${RUN}/${action}?projectId=api`,
      body: undefined,
    })),
    {
      tool: 'run_cancel',
      args: { projectId: 'api', runId: RUN, decidedBy: DECIDED },
      method: 'POST',
      url: `/api/v1/runs/${RUN}/cancel?projectId=api`,
      body: { decidedBy: DECIDED },
    },
    {
      tool: 'run_complete',
      args: { projectId: 'api', runId: RUN, decidedBy: DECIDED, pr: 'https://example.test/pr/1' },
      method: 'POST',
      url: `/api/v1/runs/${RUN}/complete?projectId=api`,
      body: { decidedBy: DECIDED, pr: 'https://example.test/pr/1' },
    },
    {
      tool: 'review_run',
      args: { projectId: 'api', runId: RUN },
      method: 'POST',
      url: `/api/v1/runs/${RUN}/review?projectId=api`,
      body: {},
    },
    {
      tool: 'review_run',
      args: {
        projectId: 'api',
        runId: RUN,
        fix: true,
        e2eObserved: 'the banner showed on the phone',
        observedBy: 'Luis',
        e2eHead: 'abc1234',
      },
      method: 'POST',
      url: `/api/v1/runs/${RUN}/review?projectId=api`,
      body: { fix: true, e2eObserved: 'the banner showed on the phone', observedBy: 'Luis', e2eHead: 'abc1234' },
    },
    {
      tool: 'review_run',
      args: { projectId: 'api', runId: RUN, e2eObserved: 'saw it', observedBy: 'Luis', evidence: ['/shots/a.png'] },
      method: 'POST',
      url: `/api/v1/runs/${RUN}/review?projectId=api`,
      body: { e2eObserved: 'saw it', observedBy: 'Luis', evidence: ['/shots/a.png'] },
    },
  ];

  it.each(cases)('$tool → $method $url', async ({ tool, args, method, url, body }) => {
    const { client: hubClient, calls } = hub();
    const client = await connect(hubClient);

    const outcome = await call(client, tool, args);

    expect(outcome.isError, outcome.text).toBe(false);
    expect(calls).toHaveLength(1);
    const sent = calls[0];
    expect(sent?.method).toBe(method);
    expect(sent?.url).toBe(`${HUB}${url}`);
    expect(sent?.body).toEqual(body);
    expect(sent?.headers['x-agent-flow-client']).toBe('mcp');
    expect(Object.keys(sent?.headers ?? {}).map((name) => name.toLowerCase())).not.toContain('origin');
  });

  it('returns the hub answer to the model as JSON', async () => {
    const { client: hubClient } = hub(() => ({ status: 202, body: { id: 'job-0003', status: 'running' } }));
    const client = await connect(hubClient);

    const outcome = await call(client, 'run_start', { projectId: 'api', description: 'x' });

    expect(JSON.parse(outcome.text)).toEqual({ id: 'job-0003', status: 'running' });
  });

  it('run_start reads a request file inside the registered projects or the temp dir', async () => {
    const { client: hubClient, calls } = hub();
    const roots: string[][] = [];
    const client = await connect(hubClient, { files: { 'request.md': '# Story\n\nbody\n' }, roots });

    const outcome = await call(client, 'run_start', { projectId: 'api', file: 'request.md' });

    expect(outcome.isError, outcome.text).toBe(false);
    // The registered project directories come from the hub, so the file guard can contain it.
    expect(roots).toEqual([PROJECTS.map((project) => project.path)]);
    expect(calls.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      `GET ${HUB}/api/v1/projects`,
      `POST ${HUB}/api/v1/runs?projectId=api`,
    ]);
    expect(calls[1]?.body).toEqual({ description: '# Story\n\nbody\n' });
  });

  it('run_start relays the file guard refusal and sends no run', async () => {
    const { client: hubClient, calls } = hub();
    const client = await connect(hubClient, { refusals: { 'C:\\secrets.txt': 'outside every registered project' } });

    const outcome = await call(client, 'run_start', { projectId: 'api', file: 'C:\\secrets.txt' });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('outside every registered project');
    expect(calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
  });

  it('run_start refuses both or neither of description and file, and an unreadable file', async () => {
    const { client: hubClient, calls } = hub();
    const client = await connect(hubClient);

    expect((await call(client, 'run_start', { projectId: 'api' })).isError).toBe(true);
    expect((await call(client, 'run_start', { projectId: 'api', description: 'x', file: 'a.md' })).isError).toBe(true);
    const missing = await call(client, 'run_start', { projectId: 'api', file: 'missing.md' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('missing.md');
    expect(calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
  });
});

describe('human decisions need the human', () => {
  it('refuses gate_decide without decidedBy, and sends nothing', async () => {
    const { client: hubClient, calls } = hub();
    const client = await connect(hubClient);

    const outcome = await call(client, 'gate_decide', { projectId: 'api', runId: RUN, decision: 'approve' });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/decidedBy/);
    expect(calls).toHaveLength(0);
  });

  it.each(['task_answer', 'run_cancel', 'run_complete'])('refuses %s without decidedBy, and sends nothing', async (tool) => {
    const { client: hubClient, calls } = hub();
    const client = await connect(hubClient);

    const outcome = await call(client, tool, { projectId: 'api', runId: RUN, taskId: 'TASK-001', answer: 'x' });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/decidedBy/);
    expect(calls).toHaveLength(0);
  });

  it.each([{ force: true }, { expectNoChange: true }])(
    'refuses task_retry with %j and no decidedBy: an override is the human’s',
    async (override) => {
      const { client: hubClient, calls } = hub();
      const client = await connect(hubClient);

      const outcome = await call(client, 'task_retry', { projectId: 'api', runId: RUN, taskId: 'TASK-001', ...override });

      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain('decidedBy');
      expect(calls).toHaveLength(0);
    },
  );

  it('sends a forced retry with the human, and a plain retry without one', async () => {
    const { client: hubClient, calls } = hub();
    const client = await connect(hubClient);

    const forced = await call(client, 'task_retry', {
      projectId: 'api',
      runId: RUN,
      taskId: 'TASK-001',
      force: true,
      decidedBy: DECIDED,
    });
    const plain = await call(client, 'task_retry', { projectId: 'api', runId: RUN, taskId: 'TASK-001', decidedBy: DECIDED });

    expect(forced.isError, forced.text).toBe(false);
    expect(plain.isError, plain.text).toBe(false);
    expect(calls.map((entry) => entry.body)).toEqual([{ force: true, decidedBy: DECIDED }, {}]);
  });

  it('does not call a repeat cancel a stale hub: nothing new was decided', async () => {
    const already = (): Answer => ({
      status: 200,
      body: { runId: RUN, warnings: [], detail: { alreadyCancelled: true, interrupted: [] } },
    });
    const client = await connect(hub(already).client);

    const outcome = await call(client, 'run_cancel', { projectId: 'api', runId: RUN, decidedBy: DECIDED });

    expect(outcome.isError, outcome.text).toBe(false);
  });

  it.each([
    [{ by: '', words: 'aprovado' }],
    [{ by: '   ', words: 'aprovado' }],
    [{ by: 'Luis', words: '' }],
    [{ by: 'Luis' }],
  ])('refuses a decidedBy without a name or words (%j)', async (decidedBy) => {
    const { client: hubClient, calls } = hub();
    const client = await connect(hubClient);

    const outcome = await call(client, 'gate_decide', { projectId: 'api', runId: RUN, decision: 'approve', decidedBy });

    expect(outcome.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('refuses an approve that carries an instruction: that is a revise', async () => {
    const { client: hubClient, calls } = hub();
    const client = await connect(hubClient);

    const outcome = await call(client, 'gate_decide', {
      projectId: 'api',
      runId: RUN,
      decision: 'approve',
      decidedBy: DECIDED,
      instruction: 'but rename the table',
    });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('revise');
    expect(calls).toHaveLength(0);
  });

  it('refuses a revise with no instruction', async () => {
    const { client: hubClient, calls } = hub();
    const client = await connect(hubClient);

    const outcome = await call(client, 'gate_decide', { projectId: 'api', runId: RUN, decision: 'revise', decidedBy: DECIDED });

    expect(outcome.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('sends the model on to run_execute after an approval, not to a terminal', () => {
    expect(TOOL_DESCRIPTIONS.gate_decide).toContain('run_execute');
    expect(TOOL_DESCRIPTIONS.gate_decide).not.toMatch(/not an MCP tool/);
  });

  it('run_execute names its precondition and the next steps', () => {
    expect(TOOL_DESCRIPTIONS.run_execute).toMatch(/approved/);
    expect(TOOL_DESCRIPTIONS.run_execute).toContain('gate_decide');
    for (const next of ['run_status', 'job_status', 'review_run']) expect(TOOL_DESCRIPTIONS.run_execute).toContain(next);
  });

  it.each(['run_execute', 'gate_decide', 'run_cancel'])('%s takes no force', async (name) => {
    const { tools } = await (await connect(hub().client)).listTools();
    const schema = JSON.stringify(tools.find((tool) => tool.name === name)?.inputSchema);
    expect(schema).toContain('runId');
    expect(schema).not.toContain('force');
  });

  it('says in the tool description that the name and words are the human’s, never invented', () => {
    expect(TOOL_DESCRIPTIONS.gate_decide).toMatch(/never invented/);
    expect(TOOL_DESCRIPTIONS.gate_decide).toMatch(/exact words/);
    expect(TOOL_DESCRIPTIONS.gate_decide).toMatch(/channel api/);
    expect(TOOL_DESCRIPTIONS.task_answer).toMatch(/decidedBy/);
  });

  it('refuses an e2e observation without the human who made it', async () => {
    const { client: hubClient, calls } = hub();
    const client = await connect(hubClient);

    const outcome = await call(client, 'review_run', { projectId: 'api', runId: RUN, e2eObserved: 'it worked' });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('observedBy');
    expect(calls).toHaveLength(0);
  });
});

/**
 * A hub built before decisions were echoed applies the decision and records no name: the
 * MCP server cannot tell the human "recorded as yours" then, and says what to do instead.
 */
describe('a hub that did not record the decision', () => {
  const olderHub = (entry: Call): Answer =>
    entry.method === 'GET' ? { status: 200, body: PROJECTS } : { status: 200, body: { runId: RUN, warnings: [] } };

  it.each([
    ['gate_decide', { projectId: 'api', runId: RUN, decision: 'approve', decidedBy: DECIDED }],
    ['gate_decide', { projectId: 'api', runId: RUN, decision: 'revise', decidedBy: DECIDED, instruction: 'x' }],
    ['task_answer', { projectId: 'api', runId: RUN, taskId: 'TASK-001', answer: 'x', decidedBy: DECIDED }],
    ['run_cancel', { projectId: 'api', runId: RUN, decidedBy: DECIDED }],
  ] as const)('%s says so, and how to fix it', async (tool, args) => {
    const client = await connect(hub(olderHub).client);

    const outcome = await call(client, tool, args);

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('did not record the decision');
    expect(outcome.text).toContain('`agent-flow ui`');
  });

  it('positive control: a hub that echoes the decision is not flagged', async () => {
    const client = await connect(hub().client);

    const outcome = await call(client, 'gate_decide', { projectId: 'api', runId: RUN, decision: 'approve', decidedBy: DECIDED });

    expect(outcome.isError, outcome.text).toBe(false);
  });
});

describe('the API caps, said before anything is sent', () => {
  it('takes a run_start request exactly at the cap', async () => {
    const { client: hubClient, calls } = hub();
    const client = await connect(hubClient);

    const outcome = await call(client, 'run_start', { projectId: 'api', description: 'x'.repeat(RUN_DESCRIPTION_MAX_LENGTH) });

    expect(outcome.isError, outcome.text).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('refuses a run_start request over the cap and names the CLI --file', async () => {
    const { client: hubClient, calls } = hub();
    const client = await connect(hubClient, { files: { 'long.md': 'y'.repeat(RUN_DESCRIPTION_MAX_LENGTH + 1) } });

    for (const args of [
      { projectId: 'api', description: 'x'.repeat(RUN_DESCRIPTION_MAX_LENGTH + 1) },
      { projectId: 'api', file: 'long.md' },
    ]) {
      const outcome = await call(client, 'run_start', args);
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain('agent-flow feature --file');
      expect(outcome.text).toContain(String(RUN_DESCRIPTION_MAX_LENGTH));
    }
    expect(calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
  });

  it('is the cap the hub parses', () => {
    expect(RUN_DESCRIPTION_MAX_LENGTH).toBe(8_000);
  });

  it('refuses a revise instruction and an answer over 4000 characters, naming the CLI', async () => {
    const { client: hubClient, calls } = hub();
    const client = await connect(hubClient);
    const long = 'z'.repeat(4_001);

    const revise = await call(client, 'gate_decide', {
      projectId: 'api',
      runId: RUN,
      decision: 'revise',
      decidedBy: DECIDED,
      instruction: long,
    });
    expect(revise.isError).toBe(true);
    expect(revise.text).toContain('agent-flow revise --file');

    const answer = await call(client, 'task_answer', {
      projectId: 'api',
      runId: RUN,
      taskId: 'TASK-003',
      answer: long,
      decidedBy: DECIDED,
    });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('agent-flow answer TASK-003 --file');

    expect(calls).toHaveLength(0);
  });
});

describe('hub failures, in words a model can act on', () => {
  async function failing(answer: Answer, tool = 'run_status', args: Record<string, unknown> = { projectId: 'api', runId: RUN }) {
    const { client: hubClient } = hub(() => answer);
    const client = await connect(hubClient);
    return call(client, tool, args);
  }

  it('hub down: names the URL and how to start it, and starts nothing', async () => {
    const outcome = await failing(new TypeError('fetch failed'));

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain(`not reachable at ${HUB}`);
    expect(outcome.text).toContain('agent-flow ui --no-open');
    expect(outcome.text).toContain('autostart');
  });

  it.each([
    [400, 'bad_request'],
    [404, 'not_found'],
    [409, 'run_busy'],
  ])('a %i is a refusal, with the API code and message', async (status, code) => {
    const outcome = await failing({ status, body: { error: code, message: 'the reason', action: 'wait for it' } });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain(`The hub refused (HTTP ${String(status)} ${code}): the reason.`);
    expect(outcome.text).toContain('wait for it');
    expect(outcome.text).not.toMatch(/\bat \S+\.(ts|js):\d+/);
  });

  it('frames the hub suggestion as the human’s to act on, with a real refusal', async () => {
    // Real sentences the hub sends when approve is refused: their "approve deliberately" is
    // an override only a human may choose, and a model reading it bare would take it as a step.
    const outcome = await failing({
      status: 409,
      body: {
        error: 'review_failed',
        message: en.actions.reviewFailedWith(2),
        action: en.actions.requestRevisionAddressing,
        forcible: true,
      },
    });

    expect(outcome.text).toContain(en.actions.reviewFailedWith(2));
    const framing = outcome.text.indexOf('for the human');
    expect(framing).toBeGreaterThan(-1);
    expect(outcome.text).toMatch(/ask (them|the human) before acting on it/);
    expect(outcome.text.indexOf(en.actions.requestRevisionAddressing)).toBeGreaterThan(framing);
  });

  it('a 409 run_busy names the job already running, so the model can poll it', async () => {
    const outcome = await failing({
      status: 409,
      body: { error: 'run_busy', message: 'busy', detail: { jobId: 'job-0042', kind: 'start' } },
    });

    expect(outcome.text).toContain('job-0042');
    expect(outcome.text).toContain('job_status');
  });

  it('a 500 is the hub failing, distinguishable from a refusal', async () => {
    const outcome = await failing({ status: 500, body: { error: 'internal', message: 'boom' } });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('The hub failed (HTTP 500 internal): boom');
    expect(outcome.text).not.toContain('refused');
  });

  it('a 2xx that is not JSON is not an agent-flow hub', async () => {
    const outcome = await failing({ status: 200, raw: '<html>router login</html>' });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain(`Not an agent-flow hub at ${HUB}`);
  });

  it('a run_start that timed out points at run_list: there is no run id to ask about', () => {
    const text = describeHubFailure({ kind: 'timeout', url: HUB, timeoutMs: 60_000 }, { afterRunStart: true });

    expect(text).toContain('run_list');
    expect(text).not.toContain('run_status');
  });
});

/**
 * The reader of every one of these strings is a model. A sentence telling it to observe the
 * change itself is how an AI ends up attesting its own work — `SECOND_PERSON_OBSERVING` is
 * the check the NOT_RUN lines are held to, reused here on every description and error,
 * including errors built from the hub's real refusal sentences.
 */
describe('nothing tells the model to observe or decide on its own', () => {
  async function everyTextTheModelReads(): Promise<string[]> {
    const client = await connect(hub(() => new TypeError('fetch failed')).client);
    const { tools } = await client.listTools();
    const descriptions = tools.map((tool) => JSON.stringify({ d: tool.description, s: tool.inputSchema }));
    const real = [
      [en.actions.reviewFailedWith(3), en.actions.requestRevisionAddressing],
      [en.actions.planWasRejected, en.actions.revisePlanOrApproveOver],
      [en.actions.planNotReviewed, en.actions.runReviewOrApproveOver],
      [en.actions.reviewJudgedAnother, en.actions.requestRevisionOrApprove],
    ] as const;
    const failures = [
      describeHubFailure({ kind: 'unreachable', url: HUB, reason: 'ECONNREFUSED' }),
      describeHubFailure({ kind: 'timeout', url: HUB, timeoutMs: 60_000 }),
      describeHubFailure({ kind: 'timeout', url: HUB, timeoutMs: 60_000 }, { afterRunStart: true }),
      describeHubFailure({ kind: 'not_hub', url: HUB, status: 200 }),
      describeHubFailure({ kind: 'http_error', status: 409, error: 'run_busy', message: 'm', detail: { jobId: 'job-0001' } }),
      describeHubFailure({ kind: 'http_error', status: 500, error: 'internal', message: 'm' }),
      ...real.map(([message, action]) =>
        describeHubFailure({ kind: 'http_error', status: 409, error: 'review_failed', message, action }),
      ),
    ];
    const refusals = [
      await call(client, 'run_start', { projectId: 'api' }),
      await call(client, 'run_start', { projectId: 'api', description: 'x'.repeat(9_000) }),
      await call(client, 'gate_decide', { projectId: 'api', runId: RUN, decision: 'revise', decidedBy: DECIDED }),
      await call(client, 'gate_decide', {
        projectId: 'api',
        runId: RUN,
        decision: 'approve',
        decidedBy: DECIDED,
        instruction: 'x',
      }),
      await call(client, 'review_run', { projectId: 'api', runId: RUN, e2eObserved: 'x' }),
    ].map((outcome) => outcome.text);
    const stale = await call(
      await connect(hub(() => ({ status: 200, body: { runId: RUN, warnings: [] } })).client),
      'run_cancel',
      { projectId: 'api', runId: RUN, decidedBy: DECIDED },
    );
    return [...descriptions, ...failures, ...refusals, stale.text];
  }

  it('in any tool description, hub failure or refusal', async () => {
    const texts = await everyTextTheModelReads();

    expect(texts.length).toBeGreaterThan(25);
    for (const text of texts) expect(text).not.toMatch(SECOND_PERSON_OBSERVING);
  });

  it('positive control: the check sees a sentence that does', () => {
    expect('exercise the change on the target yourself').toMatch(SECOND_PERSON_OBSERVING);
    expect('record what you saw').toMatch(SECOND_PERSON_OBSERVING);
  });
});

/**
 * Dogfood 08–09/10: `project_list` answered 118–134 KB — every request text in full — and blew
 * the client's response limit; `run_list` is worse, every run of a project in full. A listing
 * names things; the request is read with run_status.
 */
describe('the listings stay small (dogfood 08–09/10)', () => {
  const LONG = `${'Contexto: lojistas migrados do AbasteceShop. '.repeat(400)}fim`;
  const runs = Array.from({ length: 45 }, (_, index) => ({
    runId: `AF-2026-${String(index + 1).padStart(3, '0')}`,
    status: 'completed',
    feature: LONG,
  }));
  const bigHub = (call: Call): Answer => {
    if (call.url.endsWith('/api/v1/projects')) {
      return { status: 200, body: PROJECTS.map((project) => ({ ...project, lastRun: { runId: RUN, feature: LONG } })) };
    }
    if (call.url.includes('/api/v1/runs?')) return { status: 200, body: runs };
    return { status: 200, body: {} };
  };

  it('project_list carries one line of each last request, not the request', async () => {
    const client = await connect(hub(bigHub).client);

    const outcome = await call(client, 'project_list');

    expect(outcome.isError, outcome.text).toBe(false);
    expect(outcome.text.length).toBeLessThan(2_000);
    expect(outcome.text).toContain('Contexto: lojistas migrados');
    expect(outcome.text).toContain('api');
  });

  it('run_list pages, says how many there are, and shortens each request', async () => {
    const client = await connect(hub(bigHub).client);

    const first = JSON.parse((await call(client, 'run_list', { projectId: 'api' })).text) as {
      total: number;
      runs: Array<{ runId: string; feature: string }>;
    };
    expect(first.total).toBe(45);
    expect(first.runs).toHaveLength(20);
    for (const run of first.runs) expect(run.feature.length).toBeLessThanOrEqual(161);

    const last = JSON.parse((await call(client, 'run_list', { projectId: 'api', offset: 40, limit: 20 })).text) as {
      runs: Array<{ runId: string }>;
    };
    expect(last.runs.map((run) => run.runId)).toEqual(['AF-2026-041', 'AF-2026-042', 'AF-2026-043', 'AF-2026-044', 'AF-2026-045']);
  });
});
