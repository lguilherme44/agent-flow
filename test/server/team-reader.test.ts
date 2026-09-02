import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { buildServer, type RunningServer } from '../../src/server/server.js';
import { registryOf } from '../../src/server/project-registry.js';
import { StateStore } from '../../src/app/state-store.js';
import type { TeamView } from '../../src/contracts/index.js';

/**
 * The team read model over HTTP (M5-08, M5-ACC-15).
 *
 * **The browser renders this and computes none of it.** Every assertion is really about
 * that one property: the endpoint returns what `core/team/view.ts` folded out of the
 * audit log, which is the same fold `af status` prints. A dashboard that ranked its own
 * candidates would be a second assignment authority, and the first time it disagreed with
 * the run the operator would be reading a decision nobody made (I-33).
 *
 * The projection's own rules are covered in `test/core/team/view.test.ts`. What is proved
 * here is the wiring, the bounds and the unhappy paths a network surface has to survive.
 */

const PROJECT = { id: 'demo', name: 'demo', path: '/repo' };

const PROJECT_CONFIG = `project:
  name: demo
  type: node
commands:
  test: npm test
`;

const ROLES = `roles:
  architect: { runner: claude, effort: high }
  sdd: { runner: claude, effort: high }
  planner: { runner: claude, effort: high }
  planReviewer: { runner: claude, effort: high }
  executors:
    trivial: { runner: claude, effort: low }
    normal: { runner: claude, effort: medium }
    complex: { runner: claude, effort: high }
  verification: { runner: claude, effort: medium }
  finalReviewer: { runner: claude, effort: high }
`;

const LEGACY = `version: 1
runners:
  claude:
    type: claude-code-cli
${ROLES}`;

const WITH_TEAM = `${LEGACY}teams:
  core:
    members:
      backend:
        role: executor.normal
        runner: claude
        displayName: Backend
        skills: [TypeScript]
        capacity: { maxConcurrentTasks: 2 }
        ownership:
          preferred: [src/server/**]
      frontend:
        role: executor.normal
        runner: claude
        skills: [vue]
`;

let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function serve(
  options: { readonly config?: string; readonly events?: Record<string, unknown>[] } = {},
) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();

  fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);
  fs.seed('/home/.agent-flow/config.yaml', options.config ?? WITH_TEAM);

  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const run = await store.createRun('weekly recurrence');

  for (const detail of options.events ?? []) {
    const { type, ...rest } = detail as { type: string };
    await store.appendEvent(run.runId, type, rest);
  }

  running = await buildServer({
    fs,
    clock,
    processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: '1.0.0' }),
    registry: registryOf([PROJECT]),
    globalConfigPath: '/home/.agent-flow/config.yaml',
    version: '0.1.0',
    host: '127.0.0.1',
    port: 4783,
    promptsDir: '/install/prompts',
    processHost: new FakeHost(),
    pollIntervalMs: 20,
  });

  const view = async (): Promise<TeamView> => {
    const response = await running!.app.inject({
      method: 'GET',
      url: `/api/v1/runs/${run.runId}/team?projectId=demo`,
    });
    expect(response.statusCode).toBe(200);
    return response.json<TeamView>();
  };

  return { fs, store, run, view };
}

describe('GET /runs/:runId/team', () => {
  it('returns the configured members, with what the operator wrote', async () => {
    const { view } = await serve();
    const team = await view();

    expect(team.configured).toBe(true);
    expect(team.members.map((member) => member.id)).toEqual(['backend', 'frontend']);
    expect(team.members[0]?.displayName).toBe('Backend');
    expect(team.members[0]?.skills).toEqual(['typescript']);
    expect(team.members[0]?.maxConcurrentTasks).toBe(2);
    expect(team.members[0]?.ownership.preferred).toEqual(['src/server/**']);
  });

  it('answers unconfigured for a project with no teams block', async () => {
    // Not an error, and a different empty state from a configured team that has not
    // started: one invites configuration and the other does not.
    const { view } = await serve({ config: LEGACY });
    const team = await view();

    expect(team.configured).toBe(false);
    expect(team.members).toEqual([]);
  });

  it('carries the ranking that explains an assignment', async () => {
    const { view } = await serve({
      events: [
        {
          type: 'task_assigned',
          task: 'TASK-001',
          agent: 'backend',
          role: 'executor.normal',
          reason: 'team_match',
          candidates: [
            { agentId: 'backend', score: 0.9, skillMatch: 1, ownership: 1, riskFit: 1, matchedSkills: ['typescript'] },
            { agentId: 'frontend', score: 0.2, skillMatch: 0, ownership: 0, riskFit: 1, matchedSkills: [] },
          ],
        },
      ],
    });
    const team = await view();

    expect(team.assignments).toHaveLength(1);
    expect(team.assignments[0]?.candidates.map((candidate) => candidate.agentId)).toEqual([
      'backend',
      'frontend',
    ]);
    expect(team.assignments[0]?.candidates[1]?.agentName).toBe('frontend');
    expect(team.totals.candidatesConsidered).toBe(2);
  });

  it('answers 404 for a run that does not exist', async () => {
    await serve();
    const response = await running!.app.inject({
      method: 'GET',
      url: '/api/v1/runs/AF-2026-999/team?projectId=demo',
    });

    expect(response.statusCode).toBe(404);
  });

  it('survives a log line a crash truncated mid-write', async () => {
    // The screen an operator opens *because* something is wrong must not be the thing
    // that also fails. Strict reads belong to the workflow, which has to fail closed.
    const { fs, run, view } = await serve({
      events: [
        {
          type: 'task_assigned',
          task: 'TASK-001',
          agent: 'backend',
          role: 'executor.normal',
          reason: 'team_match',
          candidates: [],
        },
      ],
    });

    // Appended raw, exactly as a kill between two writes would leave it: a line with no
    // terminating newline and no closing brace.
    const path = `/repo/.agent-flow/runs/${run.runId}/events.jsonl`;
    await fs.appendFile(path, '{"at":"2026-08-09T20:00:00.000Z","typ');

    const team = await view();
    expect(team.assignments).toHaveLength(1);
  });

  it('carries no filesystem path anywhere in the response', async () => {
    // A runner id is a configuration key and an ownership pattern is repository-relative
    // by the schema that accepted it. Neither is a path on this machine.
    const { view } = await serve();
    const body = JSON.stringify(await view());

    expect(body).not.toContain('/repo');
    expect(body).not.toContain('/home');
  });
});
