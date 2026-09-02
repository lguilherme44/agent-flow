import { Command } from 'commander';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import { runFeatureCommand, runReviseCommand } from './feature.js';
import { runDoctorCommand } from './doctor.js';
import { runInitCommand } from './init.js';
import { runSetupCommand } from './setup.js';
import {
  runConfigGetCommand,
  runConfigSetCommand,
  runConfigListCommand,
} from './config.js';
import { runStatusCommand } from './status.js';
import { runApproveCommand, runRejectCommand } from './approve.js';
import { runRunCommand, runRetryCommand } from './run.js';
import { runReviewCommand } from './review.js';
import { runCleanCommand } from './clean.js';
import {
  DEFAULT_UI_HOST,
  DEFAULT_UI_PORT,
  runUiCommand,
  type UiOptions,
} from './ui.js';
import { readVersion } from './version.js';
import {
  runCancelCommand,
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
    .action(async (options: { force?: boolean }, command: Command) => {
      exitCode = await runInitCommand(options, globalOptions(command));
    });

  program
    .command('feature')
    .description('Plan a feature: discovery → impact → SDD → plan → review')
    .argument('<description>', 'what the feature should do')
    .option('--no-cache', 'ignore the cached repository map and re-run discovery')
    .option('--from <stage>', 'resume from a stage (discovery, architecture-impact, sdd, planning)')
    .option('--skip-review', 'stop after planning, without the automated review')
    .option('--workflow <class>', 'workflow class override: trivial, simple, standard, high-risk')
    .action(
      async (
        description: string,
        options: { cache?: boolean; from?: string; skipReview?: boolean; workflow?: string },
        command: Command,
      ) => {
        exitCode = await runFeatureCommand(description, options, globalOptions(command));
      },
    );

  program
    .command('status')
    .description('Show the active run, its progress and anything degraded')
    .action(async (_options: unknown, command: Command) => {
      exitCode = await runStatusCommand(globalOptions(command));
    });

  program
    .command('approve')
    .description('Approve the plan so implementation may begin')
    .option('--force', 'approve despite a failed or missing review (recorded on the run)')
    .action(async (options: { force?: boolean }, command: Command) => {
      exitCode = await runApproveCommand(options, globalOptions(command));
    });

  program
    .command('reject')
    .description('Close this run without implementing it')
    .argument('[reason]', 'why the plan was rejected')
    .action(async (reason: string | undefined, _options: unknown, command: Command) => {
      exitCode = await runRejectCommand(reason, globalOptions(command));
    });

  program
    .command('revise')
    .description('Re-plan with an extra instruction, invalidating any approval')
    // Optional, because the instruction may come from a file, stdin or an editor instead.
    // A multi-paragraph revision does not survive being a shell argument (AR-08).
    .argument('[instruction]', 'what to change about the plan, or - to read stdin')
    .option('--file <path>', 'read the instruction from a file')
    .option('--edit', 'write the instruction in $EDITOR')
    .action(
      async (
        instruction: string | undefined,
        options: { file?: string; edit?: boolean },
        command: Command,
      ) => {
        exitCode = await runReviseCommand(
          { argument: instruction, file: options.file, edit: options.edit },
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

  program
    .command('retry')
    .description('Queue a task again after it failed')
    .argument('<taskId>', 'for example TASK-004')
    .option('--force', 'retry a BLOCKED task, or exceed the attempt limit')
    .action(async (taskId: string, options: { force?: boolean }, command: Command) => {
      exitCode = await runRetryCommand(taskId, options, globalOptions(command));
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

  program
    .command('cancel')
    .description('End the run and terminate its agents; keeps every artifact')
    .option('--yes', 'confirm: cancelling is not reversible')
    .action(async (options: { yes?: boolean }, command: Command) => {
      exitCode = await runCancelCommand(options, globalOptions(command));
    });

  program
    .command('review')
    .description('Run validation, inspect the implementation and judge it against the SDD')
    .option('--fix', 'report the corrective tasks the findings would produce')
    .action(async (options: { fix?: boolean }, command: Command) => {
      exitCode = await runReviewCommand(options, globalOptions(command));
    });

  program
    .command('ui')
    .description('Serve the local dashboard for this project, or for a workspace of them')
    .argument('[root]', 'directory to scan for projects (defaults to the current one)')
    .option('--port <port>', `port to listen on (default ${String(DEFAULT_UI_PORT)})`)
    .option('--host <host>', `address to bind (default ${DEFAULT_UI_HOST})`)
    .option('--no-open', 'do not open a browser')
    .option('--depth <n>', 'how deep to look for projects (default: ui.workspaceDepth, or 2)')
    .action(async (root: string | undefined, options: UiOptions, command: Command) => {
      exitCode = await runUiCommand(root, options, globalOptions(command));
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

  try {
    await program.parseAsync(argv);
    return exitCode;
  } catch (error) {
    // Commander throws for `--help` and `--version`; those are not failures.
    if (isCommanderExit(error)) return (error as { exitCode?: number }).exitCode ?? ExitCode.OK;

    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

function isCommanderExit(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    String((error as { code: unknown }).code).startsWith('commander.')
  );
}
