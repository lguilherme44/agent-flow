import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  AnswerRequestSchema,
  ApproveRequestSchema,
  CancelRequestSchema,
  CompleteRequestSchema,
  JobParamsSchema,
  PlanRequestSchema,
  ProjectIdSchema,
  RejectRequestSchema,
  RetryRequestSchema,
  ReviewRequestSchema,
  ReviseRequestSchema,
  RunIdParamSchema,
  TaskIdParamSchema,
} from '../contracts/api.schema.js';
import { ArtifactNameSchema } from '../contracts/common.schema.js';
import {
  GATE_DECISION_ACTIONS,
  GateDecisionSchema,
  HumanDecisionSchema,
} from '../contracts/human-decision.schema.js';
import { loadFlowGuide, type FlowGuideLoaderDeps } from '../app/flow-guide-loader.js';
import { DEFAULT_FLOW_GUIDE, FLOW_GUIDES } from '../core/flow-guides.js';
import type { HubClient, HubRequest, HubResponse } from '../ports/hub-client.js';

/**
 * agent-flow's operations as MCP tools: a thin client of the hub (Etapa 1, Passo 3).
 *
 * **Every tool is one request to the hub `agent-flow ui` serves, and nothing else.** No
 * use case is called from here and no run state is read or written: the hub is the one
 * owner of the state, so its validation, its caps and its run execution lock apply to an
 * AI exactly as to the Deck, and a decision relayed through here is recorded with channel
 * `api` — the channel the Deck shows in a warning tone. The only local reads are the guide
 * registry, which is shipped text, and the request file `run_start` may name, under a guard.
 *
 * Every word below is read by a model, not a person. Each description says the
 * precondition and the likely next step, and every decision it mentions is the human's to
 * make: the model asks, and relays their name and their words. None of it may tell the
 * model to observe or decide on its own (`test/fakes/second-person.ts`).
 */

/** The request file's text, or the sentence that says why it was not read. */
export type RequestFileOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string };

export interface AgentFlowMcpDeps {
  readonly hub: HubClient;
  readonly guides: FlowGuideLoaderDeps;
  /**
   * Reads the request file `run_start` names, only from under one of `projectDirs` (the
   * directories the hub serves) or the temp directory (`cli/mcp-request-file.ts`).
   */
  readonly readRequestFile: (path: string, projectDirs: readonly string[]) => Promise<RequestFileOutcome>;
  readonly version: string;
}

const projectId = ProjectIdSchema.describe('the project id, from project_list');
const runId = RunIdParamSchema.describe('the run id, like AF-2026-001');
const taskId = TaskIdParamSchema.describe('the task id, like TASK-001');
const decidedBy = HumanDecisionSchema.describe(
  'the human who decided (by) and their exact words (words), as they said them; ask the human for both',
);

/** The plan request's cap, read from the schema the hub parses so the two cannot drift. */
export const RUN_DESCRIPTION_MAX_LENGTH = PlanRequestSchema.shape.description.maxLength ?? 8_000;

/** The decision the gate tool records, with the precondition that it is the human's. */
const GATE_DECIDE_DESCRIPTION =
  "Record the human's plan-gate decision: approve, revise or reject. Only after gate_get, " +
  'and only once the human decided in this conversation. decidedBy is their name and their ' +
  'exact words, never invented or paraphrased; the run records them with channel api. ' +
  'revise needs instruction (the change, quoting the human); reject takes instruction as the ' +
  'reason. No force here: an approval over a refusal is the human’s to make at the CLI. ' +
  'Next after approve: run_execute.';

/** Tool name → description. Exported so a test can hold every one to the wording rule. */
export const TOOL_DESCRIPTIONS = {
  flow_instructions:
    'Read an agent-flow operator guide. Call first with no key (the overview), then the ' +
    'guide for the moment the run is in: feature, gate, blocked, recover, done.',
  project_list:
    'List the projects the agent-flow hub serves, with their ids. Every run tool takes a ' +
    'projectId from here. A repository missing from the list has no .agent-flow/config.yaml: ' +
    'run `agent-flow init` in it (flow_instructions feature).',
  run_start:
    'Start planning a feature: creates a run and plans it as a background job (minutes). ' +
    'Precondition: no active run in the project (run_list). Pass the story and its ' +
    `refinement as description, or file (a local path under the project or the temp directory, ` +
    `at most 32 KB); at most ${String(RUN_DESCRIPTION_MAX_LENGTH)} characters, longer requests ` +
    'go through the CLI `agent-flow feature --file`. Next: job_status with the returned id, ' +
    'then run_status until waiting_for_approval.',
  run_list:
    'List the runs of a project, newest first, with status and one line of each request. Paged: ' +
    'limit (default 20) and offset; the answer has total, runs and next. Next: run_status for one of them.',
  run_status:
    'Read a run: status, stages, tasks, the last plan-gate decision (gateDecision) and the ' +
    'operator actions with their channel. Status waiting_for_approval: gate_get. A task ' +
    'BLOCKED or failed: flow_instructions blocked.',
  run_timeline: "Read where a run's wall clock went: model, validation, waiting, rework.",
  job_status:
    'Read a background job (planning, revise, execution, resume, review) by its id: running, ' +
    'or ended with a summary or an error. Poll it after a tool answered with a job.',
  gate_get:
    'Read the plan gate of a run in waiting_for_approval: canApprove, refusal, warnings and ' +
    'the plan review. Next: run_artifacts for the plan and the SDD, present them to the human ' +
    'and ask them to approve, revise or reject, and for their name (flow_instructions gate).',
  run_artifacts:
    "List a run's documents, or read one: request, sdd, plan, the reviews. Use it to present " +
    'the plan and the SDD at the gate; show the human the gaps, not only a summary.',
  gate_decide: GATE_DECIDE_DESCRIPTION,
  task_answer:
    "Answer what a BLOCKED task asked, with the human's answer, and queue it again. Ask the " +
    'human first; never answer with a guess. decidedBy is their name and exact words, ' +
    'recorded with channel api. Next: run_execute carries the answer to the task.',
  task_retry:
    'Queue a failed task again. force (a BLOCKED task, or past the attempt limit) and ' +
    'expectNoChange (the task is meant to change nothing) overrule a gate: only when the ' +
    'human chose them, with decidedBy (their name and exact words). Next: run_execute.',
  run_execute:
    "Execute a run's approved plan, as a background job (minutes to hours). Precondition: the " +
    "plan is approved (gate_decide approve, with the human's name and words) and nothing is " +
    'executing the run (409 run_busy otherwise: wait). Next: job_status with the returned id ' +
    'and run_status for the tasks; once every task is done, review_run. A BLOCKED task: ' +
    'flow_instructions blocked. CLI alternative: `agent-flow run` in the repository root.',
  run_control:
    'pause (stop starting work; the task in flight finishes) or resume (a job: continue the ' +
    'approved plan). Cancelling is run_cancel.',
  run_cancel:
    'Cancel a run: ends it and interrupts its agents, keeping every artifact. Not reversible. ' +
    'Ask the human first, and only on their explicit decision; decidedBy is their name and ' +
    'exact words, recorded with channel api. A paused run is resumed with run_control instead.',
  run_complete:
    'Close a run whose last review ended NOT DONE, when the human accepts the delivery as it is ' +
    '(a PR opened outside agent-flow, an e2e they checked by hand). Not reversible. Ask the human ' +
    'first, show them what the review found missing (run_status), and only on their explicit ' +
    'decision; decidedBy is their name and exact words. pr: where the delivery is. Refused ' +
    'until a review has concluded on the work as it stands (review_run).',
  review_run:
    'Judge a run whose tasks are done: verification, e2e, final review and the Definition of ' +
    'Done, as a job. The run is done only when the job summary reads "Definition of Done ' +
    'satisfied". e2eObserved and observedBy: only what the human saw the change do on the ' +
    'target, in their words, with their name; e2eHead: the build they tested. fix: turn the ' +
    'findings into corrective tasks.',
} as const;

export type McpToolName = keyof typeof TOOL_DESCRIPTIONS;

/**
 * Hints an MCP client uses to decide what to confirm. The reads are read-only; a cancel is
 * destructive. Every other write is marked non-destructive explicitly, because MCP reads an
 * absent `destructiveHint` on a write as true, and a client that confirmed every poll-worthy
 * action would teach the human to click through the one that matters.
 */
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

export function createAgentFlowMcpServer(deps: AgentFlowMcpDeps): McpServer {
  const server = new McpServer({ name: 'agent-flow', version: deps.version });
  const send = (request: HubRequest, options: RelayOptions = {}) => relay(deps.hub, request, options);
  const scoped = (id: string) => ({ projectId: id });
  const decision = { recordsDecision: true } as const;

  const guideKeys = FLOW_GUIDES.map((guide) => guide.key) as [string, ...string[]];

  server.registerTool(
    'flow_instructions',
    {
      description: TOOL_DESCRIPTIONS.flow_instructions,
      inputSchema: z.object({ key: z.enum(guideKeys).optional().describe('the guide; omit for the overview') }),
      annotations: READ_ONLY,
    },
    async ({ key }) => {
      const outcome = await loadFlowGuide(deps.guides, key ?? DEFAULT_FLOW_GUIDE);
      if (!outcome.ok) return failure(outcome.error.message);
      let text = outcome.value.text.trimEnd();
      if (key === undefined) {
        const others = FLOW_GUIDES.filter((guide) => guide.key !== DEFAULT_FLOW_GUIDE).map((g) => g.key);
        text += `\n\nOther guides: ${others.join(', ')} — call flow_instructions with that key.`;
      }
      return success(text);
    },
  );

  for (const guide of FLOW_GUIDES) {
    server.registerResource(
      guide.key,
      guide.uri,
      { title: guide.name, description: guide.description, mimeType: 'text/markdown' },
      async (uri) => {
        const outcome = await loadFlowGuide(deps.guides, guide.key);
        if (!outcome.ok) throw new Error(outcome.error.message);
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: outcome.value.text }] };
      },
    );
  }

  server.registerTool(
    'project_list',
    { description: TOOL_DESCRIPTIONS.project_list, annotations: READ_ONLY },
    () => send({ method: 'GET', path: '/projects' }, { shape: compactProjects }),
  );

  server.registerTool(
    'run_start',
    {
      description: TOOL_DESCRIPTIONS.run_start,
      inputSchema: z.object({
        projectId,
        // No cap here on purpose: over the cap, the model needs the sentence that names the
        // CLI, not the schema validator's "too big".
        description: z.string().optional().describe('the request: story, refinement, link'),
        file: z
          .string()
          .min(1)
          .optional()
          .describe(
            'a local file holding the request instead, under the project or the temp directory; ' +
              'an absolute path, or relative to where the MCP server started',
          ),
        workflow: PlanRequestSchema.shape.workflow.describe('only when the human asked for a class'),
        skipReview: PlanRequestSchema.shape.skipReview.describe('only when the human asked for it'),
        noCache: PlanRequestSchema.shape.noCache,
        grounded: PlanRequestSchema.shape.grounded.describe(
          'the request already carries a code investigation',
        ),
      }),
      annotations: WRITE,
    },
    async (args) => {
      if ((args.description === undefined) === (args.file === undefined)) {
        return failure('Not sent: pass exactly one of description or file.');
      }
      let text: string;
      if (args.file !== undefined) {
        // The directories the guard accepts are the hub's, asked now: the MCP server keeps no
        // list of its own, and a project registered a minute ago is one of them.
        const projects = await deps.hub.send({ method: 'GET', path: '/projects' });
        if (projects.kind !== 'ok') return failure(describeHubFailure(projects));
        const read = await deps.readRequestFile(args.file, projectPaths(projects.body));
        if (!read.ok) return failure(read.message);
        text = read.text;
      } else {
        text = args.description ?? '';
      }
      const length = text.trim().length;
      if (length > RUN_DESCRIPTION_MAX_LENGTH) {
        return failure(
          `Not sent: the request is ${String(length)} characters and the hub takes at most ` +
            `${String(RUN_DESCRIPTION_MAX_LENGTH)}. Start this run from the CLI in the repository ` +
            'root instead: `agent-flow feature --file <path>`.',
        );
      }
      const body = {
        description: text,
        ...(args.workflow === undefined ? {} : { workflow: args.workflow }),
        ...(args.skipReview ? { skipReview: true } : {}),
        ...(args.noCache ? { noCache: true } : {}),
        ...(args.grounded ? { grounded: true } : {}),
      };
      const invalid = invalidBody(PlanRequestSchema, body);
      if (invalid !== undefined) return failure(invalid);
      return send({ method: 'POST', path: '/runs', query: scoped(args.projectId), body }, { afterRunStart: true });
    },
  );

  server.registerTool(
    'run_list',
    {
      description: TOOL_DESCRIPTIONS.run_list,
      inputSchema: z.object({
        projectId,
        limit: z.number().int().min(1).max(100).optional().describe(`runs per page (default ${String(RUN_PAGE)})`),
        offset: z.number().int().min(0).optional().describe('runs to skip, newest first'),
      }),
      annotations: READ_ONLY,
    },
    (args) =>
      send(
        { method: 'GET', path: '/runs', query: scoped(args.projectId) },
        { shape: (body) => pageOfRuns(body, args.offset ?? 0, args.limit ?? RUN_PAGE) },
      ),
  );

  server.registerTool(
    'run_status',
    { description: TOOL_DESCRIPTIONS.run_status, inputSchema: z.object({ projectId, runId }), annotations: READ_ONLY },
    (args) => send({ method: 'GET', path: `/runs/${args.runId}`, query: scoped(args.projectId) }),
  );

  server.registerTool(
    'run_timeline',
    { description: TOOL_DESCRIPTIONS.run_timeline, inputSchema: z.object({ projectId, runId }), annotations: READ_ONLY },
    (args) => send({ method: 'GET', path: `/runs/${args.runId}/timeline`, query: scoped(args.projectId) }),
  );

  server.registerTool(
    'job_status',
    {
      description: TOOL_DESCRIPTIONS.job_status,
      inputSchema: z.object({ jobId: JobParamsSchema.shape.jobId.describe('the job id, like job-0001') }),
      annotations: READ_ONLY,
    },
    (args) => send({ method: 'GET', path: `/jobs/${args.jobId}` }),
  );

  server.registerTool(
    'gate_get',
    { description: TOOL_DESCRIPTIONS.gate_get, inputSchema: z.object({ projectId, runId }), annotations: READ_ONLY },
    (args) => send({ method: 'GET', path: `/runs/${args.runId}/approval`, query: scoped(args.projectId) }),
  );

  server.registerTool(
    'run_artifacts',
    {
      description: TOOL_DESCRIPTIONS.run_artifacts,
      inputSchema: z.object({
        projectId,
        runId,
        artifact: ArtifactNameSchema.optional().describe('the document to read; omit to list them'),
      }),
      annotations: READ_ONLY,
    },
    (args) =>
      send({
        method: 'GET',
        path: `/runs/${args.runId}/artifacts${args.artifact === undefined ? '' : `/${args.artifact}`}`,
        query: scoped(args.projectId),
      }),
  );

  server.registerTool(
    'gate_decide',
    {
      description: TOOL_DESCRIPTIONS.gate_decide,
      inputSchema: z.object({
        projectId,
        runId,
        decision: z.enum(GATE_DECISION_ACTIONS),
        decidedBy,
        instruction: z
          .string()
          .optional()
          .describe('revise: the change, quoting the human (required); reject: the reason'),
      }),
      // A reject closes the run; a client may ask before any gate move, which is right.
      annotations: { ...WRITE, destructiveHint: true },
    },
    (args) => {
      const path = `/runs/${args.runId}/${args.decision}`;
      const query = scoped(args.projectId);

      if (args.decision === 'approve') {
        // Refused rather than dropped: "approve, but change X" is a revision, and silently
        // approving the plan without X would record a decision the human did not make.
        if (args.instruction !== undefined) {
          return failure('Not sent: approve takes no instruction. An approval with a change is a revise.');
        }
        const body = { decidedBy: args.decidedBy };
        const invalid = invalidBody(ApproveRequestSchema, body);
        return invalid === undefined ? send({ method: 'POST', path, query, body }, decision) : failure(invalid);
      }

      if (args.decision === 'reject') {
        const body = {
          decidedBy: args.decidedBy,
          ...(args.instruction === undefined ? {} : { reason: args.instruction }),
        };
        const invalid = invalidBody(RejectRequestSchema, body, '`agent-flow reject "<reason>"`');
        return invalid === undefined ? send({ method: 'POST', path, query, body }, decision) : failure(invalid);
      }

      if (args.instruction === undefined) {
        return failure('Not sent: revise needs instruction — the change the human asked for.');
      }
      const body = { instruction: args.instruction, decidedBy: args.decidedBy };
      const invalid = invalidBody(ReviseRequestSchema, body, '`agent-flow revise --file <path>`');
      return invalid === undefined ? send({ method: 'POST', path, query, body }, decision) : failure(invalid);
    },
  );

  server.registerTool(
    'task_answer',
    {
      description: TOOL_DESCRIPTIONS.task_answer,
      inputSchema: z.object({
        projectId,
        runId,
        taskId,
        answer: z.string().describe("the human's answer to what the task asked"),
        decidedBy,
      }),
      annotations: WRITE,
    },
    (args) => {
      const body = { text: args.answer, decidedBy: args.decidedBy };
      const invalid = invalidBody(AnswerRequestSchema, body, `\`agent-flow answer ${args.taskId} --file <path>\``);
      if (invalid !== undefined) return failure(invalid);
      return send(
        {
          method: 'POST',
          path: `/runs/${args.runId}/tasks/${args.taskId}/answer`,
          query: scoped(args.projectId),
          body,
        },
        decision,
      );
    },
  );

  server.registerTool(
    'task_retry',
    {
      description: TOOL_DESCRIPTIONS.task_retry,
      inputSchema: z.object({
        projectId,
        runId,
        taskId,
        force: RetryRequestSchema.shape.force,
        expectNoChange: RetryRequestSchema.shape.expectNoChange,
        decidedBy: decidedBy
          .optional()
          .describe('required with force or expectNoChange: the human who chose it and their exact words'),
      }),
      annotations: WRITE,
    },
    (args) => {
      const override = args.force || args.expectNoChange;
      if (override && args.decidedBy === undefined) {
        return failure(
          'Not sent: force and expectNoChange overrule a gate, so they need decidedBy — the name ' +
            'and exact words of the human who chose them. Ask the human; without an override, ' +
            'a plain retry needs no name.',
        );
      }
      return send(
        {
          method: 'POST',
          path: `/runs/${args.runId}/tasks/${args.taskId}/retry`,
          query: scoped(args.projectId),
          body: {
            ...(args.force ? { force: true } : {}),
            ...(args.expectNoChange ? { expectNoChange: true } : {}),
            // Sent only with an override: a plain retry is not a decision, and the hub records none.
            ...(override ? { decidedBy: args.decidedBy } : {}),
          },
        },
        override ? decision : {},
      );
    },
  );

  server.registerTool(
    'run_control',
    {
      description: TOOL_DESCRIPTIONS.run_control,
      inputSchema: z.object({ projectId, runId, action: z.enum(['pause', 'resume']) }),
      annotations: WRITE,
    },
    (args) =>
      send({ method: 'POST', path: `/runs/${args.runId}/${args.action}`, query: scoped(args.projectId) }),
  );

  // Its own tool rather than a third `run_control` action: irreversible, so it carries the
  // human's name and words like a gate move, and a client can mark it destructive.
  server.registerTool(
    'run_cancel',
    {
      description: TOOL_DESCRIPTIONS.run_cancel,
      inputSchema: z.object({ projectId, runId, decidedBy }),
      annotations: DESTRUCTIVE,
    },
    (args) => {
      const body = { decidedBy: args.decidedBy };
      const invalid = invalidBody(CancelRequestSchema, body);
      if (invalid !== undefined) return failure(invalid);
      return send({ method: 'POST', path: `/runs/${args.runId}/cancel`, query: scoped(args.projectId), body }, decision);
    },
  );

  // Closing a run the Definition of Done did not: terminal, so a human decision and
  // destructive like cancel. The rules (a concluded review, the lease) are the use case's.
  server.registerTool(
    'run_complete',
    {
      description: TOOL_DESCRIPTIONS.run_complete,
      inputSchema: z.object({
        projectId,
        runId,
        decidedBy,
        pr: z.string().optional().describe('Where the delivery made outside agent-flow is (a PR URL).'),
      }),
      annotations: DESTRUCTIVE,
    },
    (args) => {
      const body = { decidedBy: args.decidedBy, ...(args.pr === undefined ? {} : { pr: args.pr }) };
      const invalid = invalidBody(CompleteRequestSchema, body);
      if (invalid !== undefined) return failure(invalid);
      return send({ method: 'POST', path: `/runs/${args.runId}/complete`, query: scoped(args.projectId), body }, decision);
    },
  );

  // `POST /start` with no body: the whole plan, as `agent-flow run`. Its one field, `taskId`
  // (`agent-flow task`), is left out — the design names a run, not a task. The approval and
  // "not already executing" gates are the use case's, so a refusal comes back as the job's
  // error or as 409, never decided here.
  server.registerTool(
    'run_execute',
    { description: TOOL_DESCRIPTIONS.run_execute, inputSchema: z.object({ projectId, runId }), annotations: WRITE },
    (args) => send({ method: 'POST', path: `/runs/${args.runId}/start`, query: scoped(args.projectId) }),
  );

  server.registerTool(
    'review_run',
    {
      description: TOOL_DESCRIPTIONS.review_run,
      inputSchema: z.object({
        projectId,
        runId,
        fix: ReviewRequestSchema.shape.fix,
        e2eObserved: ReviewRequestSchema.shape.e2eObserved.describe(
          "the human's own words: what they saw the change do on the target",
        ),
        observedBy: ReviewRequestSchema.shape.observedBy.describe('the human who observed it'),
        e2eHead: ReviewRequestSchema.shape.e2eHead.describe('the commit of the build the human tested'),
        evidence: z
          .array(z.string())
          .optional()
          .describe("absolute paths of the human's screenshots on this machine (no network paths); copied into the run"),
      }),
      annotations: WRITE,
    },
    (args) => {
      const body = {
        ...(args.fix ? { fix: true } : {}),
        ...(args.e2eObserved === undefined ? {} : { e2eObserved: args.e2eObserved }),
        ...(args.observedBy === undefined ? {} : { observedBy: args.observedBy }),
        ...(args.e2eHead === undefined ? {} : { e2eHead: args.e2eHead }),
        ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
      };
      const invalid = invalidBody(ReviewRequestSchema, body);
      if (invalid !== undefined) return failure(invalid);
      return send({ method: 'POST', path: `/runs/${args.runId}/review`, query: scoped(args.projectId), body });
    },
  );

  return server;
}

interface RelayOptions {
  /** The request carries a human decision the hub must echo back as recorded. */
  readonly recordsDecision?: true;
  /** A `run_start`: a timeout leaves no run id to ask about. */
  readonly afterRunStart?: true;
  /** What the model is shown of the answer, when not all of it (a listing). */
  readonly shape?: (body: unknown) => unknown;
}

/** One hub request, its answer in words a model can act on. */
async function relay(hub: HubClient, request: HubRequest, options: RelayOptions): Promise<CallToolResult> {
  const response = await hub.send(request);
  if (response.kind !== 'ok') return failure(describeHubFailure(response, options));
  const json = JSON.stringify(options.shape === undefined ? response.body : options.shape(response.body), null, 2);
  if (options.recordsDecision === true && !recordedDecision(response.body)) {
    return failure(
      'The hub applied the request but did not record the decision — it is probably an older ' +
        'build; restart it (`agent-flow ui`). Tell the human their name and words are not on the ' +
        `run for this action. The hub answered:\n${json}`,
    );
  }
  return success(json);
}

/**
 * Whether the hub echoed the decision it recorded, in `detail.decidedBy` (a synchronous
 * action) or `decidedBy` (a job). A hub built before it did applies the action and drops
 * the name, so the absence is the evidence — not something to assume around.
 */
function recordedDecision(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const shaped = body as {
    decidedBy?: unknown;
    detail?: { decidedBy?: unknown; alreadyCancelled?: unknown; alreadyCompleted?: unknown };
  };
  // A repeat cancel or complete records nothing, so a current hub echoes nothing: not a stale hub.
  if (shaped.detail?.alreadyCancelled === true || shaped.detail?.alreadyCompleted === true) return true;
  return (
    GateDecisionSchema.safeParse(shaped.detail?.decidedBy).success ||
    GateDecisionSchema.safeParse(shaped.decidedBy).success
  );
}

/**
 * The listings, as a model should read them (dogfood 08–09/10).
 *
 * The hub answers with each run's request in full — the Deck shows it — and `project_list`
 * came back at 118–134 KB, past the client's response limit, before the model had chosen a
 * project. A listing names things: one line of each request is enough to recognise a run, and
 * `run_status` reads the whole of it. Shaped here, so the Deck keeps every word.
 */
const RUN_PAGE = 20;
const SUMMARY_CHARS = 160;

function summarise(text: unknown): unknown {
  if (typeof text !== 'string') return text;
  const line = text.trim().split(/\r?\n/, 1)[0] ?? '';
  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS)}…` : line;
}

function withSummary(entry: unknown): unknown {
  if (typeof entry !== 'object' || entry === null) return entry;
  const record = entry as Record<string, unknown>;
  return 'feature' in record ? { ...record, feature: summarise(record['feature']) } : record;
}

function compactProjects(body: unknown): unknown {
  if (!Array.isArray(body)) return body;
  return body.map((project: unknown) => {
    if (typeof project !== 'object' || project === null) return project;
    const record = project as Record<string, unknown>;
    return 'lastRun' in record ? { ...record, lastRun: withSummary(record['lastRun']) } : record;
  });
}

function pageOfRuns(body: unknown, offset: number, limit: number): unknown {
  if (!Array.isArray(body)) return body;
  return {
    total: body.length,
    offset,
    runs: body.slice(offset, offset + limit).map(withSummary),
    ...(offset + limit < body.length ? { next: { offset: offset + limit, limit } } : {}),
  };
}

/** The project directories out of `GET /projects`, for the request-file guard. */
function projectPaths(body: unknown): string[] {
  if (!Array.isArray(body)) return [];
  return body
    .map((project) => (project as { path?: unknown }).path)
    .filter((path): path is string => typeof path === 'string' && path !== '');
}

/**
 * The failure, said so that the next step is clear: the hub down is fixed by starting it,
 * a 4xx by changing the request or waiting for the run, a 5xx by telling the human.
 *
 * **The hub's own suggestion is framed as the human's.** Its refusals are written for a
 * person at the Deck — "approve over the verdict deliberately" — and relayed bare to a model
 * they read as the next step. So the message is quoted as what happened, and the action is
 * handed on as something to put to the human. Exported so a test can hold every one of
 * these sentences to the wording rule, with the hub's real refusal phrases.
 */
export function describeHubFailure(
  response: Exclude<HubResponse, { kind: 'ok' }>,
  options: { readonly afterRunStart?: boolean } = {},
): string {
  switch (response.kind) {
    case 'unreachable':
      return (
        `agent-flow hub not reachable at ${response.url} (${response.reason}). Start it with ` +
        '`agent-flow ui --no-open`, or check the logon autostart with `agent-flow autostart status`; ' +
        'then call this tool again.'
      );
    case 'timeout': {
      const waited = `agent-flow hub at ${response.url} did not answer within ${String(Math.round(response.timeoutMs / 1000))} s.`;
      if (options.afterRunStart === true) {
        return (
          `${waited} The run may have been created, and there is no run id yet: read run_list for ` +
          'the project before starting another.'
        );
      }
      return `${waited} The request may have been applied: read run_status or job_status before repeating it.`;
    }
    case 'not_hub':
      return (
        `Not an agent-flow hub at ${response.url}: it answered HTTP ${String(response.status)} with ` +
        'something that is not JSON. Check the URL `agent-flow mcp --hub` (or AGENT_FLOW_HUB_URL) ' +
        'points at, and that `agent-flow ui` is what listens there.'
      );
    case 'http_error': {
      const suggestion =
        response.action === undefined
          ? ''
          : ` Its suggestion is for the human — ask them before acting on it: "${response.action.trim()}"`;
      const jobId = response.detail?.['jobId'];
      const busy =
        typeof jobId === 'string'
          ? ` A job is already running on this run: ${jobId}. Poll job_status with it instead of repeating the call.`
          : '';
      if (response.status >= 500) {
        return (
          `The hub failed (HTTP ${String(response.status)} ${response.error}): ${sentence(response.message)}` +
          `${suggestion}${busy} Tell the human; do not repeat the call in a loop.`
        );
      }
      return `The hub refused (HTTP ${String(response.status)} ${response.error}): ${sentence(response.message)}${suggestion}${busy}`;
    }
  }
}

/** The API's sentences mostly end in a full stop; the ones that do not get one. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Why a body would be refused, said before it is sent; `undefined` when the hub's own schema
 * accepts it. Over a cap, `cli` names the CLI command that takes the text from a file.
 */
function invalidBody(schema: z.ZodType, body: unknown, cli?: string): string | undefined {
  const parsed = schema.safeParse(body);
  if (parsed.success) return undefined;
  const issue = parsed.error.issues[0];
  if (issue === undefined) return 'Not sent: the hub would refuse this request.';
  const field = issue.path.join('.');
  if (issue.code === 'too_big' && cli !== undefined) {
    return (
      `Not sent: ${field} is over the hub's limit of ${String(issue.maximum)} characters. ` +
      `Use the CLI in the repository root instead: ${cli}.`
    );
  }
  return `Not sent: ${field === '' ? '' : `${field}: `}${issue.message}.`;
}

function success(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function failure(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
