/**
 * What one run can tell you about itself, and what it cannot.
 *
 * `agent-flow status` answers "where is this run"; this answers "what did it cost, where
 * did the time go, and which of my questions has no answer in the record". It reads
 * `events.jsonl` and the attempt artifacts and nothing else — the same files a person
 * would open, so a gap it reports is a gap in the product rather than in this script.
 *
 * Written for live dogfood, where the interesting output is the list at the end: every
 * question an operator asks after a real run that the evidence cannot answer.
 *
 *   node --experimental-strip-types scripts/run-observability.ts <projectDir> [runId]
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface Event {
  readonly at: string;
  readonly type: string;
  readonly detail: Record<string, unknown>;
}

interface StageSpan {
  stage: string;
  role?: string;
  runner?: string;
  model?: string;
  startedAt?: number;
  finishedAt?: number;
  repairs?: number;
  errorCode?: string;
  failureClass?: string;
  contextBytes?: number;
}

const ms = (value: string): number => Date.parse(value);
const seconds = (value: number): string => `${(value / 1000).toFixed(1)}s`;

async function newestRun(runsDir: string): Promise<string> {
  const entries = await readdir(runsDir);
  const runs = entries.filter((name) => /^AF-\d{4}-\d{3}$/.test(name)).sort();
  const newest = runs.at(-1);
  if (newest === undefined) throw new Error(`no runs in ${runsDir}`);
  return newest;
}

async function main(): Promise<void> {
  const projectDir = process.argv[2];
  if (projectDir === undefined) throw new Error('usage: run-observability.ts <projectDir> [runId]');
  const runsDir = join(projectDir, '.agent-flow', 'runs');
  const runId = process.argv[3] ?? (await newestRun(runsDir));
  const runDir = join(runsDir, runId);

  const events: Event[] = (await readFile(join(runDir, 'events.jsonl'), 'utf8'))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Event);

  const first = events[0];
  const last = events.at(-1);
  const state = JSON.parse(await readFile(join(runDir, 'state.json'), 'utf8')) as Record<string, unknown>;

  console.log(`# ${runId} · ${String(state['status'])}`);
  console.log(`feature: ${String(state['feature'] ?? '').slice(0, 100)}`);
  if (first !== undefined && last !== undefined) {
    console.log(`wall clock: ${seconds(ms(last.at) - ms(first.at))} · ${String(events.length)} events`);
  }

  // ---- Where the time went -------------------------------------------------
  const spans = new Map<string, StageSpan>();
  const span = (name: string): StageSpan => {
    const found = spans.get(name) ?? { stage: name };
    spans.set(name, found);
    return found;
  };

  let modelCalls = 0;
  for (const event of events) {
    const stage = String(event.detail['stage'] ?? '');
    if (event.type === 'stage_started' && stage !== '') span(stage).startedAt = ms(event.at);
    if (event.type === 'stage_output_received') modelCalls += 1;
    if (event.type === 'stage_context_measured' && stage !== '') {
      const total = Number(event.detail['totalBytes'] ?? event.detail['bytes'] ?? 0);
      if (total > 0) span(stage).contextBytes = total;
    }
    if (event.type === 'stage_completed' || event.type === 'stage_failed') {
      if (stage === '') continue;
      const entry = span(stage);
      entry.finishedAt = ms(event.at);
      entry.role = String(event.detail['role'] ?? entry.role ?? '');
      entry.runner = String(event.detail['runner'] ?? entry.runner ?? '');
      if (typeof event.detail['model'] === 'string') entry.model = event.detail['model'];
      if (typeof event.detail['repairs'] === 'number') entry.repairs = event.detail['repairs'];
      if (typeof event.detail['errorCode'] === 'string') entry.errorCode = event.detail['errorCode'];
      if (typeof event.detail['failureClass'] === 'string') entry.failureClass = event.detail['failureClass'];
    }
  }

  console.log('\n## Stages');
  for (const entry of spans.values()) {
    const took = entry.startedAt !== undefined && entry.finishedAt !== undefined
      ? seconds(entry.finishedAt - entry.startedAt)
      : '—';
    const context = entry.contextBytes === undefined ? '' : ` · ${(entry.contextBytes / 1024).toFixed(1)} KB in`;
    const repairs = entry.repairs === undefined || entry.repairs <= 1 ? '' : ` · ${String(entry.repairs)} repairs`;
    const failed = entry.failureClass === undefined ? '' : ` · FAILED ${entry.failureClass}`;
    console.log(`  ${entry.stage.padEnd(22)} ${took.padStart(8)}  ${entry.runner ?? '?'}${entry.model === undefined ? '' : `/${entry.model}`}${context}${repairs}${failed}`);
  }

  // ---- What the agents were asked to do, and what came back ----------------
  const tasksDir = join(runDir, 'tasks');
  let attempts = 0;
  let noChange = 0;
  console.log('\n## Tasks');
  try {
    for (const taskId of (await readdir(tasksDir)).sort()) {
      const files = (await readdir(join(tasksDir, taskId))).filter((name) => name.startsWith('attempt-'));
      for (const file of files.sort()) {
        attempts += 1;
        const artifact = JSON.parse(await readFile(join(tasksDir, taskId, file), 'utf8')) as Record<string, unknown>;
        const report = artifact['agentReport'] as { status?: string; claimedFilesChanged?: string[] } | undefined;
        const changed = (artifact['filesChanged'] as string[] | undefined) ?? [];
        if (changed.length === 0) noChange += 1;
        console.log(`  ${taskId} ${file.replace('.json', '').padEnd(11)} agent=${report?.status ?? '?'} files=${String(changed.length)}`);
      }
    }
  } catch {
    console.log('  (no task artifacts)');
  }

  // ---- The questions the record cannot answer ------------------------------
  const has = (type: string): boolean => events.some((event) => event.type === type);
  const gaps: string[] = [];
  if (!events.some((event) => typeof event.detail['model'] === 'string')) {
    gaps.push('Which model ran each stage — no event carries one, so a run cannot be attributed to a model after the fact.');
  }
  if (!has('stage_context_measured')) {
    gaps.push('How large each prompt was, and from which source.');
  }
  if (!events.some((event) => typeof event.detail['tokens'] === 'number' || typeof event.detail['inputTokens'] === 'number')) {
    gaps.push('Token or cost accounting — nothing records what a run spent, so "was this worth it" has no answer.');
  }
  if (spans.size > 0 && ![...spans.values()].some((entry) => entry.contextBytes !== undefined)) {
    gaps.push('Prompt size per stage, despite `stage_context_measured` existing in the vocabulary.');
  }
  if (noChange > 0) {
    gaps.push(`${String(noChange)} attempt(s) changed no file. Whether that was correct is only in the agent's prose, not in a field.`);
  }

  console.log(`\n## Totals\n  ${String(modelCalls)} model calls · ${String(attempts)} task attempts`);
  console.log('\n## What this run cannot tell you');
  if (gaps.length === 0) console.log('  (nothing missing from this list)');
  for (const gap of gaps) console.log(`  - ${gap}`);
}

await main();
