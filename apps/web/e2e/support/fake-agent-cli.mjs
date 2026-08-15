#!/usr/bin/env node
/**
 * A coding CLI that answers instantly, identically, and for free.
 *
 * The E2E suite has to cross the real architecture — browser, Fastify, the
 * application services, the StateStore, the filesystem — without spending a
 * token or depending on a network. The seam for that is the *executable*, not any
 * layer of ours: this script is spawned by the real `NodeProcessRunner`, its
 * output is parsed by the real `ClaudeCodeRunner` / `CodexRunner`, and everything
 * above those two adapters is production code running for real.
 *
 * It speaks both dialects, because the adapters differ in ways that matter and a
 * fake that only spoke one would let a plan review pass for "cross-provider"
 * while both sides were the same adapter:
 *
 *   - Claude Code: a JSON envelope on stdout, `structured_output` for a schema.
 *   - Codex: the answer written to the file named by `-o`, stdout ignored.
 *
 * What it answers is decided by the `ROLE: X_AGENT` line every shipped prompt
 * opens with — content, not call order. An order-indexed script would break the
 * moment a stage was cached or repeated, and would tell us nothing about which
 * stage got which answer.
 *
 * Environment:
 *   AF_FAKE_LOG   append one JSON line per invocation (dialect, role, argv)
 *   AF_FAKE_IMPL  `completed` (default) | `blocked` | `failed`
 *   AF_FAKE_HOLD  directory: park every implementation agent until released
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// the answers, declared before the flow that reads them
// ---------------------------------------------------------------------------

/**
 * Structurally complete, because `SDD_STAGE` validates it.
 *
 * Every section the validator demands is present and FR-001 is the only
 * functional requirement, so coverage arithmetic over the plans below is
 * something a reader can check by eye.
 */
const SDD = `# Software Design Document

## Context
A booking service with no repetition support.

## Problem
Bookings cannot repeat.

## Current Behavior
One booking, one date.

## Desired Behavior
A booking may repeat weekly.

## Functional Requirements
- FR-001: A booking may repeat weekly until an end date.

## Non-Functional Requirements
- NFR-001: Generation completes within 200ms.

## Architecture
A new recurrence module beside the booking store.

## Components Affected
The booking store.

## Database Changes
None. The store is in memory.

## API Changes
One new exported function.

## Frontend Changes
None. There is no user interface.

## Domain Changes
Adds the notion of a series.

## Contracts and Interfaces
weeklyDates({ startDate, endDate }) returns an array of dates.

## Security
- SEC-001: Only the owner may cancel an occurrence.

## Observability
No logging is added.

## Migration Strategy
No migration is needed; existing bookings gain a null series id.

## Testing Strategy
Unit tests for date expansion and cancellation.

## Edge Cases
An end date before the start date is rejected.

## Risks
Date arithmetic across daylight-saving boundaries.

## Alternatives Considered
Storing a rule instead of materialised occurrences.

## Acceptance Criteria
- A weekly rule produces the expected occurrences.
`;

const BASE_PLAN = {
  feature: 'weekly-recurrence',
  tasks: [
    {
      id: 'TASK-001',
      title: 'Add recurrence types',
      description: 'Domain types for a weekly series.',
      complexity: 'trivial',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['The types compile.'],
      validation: ['test'],
    },
    {
      id: 'TASK-002',
      title: 'Generate occurrences',
      description: 'Expand a weekly rule into dates.',
      complexity: 'normal',
      risk: 'medium',
      dependencies: ['TASK-001'],
      requirements: ['FR-001'],
      acceptanceCriteria: ['Occurrences are generated.'],
      validation: ['test'],
    },
  ],
};

/**
 * Two tasks with no edge between them, for the scenarios about *width*.
 *
 * `BASE_PLAN` is a chain, which is right for everything about ordering and useless
 * for everything about concurrency: two tasks in a chain cannot share a wave, so a
 * run of them at `maxTasks: 2` is indistinguishable from a sequential one. Same
 * ids and same titles, so a scenario can use either plan without rewriting its
 * selectors — the only difference is the edge.
 */
const INDEPENDENT_PLAN = {
  feature: 'weekly-recurrence',
  tasks: BASE_PLAN.tasks.map((task) => ({ ...task, dependencies: [] })),
};

/**
 * Two waves, and a fan-in — the shape M2-12 needs and neither plan above has.
 *
 * ```text
 * TASK-001 ─┐
 *           ├──> TASK-003
 * TASK-002 ─┘
 *
 * TASK-004 (independent)
 * ```
 *
 * `INDEPENDENT_PLAN` proves width and `BASE_PLAN` proves order, and each is blind
 * to what the other shows. Only a graph with both can be wrong about the thing
 * §14.2 and §4.3 actually promise: that a wave's base is the *previous wave's
 * integrated result*, so a task with dependencies starts from a tree that already
 * holds their work. A chain would prove it too, but only one dependency deep and
 * never against a sibling that finished in a different order.
 *
 * Three tasks are ready at once here rather than two, because a width of two is
 * the one number that cannot tell "as many as the plan allows" apart from "two".
 */
const WAVE_PLAN = {
  feature: 'weekly-recurrence',
  tasks: [
    { ...(BASE_PLAN.tasks[0]), dependencies: [] },
    { ...(BASE_PLAN.tasks[1]), dependencies: [] },
    {
      id: 'TASK-003',
      title: 'Compose the series',
      description: 'Read what the first two produced and compose them.',
      complexity: 'normal',
      risk: 'low',
      dependencies: ['TASK-001', 'TASK-002'],
      requirements: ['FR-001'],
      acceptanceCriteria: ['The composition names both inputs.'],
      validation: ['test'],
    },
    {
      id: 'TASK-004',
      title: 'Document the rule',
      description: 'Independent of everything above.',
      complexity: 'trivial',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['The rule is written down.'],
      validation: ['test'],
    },
  ],
};

/**
 * The plan a revision produces: a third task, and a new edge.
 *
 * Different in the graph rather than only in prose, so the DAG view has
 * something to be wrong about.
 */
const REVISED_PLAN = {
  feature: 'weekly-recurrence',
  tasks: [
    ...BASE_PLAN.tasks,
    {
      id: 'TASK-003',
      title: 'Cover the month boundary',
      description: 'A test for the last week of a month.',
      complexity: 'normal',
      risk: 'low',
      dependencies: ['TASK-002'],
      requirements: ['FR-001'],
      acceptanceCriteria: ['The boundary case is covered.'],
      validation: ['test'],
    },
  ],
};

/**
 * Two answers, and no third.
 *
 * There is no `STATUS: FAILED` here on purpose. Agent Flow does not take an
 * agent's word for having failed any more than it takes its word for having
 * succeeded — a task fails because the *process* failed or because validation
 * did. `AF_FAKE_IMPL=failed` therefore exits non-zero, which is what a real CLI
 * failure looks like, and the run halts for the reason it would really halt for.
 */
const IMPLEMENTATION = {
  completed: `Done.

## RESULT

STATUS: COMPLETED

FILES CHANGED:
- src/recurrence.js

VALIDATION:
- test: passed

DEVIATIONS:
- none

NOTES:
- none
`,

  blocked: `## RESULT

STATUS: BLOCKED

NOTES:
- The design document does not say where a series id belongs.
`,
};

// ---------------------------------------------------------------------------
// the flow
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  process.stdout.write('agent-flow-fake 1.0.0 (deterministic test double)\n');
  process.exit(0);
}

const prompt = await readStdin();
const role = /^ROLE:\s*([A-Z_]+)\s*$/m.exec(prompt)?.[1] ?? 'UNKNOWN';
// `exec` is the Codex subcommand; the Claude adapter never passes it.
const dialect = argv[0] === 'exec' ? 'codex' : 'claude';

// `sees` is the tree this invocation was actually given, as repository-relative
// names. §19.2 says final verification and review read the *integration* tree,
// and the only way to tell that from the user's checkout from outside is to ask
// what was in front of the agent: the composed work is on one and on no other.
log({ dialect, role, argv, sees: listing('src') });

/**
 * The task this invocation is about, from the task the prompt renders.
 *
 * Content, not call order — the same rule the role detection above follows, and
 * for the same reason: a stage that gets cached or repeated must not shift which
 * task an invocation believes it is. The task arrives as YAML (`toYaml(task)` in
 * the executor), and `id` is its first key, so the first `id:` line in the prompt
 * is the task's own.
 */
const task = /^\s*id:\s*"?([A-Za-z][\w-]*)"?\s*$/m.exec(prompt)?.[1] ?? 'UNKNOWN';
/** Set only when AF_FAKE_WRITE is on. What the RESULT then declares. */
let touched;

if (role === 'IMPLEMENTATION_AGENT') {
  // A real edit, in whatever directory the agent was spawned in. In worktree mode
  // that is the task's own isolated checkout, which is the whole point: with no
  // edit the attempt's tree equals its base, and then the marker, the merge and
  // the composed integration tree have nothing to be right about.
  //
  // Off by default, so every scenario written before this keeps its exact
  // behaviour and its exact `FILES CHANGED` line.
  if (process.env['AF_FAKE_WRITE'] !== undefined) {
    // `shared` makes every task write the same path with its own contents, which
    // is what a plan whose independence analysis was wrong actually looks like:
    // two markers created from a base that has neither, so the second merge is an
    // add/add conflict rather than something Git can resolve.
    touched =
      process.env['AF_FAKE_WRITE'] === 'shared'
        ? 'src/shared.txt'
        : `src/${task.toLowerCase()}.txt`;
    mkdirSync(dirname(touched), { recursive: true });

    // A dependent task **reads its dependencies' work before writing its own.**
    //
    // This is the assertion §4.3 cannot make from outside. A test can check that
    // wave 2's base contains wave 1's merges, but that only proves the commit
    // graph is the right shape; it does not prove the agent was given a checkout
    // of it. Here the agent fails on its own if the files are absent, and it
    // fails inside the attempt — which is exactly what a dependent task in a real
    // repository does when the barrier is broken.
    if (process.env['AF_FAKE_PLAN'] === 'wave' && task === 'TASK-003') {
      const inputs = ['src/task-001.txt', 'src/task-002.txt'];
      const missing = inputs.filter((path) => !existsSync(path));
      if (missing.length > 0) {
        process.stderr.write(
          `ERROR: {"status":500,"error":{"message":"the dependencies' work is not in this checkout: ${missing.join(
            ', ',
          )}"}}\n`,
        );
        process.exit(1);
      }
      touched = 'src/composed.txt';
      writeFileSync(
        touched,
        inputs.map((path) => readFileSync(path, 'utf8').trim()).join(' + ') + '\n',
      );
    } else {
      writeFileSync(touched, `${task} wrote this line\n`);
    }
  }

  // Parked on evidence, released on evidence. The marker file says "an agent is
  // inside this task right now" — the fact §21.2's live workspace is derived from
  // — and the release file is the test's hand on the clock. No sleep decides
  // anything on either side.
  const hold = process.env['AF_FAKE_HOLD'];
  // `AF_FAKE_HOLD_TASK` narrows the hold to one task. A run that parks every
  // agent can only be interrupted before anything has been integrated; parking
  // exactly one lets a scenario put the coordinator's death *after* a wave has
  // merged and *during* the next one, which is the state recovery has to
  // distinguish — completed work it must not touch, beside an attempt it must
  // requeue.
  const only = process.env['AF_FAKE_HOLD_TASK'];
  if (hold !== undefined && (only === undefined || only === task)) {
    writeFileSync(join(hold, `${task}.entered`), `${String(process.pid)}\n`);
    while (!existsSync(join(hold, 'release'))) pause(25);
  }
}

if (role === 'IMPLEMENTATION_AGENT' && process.env['AF_FAKE_IMPL'] === 'failed') {
  // A process that failed, in both dialects: a non-zero exit with an error
  // envelope. The adapters normalise this to `execution_failed`, which is not a
  // fallback trigger — a model that produced bad output must not be retried
  // elsewhere.
  process.stderr.write('ERROR: {"status":500,"error":{"message":"the change could not be applied"}}\n');
  process.exit(1);
}

const answer = answerFor(role, prompt);

if (dialect === 'codex') {
  const outputPath = argv[argv.indexOf('-o') + 1];
  if (outputPath === undefined) {
    process.stderr.write('ERROR: {"status":500,"error":{"message":"no -o path"}}\n');
    process.exit(1);
  }
  writeFileSync(outputPath, answer.body);
  // Deliberately noisy, and deliberately *not* an error line: codex's stderr is
  // the session transcript. If the adapter ever went back to scanning all of it
  // for failure wording, this is what would catch it.
  process.stderr.write(`[transcript] role=${role} bytes=${String(answer.body.length)}\n`);
  process.exit(0);
}

process.stdout.write(
  `${JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: answer.body,
    ...(answer.json === undefined ? {} : { structured_output: answer.json }),
    api_error_status: null,
  })}\n`,
);
process.exit(0);

// ---------------------------------------------------------------------------

/** @returns {{ body: string, json?: unknown }} */
function answerFor(agentRole, promptText) {
  switch (agentRole) {
    case 'DISCOVERY_AGENT':
      return { body: '# Architecture\n\nA single-module Node package with no framework.\n' };

    case 'ARCHITECTURE_IMPACT_AGENT':
      return { body: '# Architecture Impact\n\nOne new module beside the booking store.\n' };

    case 'SDD_AGENT':
      return { body: SDD };

    case 'PLANNING_AGENT': {
      // Content-driven, not order-driven: `revise` renders the instruction into
      // the same prompt, so the revised plan is chosen by what was asked for.
      const revised = /Revision requested by the reviewer/.test(promptText);
      const shape = process.env['AF_FAKE_PLAN'];
      const plan = revised
        ? REVISED_PLAN
        : shape === 'wave'
          ? WAVE_PLAN
          : shape === 'independent'
            ? INDEPENDENT_PLAN
            : BASE_PLAN;
      return { body: JSON.stringify(plan, null, 2), json: plan };
    }

    case 'PLAN_REVIEW_AGENT':
    case 'VERIFICATION_AGENT':
    case 'FINAL_REVIEW_AGENT': {
      const review = { verdict: 'PASS', summary: 'Matches the design.', findings: [] };
      return { body: JSON.stringify(review, null, 2), json: review };
    }

    case 'IMPLEMENTATION_AGENT': {
      const outcome = process.env['AF_FAKE_IMPL'] ?? 'completed';
      const body = IMPLEMENTATION[outcome] ?? IMPLEMENTATION.completed;
      // The declared file is the file that was actually written, when one was.
      // A result naming a file the agent did not touch is a fiction the marker
      // and the integration tree would then disagree with.
      return {
        body: touched === undefined ? body : body.replace('src/recurrence.js', touched),
      };
    }

    default:
      // Unparseable on purpose. A prompt this script does not recognise must fail
      // loudly as `invalid_output` rather than be answered with something plausible.
      return { body: `unrecognised prompt (role=${agentRole})` };
  }
}

/**
 * A synchronous pause, because this script has no event loop to wait on.
 *
 * The hold above is a blocking wait inside a child process whose whole job is to
 * be somewhere the test can observe. `Atomics.wait` is the only way to hold a
 * Node thread without spinning a CPU, and spinning one would compete with the
 * very coordinator the test is measuring.
 */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The files directly under `dir` in the current working directory, sorted. */
function listing(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    // No such directory is a normal answer — a checkout of the planning base has
    // none of this yet — and it is reported as the empty list rather than as an
    // error, because "the agent saw nothing there" is the fact being recorded.
    return [];
  }
}

function log(entry) {
  const path = process.env['AF_FAKE_LOG'];
  if (path === undefined) return;
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch {
    // A missing log directory must not fail the run being observed.
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      text += chunk;
    });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', () => resolve(text));
  });
}
