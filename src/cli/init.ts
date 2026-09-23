import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { SystemClock } from '../adapters/clock/system-clock.js';
import { registerProject } from '../app/init-project.js';
import { StateStore } from '../app/state-store.js';
import { buildExecutionContext, buildPlanningPipeline } from '../app/execution-context.js';
import { createRunWithIdentity } from '../app/run-actions.js';
import { roleConfigForStage } from '../contracts/index.js';
import type { WarmResult } from '../app/planning-pipeline.js';
import { nodeAdapters } from './adapters.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError, roleTimeoutKey } from './render/errors.js';
import { formatElapsed, writeProgress } from './render/progress.js';
import type { GlobalOptions } from './index.js';

/**
 * `agent-flow init` — prepare a repository. Never clobbers anything (§7.7).
 *
 * The judgements moved to `app/init-project.ts` when the Deck grew a way to register a
 * project (7.6): a warning that existed only as a line printed here would have been
 * missing from the browser, on the one surface where a person cannot see the command that
 * was chosen for them.
 */
export async function runInitCommand(
  options: { force?: boolean; warm?: boolean },
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  const fs = new NodeFileSystem();

  try {
    const store = new StateStore({ fs, clock: new SystemClock(), projectDir: globals.cwd });

    const outcome = await registerProject({
      store,
      fs,
      projectDir: globals.cwd,
      ...(options.force === undefined ? {} : { force: options.force }),
    });

    if (!outcome.ok) {
      const active = outcome.active;
      process.stderr.write(
        [
          `Run ${active.runId} is still active (${active.status}).`,
          '',
          `  planningBase  ${active.planningBase ?? '(none recorded)'}`,
          '',
          'init writes files that have to be committed, and that commit moves HEAD.',
          "A run's planningBase is frozen when the run is created, so committing now",
          'would leave this run planning against one base and executing against another.',
          '',
          'Finish or abandon the run first, or re-run with --force to proceed anyway',
          '(recorded on the run).',
          '',
        ].join('\n'),
      );
      return ExitCode.GATE_NOT_SATISFIED;
    }

    const { result, active } = outcome;

    const lines: string[] = [
      `Detected: ${result.stack.type} (${result.stack.name})`,
      '',
    ];

    for (const path of result.created) lines.push(`  created  ${path}`);
    for (const path of result.updated) lines.push(`  updated  ${path}`);
    for (const path of result.skipped) lines.push(`  kept     ${path} (already exists)`);

    if (result.skipped.length > 0) {
      lines.push('', 'Nothing existing was overwritten. Use --force to replace it.');
    }

    // The findings `initProject` made, as sentences. The judgement is not repeated here:
    // the Deck renders the same warnings from the same field, and two copies of "this
    // install command will refuse every task" would eventually disagree about which
    // commands do that.
    for (const warning of result.warnings) {
      if (warning.kind === 'no_validation_commands') {
        lines.push(
          '',
          'No validation commands were detected. Add them to .agent-flow/config.yaml —',
          'agent-flow runs them itself, so an invented command fails for the wrong reason.',
        );
      }
      if (warning.kind === 'install_dirties_tree') {
        lines.push(
          '',
          `Warning: \`${warning.command}\` writes a lockfile this repository does not track yet.`,
          'Every task will be refused at the setup check until it is committed — the tree',
          'has to be identical before and after install, or an attempt cannot say what it',
          'changed. Run it once and commit the lockfile before the first feature.',
        );
      }
      if (warning.kind === 'instructions_unread') {
        lines.push(
          '',
          `Warning: ${warning.paths.join(', ')} ${warning.paths.length > 1 ? 'hold' : 'holds'} instructions agent-flow never reads.`,
          'Every stage receives AGENTS.md, so anything that lives only in the other file is',
          'invisible to planning — including the tools this repository expects an agent to',
          'use. Mirror what still applies into AGENTS.md.',
        );
      }
      if (warning.kind === 'instructions_fallback') {
        lines.push(
          '',
          `Note: AGENTS.md is still the scaffold, so every stage reads ${warning.path} in its place.`,
          'Write AGENTS.md only when the rules for agent-flow should differ from it.',
        );
      }
    }

    if (active !== undefined) {
      lines.push(
        '',
        `Warning: run ${active.runId} is active and its planningBase may no longer`,
        'match HEAD once you commit these files. This was recorded on the run.',
      );
    }

    // Said here because the alternative is discovering it at review time: these
    // files are in the working tree from now on, and an uncommitted AGENTS.md
    // turns up inside the first feature's diff looking like part of it.
    lines.push(
      '',
      'Commit what was just written before starting a feature — otherwise it',
      'lands in the first diff the reviewer sees, as though the feature did it.',
      '',
      options.warm === true ? 'Next: warming the repository map' : 'Next: agent-flow doctor',
      '',
    );
    process.stdout.write(lines.join('\n'));

    if (options.warm === true) return warmRepositoryMap(globals);

    return ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

/**
 * How much of the architect's budget discovery may use before `init` says so.
 *
 * The same 80% `stage-runner.ts` uses for `stage_near_timeout`, and deliberately the same
 * number rather than a second opinion: a stage that would warn during a feature has to
 * warn here, or setup would certify a configuration the first real run then rejects.
 */
const WARN_ABOVE_SHARE = 0.8;

/**
 * Builds the repository map once, at setup, and reports it against the budget.
 *
 * **Two problems, one call.** The map is feature-agnostic and cached, so until something
 * built it ahead of time the first feature funded a stage that had nothing to do with it.
 * And the budget it has to fit was never checked against anything: a repository too large
 * for the default is indistinguishable from one that fits until the day a request dies at
 * its first stage — which is how a 15-minute discovery took a whole planning run down.
 *
 * Opt-in, because this spends a model call and `init` is otherwise local and free. The
 * same reasoning `doctor --deep` already follows for probing auth (R-14): a command that
 * costs money asks first.
 */
async function warmRepositoryMap(globals: GlobalOptions): Promise<ExitCodeValue> {
  try {
    const context = await buildExecutionContext({
      ...nodeAdapters(),
      projectDir: globals.cwd,
      globalConfigPath: globals.globalConfigPath,
    });

    // **The limit this stage will actually run against, from the same function the stage
    // runner resolves through.** Not `resolveRole`: that also validates capabilities
    // against what the prompt declares, and satisfying it from here would mean restating
    // `discovery.md`'s own front matter in the CLI — two copies of a fact the prompt owns,
    // one of which would be wrong the day the prompt changed. The capability check still
    // happens, inside `warm`, where the prompt is in hand.
    //
    // Named with the stage, because `roles.architect.stages.discovery.timeoutSeconds` is a
    // real override and a role-level read would quietly report a budget nothing uses.
    const budgetSeconds = roleConfigForStage(
      context.config.global.roles,
      'architect',
      'discovery',
    ).timeoutSeconds;

    const run = await createRunWithIdentity(context, WARM_FEATURE);
    const pipeline = buildPlanningPipeline(context);

    try {
      const warm = await pipeline.warm(run.runId, {
        onProgress: (label, status) => {
          writeProgress(label, status, globals.verbose === true);
        },
      });
      // Terminal before returning, always. A run left `running` is an active run, and
      // `init`'s own AR-01 gate refuses to write anything while one exists — so a
      // warm-up that forgot to close itself would lock the command that started it.
      await context.store.updateRun(run.runId, (state) => ({ ...state, status: 'completed' }));

      process.stdout.write(`\n${renderWarm(warm, budgetSeconds).join('\n')}\n`);
      return ExitCode.OK;
    } catch (error) {
      await context.store.updateRun(run.runId, (state) => ({ ...state, status: 'failed' }));
      throw error;
    }
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

/** The feature text a warm-up run carries. It plans nothing; it says what it is. */
const WARM_FEATURE = 'Warm the repository map (agent-flow init --warm). No feature is planned.';

/**
 * What the warm-up measured, as sentences — the judgement `PlanningPipeline.warm` refuses.
 *
 * Exported for the same reason `roleTimeoutKey` is: this is the whole point of `--warm`,
 * and the alternative to testing it here is driving the command end to end, which needs
 * real adapters and a model call. A pure function of two numbers should not cost that.
 */
export function renderWarm(warm: WarmResult, timeoutSeconds: number): string[] {
  if (!warm.ran) {
    return [
      'The repository map was already current — nothing was spent.',
      '',
      'Next: agent-flow doctor',
    ];
  }

  const budgetMs = timeoutSeconds * 1000;
  const share = budgetMs > 0 ? Math.round((warm.elapsedMs / budgetMs) * 100) : 0;
  const lines = [
    `Repository map built in ${formatElapsed(warm.elapsedMs)}, against a ${String(timeoutSeconds)}s ` +
      `budget (${String(share)}%). Later features reuse it until the repository moves.`,
  ];

  if (budgetMs > 0 && warm.elapsedMs >= budgetMs * WARN_ABOVE_SHARE) {
    // The number that matters is the margin, and it is the one nobody had: this stage is
    // one slower day from being killed, and a killed discovery takes its whole run with it.
    lines.push(
      '',
      `Warning: that is ${String(share)}% of what this role is allowed. Raise`,
      `\`${roleTimeoutKey('architect')}\` in .agent-flow/config.yaml before the first`,
      'feature — a discovery that runs out of time fails the run at its first stage.',
    );
  }

  lines.push('', 'Next: agent-flow doctor');
  return lines;
}
