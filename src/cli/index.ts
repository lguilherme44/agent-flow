import { Command } from 'commander';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import { runFeatureFromSource, runReviseCommand } from './feature.js';
import { runDoctorCommand } from './doctor.js';
import { runInitCommand } from './init.js';
import { runSetupCommand } from './setup.js';
import {
  runConfigGetCommand,
  runConfigSetCommand,
  runConfigListCommand,
  runConfigUnsetCommand,
} from './config.js';
import { runStatusCommand } from './status.js';
import { runTimelineCommand } from './timeline.js';
import { runMapCommand } from './map.js';
import { runApproveCommand, runRejectCommand } from './approve.js';
import type { DecidedByFlags } from './decided-by.js';
import {
  runAnswerCommand,
  runRunCommand,
  runRetryCommand,
  runRevalidateCommand,
} from './run.js';
import { runReviewCommand } from './review.js';
import { runForgeCommand, type ForgeAction } from './forge.js';
import { runCleanCommand } from './clean.js';
import {
  DEFAULT_UI_HOST,
  DEFAULT_UI_PORT,
  runUiCommand,
  type UiOptions,
} from './ui.js';
import { readVersion } from './version.js';
import { rememberCurrentProject, runProjectsCommand } from './projects.js';
import { runInstructionsCommand } from './instructions.js';
import { DEFAULT_HUB_URL, HUB_URL_ENV, runMcpCommand, type McpCommandOptions } from './mcp.js';
import { runPairingCodeCommand, type PairingCodeOptions } from './pairing-code.js';
import { runAutostartCommand, type AutostartOptions } from './autostart.js';
import {
  runCancelCommand,
  runCompleteCommand,
  runPauseCommand,
  runResumeCommand,
} from './lifecycle.js';

export interface GlobalOptions {
  readonly cwd: string;
  readonly globalConfigPath: string;
  readonly verbose: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly strict: boolean;
}

/**
 * The three flags every plan-gate move takes: who decided and their exact words. Required —
 * the command refuses without them — and declared once so `approve`, `reject` and `revise`
 * cannot describe them three ways.
 */
function withDecidedBy(
  command: Command,
  help: { readonly name?: string; readonly words?: string } = {},
): Command {
  return command
    .option('--decided-by <name>', help.name ?? 'the human who decided, as they name themselves (required)')
    .option('--words <text>', help.words ?? "the human's exact words deciding it (required; - for stdin)")
    .option('--words-file <path>', 'read those words from a file');
}

function globalOptions(command: Command): GlobalOptions {
  const opts = command.optsWithGlobals<{
    cwd?: string;
    config?: string;
    verbose?: boolean;
    dryRun?: boolean;
    json?: boolean;
    strict?: boolean;
  }>();

  return {
    cwd: resolve(opts.cwd ?? process.cwd()),
    globalConfigPath: opts.config ?? join(homedir(), '.agent-flow', 'config.yaml'),
    verbose: opts.verbose ?? false,
    dryRun: opts.dryRun ?? false,
    json: opts.json ?? false,
    strict: opts.strict ?? false,
  };
}

export async function main(argv: string[]): Promise<number> {
  const { program, exitCode } = createProgram();

  try {
    await program.parseAsync(argv);
    return exitCode();
  } catch (error) {
    // Commander throws for `--help` and `--version`; those are not failures.
    if (isCommanderExit(error)) return (error as { exitCode?: number }).exitCode ?? ExitCode.OK;

    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

/**
 * The CLI's command tree, without running it.
 *
 * Separate from {@link main} so a test can ask which commands and flags are registered —
 * `test/cli/instructions.test.ts` holds every `agent-flow <command>` the operator guides
 * mention against this tree, so a guide cannot keep naming a command after it is renamed.
 */
export function createProgram(): { program: Command; exitCode: () => ExitCodeValue } {
  const program = new Command();

  program
    .name('agent-flow')
    .description('Orchestration layer for AI-assisted development')
    .version(readVersion(), '-V, --version')
    .option('--cwd <dir>', 'project directory (defaults to the current one)')
    .option('--config <path>', 'global configuration file')
    .option('--verbose', 'stream progress detail')
    .option('--dry-run', 'show what would run without invoking any runner')
    .option('--json', 'machine-readable output')
    .option('--strict', 'treat a DEGRADED environment as a failure')
    .showHelpAfterError()
    // Without this commander calls process.exit() itself, which makes the CLI
    // untestable and steals the decision about the exit code from main().
    .exitOverride();

  let exitCode: ExitCodeValue = ExitCode.OK;

  program
    .command('doctor')
    .description('Check whether this environment can run the workflow')
    .option('--deep', 'probe each runner for real (consumes quota)')
    .action(async (options: { deep?: boolean }, command: Command) => {
      exitCode = await runDoctorCommand(options, globalOptions(command));
    });

  program
    .command('setup')
    .description('Interactive setup wizard to initialize repository and verify environment')
    .option('--force', 'overwrite files that already exist')
    .action(async (options: { force?: boolean }, command: Command) => {
      exitCode = await runSetupCommand(options, globalOptions(command));
    });

  const configCmd = program.command('config').description('Inspect or modify configuration');

  configCmd
    .command('get <key>')
    .description('Get a configuration value (e.g. roles.planner.runner)')
    .option('--global', 'read from global configuration file')
    .action(async (key: string, options: { global?: boolean }, command: Command) => {
      exitCode = await runConfigGetCommand(key, options, globalOptions(command));
    });

  configCmd
    .command('set <key> <value>')
    .description('Set a configuration value')
    .option('--global', 'write to global configuration file')
    .action(async (key: string, value: string, options: { global?: boolean }, command: Command) => {
      exitCode = await runConfigSetCommand(key, value, options, globalOptions(command));
    });

  for (const name of ['unset', 'inherit'] as const) {
    configCmd
      .command(`${name} <key>`)
      .description('Remove an explicit value so it inherits from the higher-precedence source')
      .option('--global', 'remove from global configuration file')
      .action(async (key: string, options: { global?: boolean }, command: Command) => {
        exitCode = await runConfigUnsetCommand(key, options, globalOptions(command));
      });
  }

  configCmd
    .command('list')
    .description('List effective or global configuration')
    .option('--global', 'list global configuration file')
    .action(async (options: { global?: boolean }, command: Command) => {
      exitCode = await runConfigListCommand(options, globalOptions(command));
    });

  program
    .command('init')
    .description('Prepare this repository for agent-flow')
    .option('--force', 'overwrite files that already exist')
    // Opt-in because it spends a model call, where the rest of `init` is local and free —
    // the same line `doctor --deep` draws around probing auth (R-14).
    .option('--warm', 'build the repository map now and measure it against the budget')
    .action(async (options: { force?: boolean; warm?: boolean }, command: Command) => {
      exitCode = await runInitCommand(options, globalOptions(command));
    });

  program
    .command('feature')
    .description('Plan a feature: discovery → impact → SDD → plan → review')
    // Optional for the same reason `revise`'s is (D15): a description with paragraphs,
    // backticks and quotes does not survive being a shell argument, and the measured one
    // was 9 KB.
    .argument('[description]', 'what the feature should do, or - to read stdin')
    .option('--file <path>', 'read the description from a file')
    .option('--edit', 'write the description in $EDITOR')
    .option('--no-cache', 'ignore the cached repository map and re-run discovery')
    .option('--from <stage>', 'resume from a stage (discovery, architecture-impact, sdd, planning)')
    .option('--skip-review', 'stop after planning, without the automated review')
    .option('--workflow <class>', 'workflow class override: trivial, simple, standard, high-risk')
    .option(
      '--grounded',
      'the request carries its own investigation: skip a fresh repository map and confirm its claims in the code',
    )
    .action(
      async (
        description: string | undefined,
        options: {
          file?: string;
          edit?: boolean;
          cache?: boolean;
          from?: string;
          skipReview?: boolean;
          workflow?: string;
          grounded?: boolean;
        },
        command: Command,
      ) => {
        const { file, edit, ...feature } = options;
        exitCode = await runFeatureFromSource(
          { argument: description, file, edit },
          feature,
          globalOptions(command),
        );
      },
    );

  program
    .command('status')
    .description('Show the active run, its progress and anything degraded')
    .action(async (_options: unknown, command: Command) => {
      exitCode = await runStatusCommand(globalOptions(command));
    });

  program
    .command('timeline')
    .description('Show where a run’s wall clock went: model, validation, waiting, rework')
    .argument('[runId]', 'the run to read (defaults to the current one)')
    .action(async (runId: string | undefined, _options: unknown, command: Command) => {
      exitCode = await runTimelineCommand(runId, globalOptions(command));
    });

  program
    .command('map')
    .description('Build the repository map discovery uses, and show what it cost')
    .option('--budget <tokens>', 'how many tokens the rendered map may occupy')
    .option('--write', 'also store it in .agent-flow/cache/repo-map.txt')
    // Local and free, unlike every other command that touches a repository this size:
    // it parses rather than prompts, so there is nothing to opt into.
    .action(async (options: { budget?: string; write?: boolean }, command: Command) => {
      exitCode = await runMapCommand(options, globalOptions(command));
    });

  const approveCommand = program
    .command('approve')
    .description('Approve the plan so implementation may begin')
    .option('--force', 'approve despite a failed or missing review (recorded on the run)')
    // FR-016. The other way past a failed review: `--force` overrules the findings and hands
    // them to nobody, this hands each task the findings that concern it.
    .option(
      '--attach-findings',
      'approve over a failed review, handing its findings to the tasks they cite (recorded on the run)',
    );
  withDecidedBy(approveCommand).action(
    async (options: { force?: boolean; attachFindings?: boolean } & DecidedByFlags, command: Command) => {
      exitCode = await runApproveCommand(options, globalOptions(command));
    },
  );

  const rejectCommand = program
    .command('reject')
    .description('Close this run without implementing it')
    .argument('[reason]', 'why the plan was rejected');
  withDecidedBy(rejectCommand).action(
    async (reason: string | undefined, options: DecidedByFlags, command: Command) => {
      exitCode = await runRejectCommand(reason, options, globalOptions(command));
    },
  );

  const reviseCommand = program
    .command('revise')
    .description('Re-plan with an extra instruction, invalidating any approval')
    // Optional, because the instruction may come from a file, stdin or an editor instead.
    // A multi-paragraph revision does not survive being a shell argument (AR-08).
    .argument('[instruction]', 'what to change about the plan, or - to read stdin')
    .option('--file <path>', 'read the instruction from a file')
    .option('--edit', 'write the instruction in $EDITOR')
    // Default `planning`, which is what revise always did. `sdd` is for a finding against
    // the specification itself: without it the planner corrects the plan, the plan then
    // contradicts a specification nothing can change, and the next review rejects it for
    // the contradiction — a cycle that cannot converge.
    .option('--from <stage>', 're-enter at a stage (sdd, planning — default: planning)')
    // P7.5. A decision and "the plan is bad" used to cost the same cycle, and the first
    // attempt of this feature spent its whole budget on decisions.
    .option('--decision', 'the instruction is a decision: replan without spending a revision cycle')
    .option('--escalate', 'replan at the next workflow class, under its budget');
  withDecidedBy(reviseCommand).action(
    async (
      instruction: string | undefined,
      options: {
        file?: string;
        edit?: boolean;
        from?: string;
        decision?: boolean;
        escalate?: boolean;
      } & DecidedByFlags,
      command: Command,
    ) => {
      exitCode = await runReviseCommand(
        {
          argument: instruction,
          file: options.file,
          edit: options.edit,
          from: options.from,
          decision: options.decision,
          escalate: options.escalate,
          decidedBy: options.decidedBy,
          words: options.words,
          wordsFile: options.wordsFile,
        },
        globalOptions(command),
      );
    },
  );

  program
    .command('run')
    .description('Execute the approved plan')
    .action(async (_options: unknown, command: Command) => {
      exitCode = await runRunCommand({}, globalOptions(command));
    });

  program
    .command('task')
    .description('Execute a single task from the approved plan')
    .argument('<taskId>', 'for example TASK-004')
    .action(async (taskId: string, _options: unknown, command: Command) => {
      exitCode = await runRunCommand({ taskId }, globalOptions(command));
    });

  const retryCommand = program
    .command('retry')
    .description('Queue a task again after it failed')
    .argument('<taskId>', 'for example TASK-004')
    .option('--force', 'retry a BLOCKED task, or exceed the attempt limit')
    // PRI-20. The net for a plan that forgot `expectsNoChange`: a verification task with a
    // legitimately empty diff otherwise burns every attempt and ends in a run a person can
    // only cancel. Declared here rather than by editing the plan, which approval is bound to.
    .option('--expect-no-change', 'this task is meant to change nothing; accept an empty diff');
  // Both overrides overrule a gate, so they name the human who chose them.
  withDecidedBy(retryCommand, {
    name: 'the human who chose --force or --expect-no-change (required with either)',
    words: "their exact words (required with either; - for stdin)",
  }).action(async (
    taskId: string,
    options: { force?: boolean; expectNoChange?: boolean } & DecidedByFlags,
    command: Command,
  ) => {
    exitCode = await runRetryCommand(taskId, options, globalOptions(command));
  });

  const answerCommand = program
    .command('answer')
    // P7.1. Beside `retry` because it is the retry a BLOCKED task was waiting for: the same
    // requeue, carrying the text the next attempt needs, and no `--force`.
    .description('Answer what a BLOCKED task asked, and queue it again')
    .argument('<taskId>', 'for example TASK-004')
    // Optional for the reason `revise`'s instruction is (AR-08): an answer with a snippet or a
    // list does not survive being a shell argument.
    .argument('[text]', 'the answer, or - to read stdin')
    .option('--file <path>', 'read the answer from a file')
    .option('--edit', 'write the answer in $EDITOR');
  // The answer is the human's decision: it names them, and their words default to the answer.
  withDecidedBy(answerCommand, {
    name: 'the human whose answer this is (required)',
    words: 'their exact words, when not the answer itself (- for stdin)',
  }).action(
    async (
      taskId: string,
      text: string | undefined,
      options: { file?: string; edit?: boolean } & DecidedByFlags,
      command: Command,
    ) => {
      exitCode = await runAnswerCommand(
        taskId,
        {
          argument: text,
          file: options.file,
          edit: options.edit,
          decidedBy: options.decidedBy,
          words: options.words,
          wordsFile: options.wordsFile,
        },
        globalOptions(command),
      );
    },
  );

  program
    .command('revalidate')
    // D19. Beside `retry` because it is the other half of the same answer: `retry` runs the
    // model again, and this runs only the checks over the worktree a person already fixed.
    .description("Re-run a task's validation over the worktree you fixed by hand")
    .argument('<taskId>', 'for example TASK-004')
    .action(async (taskId: string, _options: unknown, command: Command) => {
      exitCode = await runRevalidateCommand(taskId, globalOptions(command));
    });

  program
    .command('pause')
    .description('Stop starting work; the task in flight finishes')
    .action(async (_options: unknown, command: Command) => {
      exitCode = await runPauseCommand(globalOptions(command));
    });

  program
    .command('resume')
    .description('Clear a pause and continue the approved plan')
    .action(async (_options: unknown, command: Command) => {
      exitCode = await runResumeCommand(globalOptions(command));
    });

  const cancelCommand = program
    .command('cancel')
    .description('End the run and terminate its agents; keeps every artifact')
    .option('--yes', 'confirm: cancelling is not reversible');
  // Irreversible, so a human decision like a gate move: named, in their words.
  withDecidedBy(cancelCommand).action(async (options: { yes?: boolean } & DecidedByFlags, command: Command) => {
    exitCode = await runCancelCommand(options, globalOptions(command));
  });

  const completeCommand = program
    .command('complete')
    .description('Close a run whose last review ended NOT DONE, on the human\'s decision (e.g. delivered outside forge)')
    .option('--pr <url>', 'where the delivery made outside agent-flow is');
  // Terminal and over a Definition of Done that did not hold: named, in their words.
  withDecidedBy(completeCommand).action(async (options: { pr?: string } & DecidedByFlags, command: Command) => {
    exitCode = await runCompleteCommand(options, globalOptions(command));
  });

  program
    .command('review')
    .description('Run validation, inspect the implementation and judge it against the SDD')
    .option('--fix', 'report the corrective tasks the findings would produce')
    // The way out of an e2e NOT_RUN: a person saw the change work on a target agent-flow
    // cannot reach, and says so on the record, bound to the head under review.
    .option(
      '--e2e-observed <text>',
      "the human's own words: what they saw the change do on the target e2e could not reach (or - for stdin)",
    )
    .option('--e2e-observed-file <path>', 'read that observation from a file')
    // Required with an observation: this terminal records as `keyboard`, which an AI
    // driving the CLI is too, so the name is what says a person saw it.
    .option('--observed-by <name>', 'the human who observed it (required with an observation)')
    .option('--e2e-head <sha>', 'the build the human tested; refused unless it is the head under review')
    .option('--evidence <files...>', 'screenshots of what the human saw, copied into the run (png, jpg, webp, gif)')
    .action(
      async (
        options: {
          fix?: boolean;
          e2eObserved?: string;
          e2eObservedFile?: string;
          observedBy?: string;
          e2eHead?: string;
          evidence?: string[];
        },
        command: Command,
      ) => {
        exitCode = await runReviewCommand(options, globalOptions(command));
      },
    );

  program
    .command('forge')
    .description('Publish this run and observe its delivery, without giving GitHub authority')
    .argument('<action>', 'status | publish | issue | pr | sync')
    .option('--title <title>', 'title for the issue or pull request')
    .option('--base <branch>', 'base branch for the pull request')
    .action(async (action: string, options: { title?: string; base?: string }, command: Command) => {
      const known = ['status', 'publish', 'issue', 'pr', 'sync'] as const;
      if (!(known as readonly string[]).includes(action)) {
        process.stderr.write(`Unknown forge action "${action}". Try: ${known.join(', ')}\n`);
        exitCode = ExitCode.CONFIG_ERROR;
        return;
      }
      exitCode = await runForgeCommand(action as ForgeAction, options, globalOptions(command));
    });

  program
    .command('ui')
    .description('Serve the local dashboard for this project, or for a workspace of them')
    .argument('[root]', 'directory to scan for projects (defaults to the current one)')
    .option('--port <port>', `port to listen on (default ${String(DEFAULT_UI_PORT)})`)
    .option('--host <host>', `address to bind (default ${DEFAULT_UI_HOST})`)
    .option('--no-open', 'do not open a browser')
    .option('--depth <n>', 'how deep to look for projects (default: ui.workspaceDepth, or 2)')
    .option('--classic', 'serve the previous dashboard instead of Deck')
    .option(
      '--pair',
      'enable remote device pairing (restarting the server unpairs every device and invalidates any outstanding code)',
    )
    .action(async (root: string | undefined, options: UiOptions, command: Command) => {
      exitCode = await runUiCommand(root, options, globalOptions(command));
    });

  // A new code from the running hub, so a second device pairs without a restart that would
  // unpair the first (dogfood 08–09/10). Its own command: `ui [root]` would read `code` as a root.
  program
    .command('pairing-code')
    .description('Ask the running hub (started with --pair) for a new pairing code; paired devices stay paired')
    .option('--hub <url>', `the hub to ask (default ${DEFAULT_HUB_URL}, or ${HUB_URL_ENV})`)
    .action(async (options: PairingCodeOptions) => {
      exitCode = await runPairingCodeCommand(options);
    });

  program
    .command('projects')
    .description('List, add or remove directories in the project hub the dashboard shows')
    .argument('[action]', 'list (default), add or remove')
    .argument('[dirs...]', 'directories: a project, or a folder of repositories')
    .action(async (action: string | undefined, dirs: string[], _options: unknown, command: Command) => {
      const chosen = action ?? 'list';
      if (chosen !== 'list' && chosen !== 'add' && chosen !== 'remove') {
        process.stderr.write(`Unknown action "${chosen}". Use list, add or remove.\n`);
        exitCode = ExitCode.CONFIG_ERROR;
        return;
      }
      exitCode = await runProjectsCommand(chosen, dirs, globalOptions(command));
    });

  program
    .command('autostart')
    .description('Start the dashboard at logon, serving every project in the hub')
    .argument('[action]', 'status (default), install or uninstall')
    .option('--node <path>', 'Node executable to run it with (default: this one, or the newest nvm install ≥ 20.19)')
    .option('--port <port>', `port to listen on (default ${String(DEFAULT_UI_PORT)})`)
    .action(async (action: string | undefined, options: AutostartOptions, command: Command) => {
      const chosen = action ?? 'status';
      if (chosen !== 'status' && chosen !== 'install' && chosen !== 'uninstall') {
        process.stderr.write(`Unknown action "${chosen}". Use status, install or uninstall.\n`);
        exitCode = ExitCode.CONFIG_ERROR;
        return;
      }
      exitCode = await runAutostartCommand(chosen, options, globalOptions(command));
    });

  program
    .command('instructions')
    .description('Print the operator guide for a flow (overview, feature, gate, blocked, recover)')
    .argument('[guide]', 'the guide to print (defaults to the overview)')
    .option('--list', 'list the guides, one line each')
    .action(async (guide: string | undefined, options: { list?: boolean }) => {
      exitCode = await runInstructionsCommand(guide, options);
    });

  program
    .command('mcp')
    .description('Serve the agent-flow tools to an AI over MCP (stdio), as a client of the hub')
    .option('--hub <url>', `the hub to relay to (default ${DEFAULT_HUB_URL}, or ${HUB_URL_ENV})`)
    .option('--allow-remote-hub', 'accept a hub off this machine (it has no authentication)')
    .action(async (options: McpCommandOptions) => {
      exitCode = await runMcpCommand(options);
    });

  // The project hub fills itself: every command that ran in a project adds it, so the
  // dashboard lists it from anywhere afterwards. `projects` is left out on purpose —
  // `projects remove .` run inside the project would otherwise be undone on its way out.
  // `instructions` is left out because it only prints text: it is the first thing an AI
  // runs, from whatever directory it is in, and a command that reads must not write.
  // `mcp` for the same reason: an MCP client starts it in whatever directory a session
  // opened, and it only relays to the hub.
  program.hook('postAction', async (_program, action) => {
    if (NOT_REMEMBERED.has(action.name())) return;
    await rememberCurrentProject(globalOptions(action));
  });

  program
    .command('clean')
    .description('Remove old run state, and the Git namespace that goes with it')
    .option('--keep <n>', 'how many recent runs to keep (default 5)')
    .option('--cache', 'also drop the cached repository map')
    .option('--force', 'remove the active run too')
    // §20.3. `--branches` is the only flag that deletes work, it is never implied
    // by `--worktrees`, and it never becomes a default: branches are cheap and a
    // checkout is not, but an unmerged branch is the feature itself.
    .option('--worktrees', 'also reclaim retained worktrees of removed runs')
    .option('--branches', 'also delete integration branches that are merged nowhere')
    .option('--dry-run', 'report what would be reclaimed and change nothing')
    .action(async (options: Record<string, string | boolean>, command: Command) => {
      exitCode = await runCleanCommand(options as never, globalOptions(command));
    });

  return { program, exitCode: () => exitCode };
}

/** Commands the hub's `postAction` must not record (see the hook in {@link createProgram}). */
const NOT_REMEMBERED = new Set(['projects', 'instructions', 'mcp']);

function isCommanderExit(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    String((error as { code: unknown }).code).startsWith('commander.')
  );
}
