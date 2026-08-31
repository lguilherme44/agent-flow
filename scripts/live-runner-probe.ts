/**
 * The shipped adapters, against the servers they are for (PR-05, PRI-18).
 *
 * `docs/runner-capabilities.md` records what each *CLI* accepts, probed by hand. This
 * probes the layer above: the adapter Agent Flow actually invokes, through its real port,
 * against a real endpoint. The distinction matters because every failure the evidence runs
 * produced lived there — a CLI that accepts `--effort medium` behind a model that offers
 * only `low` and `high`, an envelope the adapter parses differently from the fixture.
 *
 * `openai-compatible` is the reason this exists. It ships, it has unit tests against a
 * stubbed `fetch`, and until now nothing had ever pointed it at a server. Its fixtures were
 * written from a specification rather than from a serialisation, which is the shape that
 * agrees with a bug.
 *
 *   node --experimental-strip-types scripts/live-runner-probe.ts
 *
 * Point it somewhere else with AF_PROBE_BASE_URL / AF_PROBE_MODEL / AF_PROBE_API_KEY.
 */

import { OpenAiRunner } from '../src/adapters/runners/openai-runner.ts';
import type { AgentRunResult } from '../src/ports/agent-runner.ts';

const BASE_URL = process.env['AF_PROBE_BASE_URL'] ?? 'http://127.0.0.1:8151/v1';
const MODEL = process.env['AF_PROBE_MODEL'] ?? 'moe';
const API_KEY = process.env['AF_PROBE_API_KEY'] ?? 'local';

const runner = new OpenAiRunner({ id: 'moe', baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL });

let failures = 0;

function report(name: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(42)} ${detail}`);
}

function describe(result: AgentRunResult): string {
  return result.ok
    ? `${String(result.durationMs)}ms · ${result.text.trim().slice(0, 48).replace(/\s+/g, ' ')}`
    : `${result.errorCode} · ${result.raw.slice(0, 64).replace(/\s+/g, ' ')}`;
}

console.log(`\n── openai-compatible, live against ${BASE_URL} (model: ${MODEL})\n`);

// 1. Health. `doctor` reports this, and an operator whose endpoint is down should learn it
//    here rather than from a stage that fails three minutes into a run.
const health = await runner.healthCheck();
report(
  'healthCheck reaches the server',
  health.installed && health.executable,
  `installed=${String(health.installed)} auth=${health.auth} version=${health.version ?? '—'}`,
);

// 2. Capabilities. Declared, not inferred — and the declaration is what the role resolver
//    gates on, so a wrong one is a run that fails at invocation.
const caps = runner.capabilities(MODEL);
report(
  'declares it cannot write or hold a cwd',
  !caps.supportsWorkingDirectory && !caps.nonInteractiveToolGrants.fileEdit,
  `cwd=${String(caps.supportsWorkingDirectory)} edit=${String(caps.nonInteractiveToolGrants.fileEdit)}`,
);

// 3. The happy path, through the adapter rather than through curl.
const plain = await runner.run({
  prompt: 'Reply with the single word: ok',
  reasoning: 'medium',
  workingDirectory: process.cwd(),
  permissions: 'read-only',
  timeoutSeconds: 300,
});
report('a plain prompt round-trips', plain.ok, describe(plain));

// 4. Structured output. The adapter reports `native`, which is a claim about the server —
//    and this endpoint is llama.cpp, not OpenAI. A claim nobody exercised is a guess.
const structured = await runner.run({
  prompt: 'Answer with the verdict PASS and one finding titled "none".',
  reasoning: 'medium',
  workingDirectory: process.cwd(),
  permissions: 'read-only',
  timeoutSeconds: 300,
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'findings'],
    properties: {
      verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
      findings: { type: 'array', items: { type: 'string' } },
    },
  },
});

const parsed = structured.ok ? structured.json : undefined;
report(
  'enforces an output schema, as it claims',
  structured.ok && parsed !== undefined,
  structured.ok
    ? `json=${JSON.stringify(parsed).slice(0, 72)}`
    : describe(structured),
);

// 5. A refused credential must arrive as `auth_required`, not as a generic failure. The
//    core branches on the code and never on the message (§22.1).
const unauthorised = new OpenAiRunner({
  id: 'moe-bad-key',
  baseUrl: BASE_URL,
  apiKey: 'definitely-not-the-key',
  model: MODEL,
});
const refused = await unauthorised.run({
  prompt: 'ok',
  reasoning: 'low',
  workingDirectory: process.cwd(),
  permissions: 'read-only',
  timeoutSeconds: 60,
});
report(
  'a bad key normalises to auth_required',
  !refused.ok && refused.errorCode === 'auth_required',
  describe(refused),
);

// 6. An unreachable server must be `runner_unavailable`, which is the class fallback is
//    allowed to route around (PRI-12). Anything else would make an outage look semantic.
const dead = new OpenAiRunner({
  id: 'moe-dead',
  baseUrl: 'http://127.0.0.1:9/v1',
  model: MODEL,
  timeoutSeconds: 5,
});
const unreachable = await dead.run({
  prompt: 'ok',
  reasoning: 'low',
  workingDirectory: process.cwd(),
  permissions: 'read-only',
  timeoutSeconds: 5,
});
report(
  'an unreachable server is runner_unavailable',
  !unreachable.ok && unreachable.errorCode === 'runner_unavailable',
  describe(unreachable),
);

console.log(
  failures === 0
    ? '\n✓ the adapter behaves against a real server the way its unit tests say\n'
    : `\n✗ ${String(failures)} check(s) failed — the fixtures and the server disagree\n`,
);

process.exit(failures === 0 ? 0 : 1);
