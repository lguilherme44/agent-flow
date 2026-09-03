import { StateStore } from '../app/state-store.js';
import { loadConfig } from '../config/loader.js';
import { deliveryStatus, forgeSetup, tokenFrom } from '../app/forge-actions.js';
import { renderDelivery } from './render/delivery.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { actionDeps, currentRunId } from './approve.js';
import type { GlobalOptions } from './index.js';

/**
 * `agent-flow forge` — remote delivery, as an operator drives it.
 *
 * **A thin adapter, for the same reason `review` is one.** The decisions — which commit is
 * approved, whether a repository matches, whether an object already exists — live in
 * `app/`, where the server can reach them too. What is left here is turning an outcome
 * into words and an exit code.
 *
 * `status` needs no token and no provider: "nothing is configured" is a legitimate answer
 * to "where did this run go", and needing a credential to be told that would be absurd.
 */

export type ForgeAction = 'status' | 'publish' | 'issue' | 'pr' | 'sync';

export async function runForgeCommand(
  action: ForgeAction,
  options: { title?: string; base?: string },
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  const deps = actionDeps(globals);
  const runId = await currentRunId(deps);
  if (runId === null) {
    process.stderr.write('No active run.\n');
    return ExitCode.GATE_NOT_SATISFIED;
  }

  const config = await loadConfig({
    fs: deps.fs,
    projectDir: deps.projectDir,
    globalConfigPath: deps.globalConfigPath,
  });
  const forge = config.global.forge;

  if (action === 'status') {
    const view = await deliveryStatus({
      fs: deps.fs,
      projectDir: deps.projectDir,
      config: forge,
      runId,
    });
    process.stdout.write(`${renderDelivery(view)}\n`);
    return ExitCode.OK;
  }

  const setup = await forgeSetup({
    fs: deps.fs,
    clock: deps.clock,
    processRunner: deps.processRunner,
    store: new StateStore({ fs: deps.fs, clock: deps.clock, projectDir: deps.projectDir }),
    projectDir: deps.projectDir,
    homeDir: deps.host.homeDir,
    config: forge,
    token: tokenFrom(forge, process.env),
  });

  if (!setup.ok) {
    process.stderr.write(`${setup.detail}\n\n${setup.action}\n`);
    return ExitCode.GATE_NOT_SATISFIED;
  }

  const state = await new StateStore({
    fs: deps.fs,
    clock: deps.clock,
    projectDir: deps.projectDir,
  }).loadRun(runId);

  // **The approved commit, from the run rather than from an argument** (§8, §13). A caller
  // that could name the commit could publish one nothing approved.
  const approved = state.integrationHead;

  switch (action) {
    case 'publish': {
      if (approved === undefined) {
        process.stderr.write(
          'This run has no integration head, so there is no approved commit to publish.\n',
        );
        return ExitCode.GATE_NOT_SATISFIED;
      }

      const result = await setup.service.publish(runId, approved);
      if (!result.ok) {
        process.stderr.write(`${result.failure.code}: ${result.failure.detail}\n`);
        return ExitCode.GATE_NOT_SATISFIED;
      }

      process.stdout.write(
        `${result.adopted === true ? 'Already published' : 'Published'} ` +
          `${approved.slice(0, 8)} to ${result.value}\n`,
      );
      return ExitCode.OK;
    }

    case 'issue': {
      const result = await setup.service.issue(runId, {
        title: options.title ?? `${runId}: ${state.feature.slice(0, 100)}`,
        body: issueBody(runId, state.feature),
      });
      if (!result.ok) {
        process.stderr.write(`${result.failure.code}: ${result.failure.detail}\n`);
        return ExitCode.GATE_NOT_SATISFIED;
      }

      process.stdout.write(
        `${result.adopted === true ? 'Linked existing' : 'Created'} issue #${String(result.value)}\n`,
      );
      return ExitCode.OK;
    }

    case 'pr': {
      if (approved === undefined) {
        process.stderr.write('This run has no integration head, so a pull request has no head.\n');
        return ExitCode.GATE_NOT_SATISFIED;
      }

      const base = options.base ?? forge.baseBranch;
      if (base === undefined) {
        process.stderr.write(
          'No base branch. Pass --base, or set forge.baseBranch — a model does not choose one.\n',
        );
        return ExitCode.GATE_NOT_SATISFIED;
      }

      const result = await setup.service.pullRequest(runId, approved, {
        // **A title only when the operator gave one, and a fallback only for a new PR.**
        // The live M7 dogfood found this: the first call carried `--title`, a later call
        // without one recomputed the default, and the update path overwrote a title a
        // person had chosen. An update sends what was asked for, not what could be derived.
        ...(options.title === undefined ? {} : { title: options.title }),
        newTitle: `${runId}: ${state.feature.slice(0, 100)}`,
        body: pullRequestBody(runId, state.feature, approved),
        base,
      });
      if (!result.ok) {
        process.stderr.write(`${result.failure.code}: ${result.failure.detail}\n`);
        return ExitCode.GATE_NOT_SATISFIED;
      }

      process.stdout.write(
        `${result.adopted === true ? 'Reused' : 'Opened'} pull request #${String(result.value)}\n`,
      );
      return ExitCode.OK;
    }

    case 'sync': {
      const result = await setup.service.sync(runId);
      if (!result.ok) {
        process.stderr.write(`${result.failure.code}: ${result.failure.detail}\n`);
        return ExitCode.GATE_NOT_SATISFIED;
      }

      const view = await deliveryStatus({
        fs: deps.fs,
        projectDir: deps.projectDir,
        config: forge,
        runId,
      });
      process.stdout.write(`${renderDelivery(view)}\n`);
      return ExitCode.OK;
    }
  }
}

/**
 * What an Issue says.
 *
 * **Composed from a template over facts, never from model output** (§32). Bounded, because
 * an unbounded body is a request nobody can review and a page nobody can read.
 */
function issueBody(runId: string, request: string): string {
  return [
    `Opened by Agent Flow for run \`${runId}\`.`,
    '',
    '## What was asked',
    '',
    request.slice(0, 2_000),
    '',
    '---',
    '',
    'Planning, review and quality evidence live in the run’s own artifacts. This issue is',
    'a link between that run and this repository; it is not a substitute for either.',
  ].join('\n');
}

function pullRequestBody(runId: string, request: string, commit: string): string {
  return [
    `Agent Flow run \`${runId}\`.`,
    '',
    '## What was asked',
    '',
    request.slice(0, 2_000),
    '',
    '## Provenance',
    '',
    `- integration commit \`${commit}\``,
    '- planned, approved, implemented, validated, integrated and reviewed locally',
    '- remote checks below are **observation**: the local quality decision is already made',
    '',
    '---',
    '',
    'Review and quality evidence live in the run’s artifacts. A green check here does not',
    'change what the local gates concluded, and a red one does not either.',
  ].join('\n');
}
