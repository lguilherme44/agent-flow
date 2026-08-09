import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import { runFeatureCommand, runReviseCommand } from './feature.js';
import { runDoctorCommand } from './doctor.js';
import { runInitCommand } from './init.js';
import { runStatusCommand } from './status.js';
import { runApproveCommand, runRejectCommand } from './approve.js';
import { runRunCommand, runRetryCommand } from './run.js';
import { runReviewCommand } from './review.js';
import { runCleanCommand } from './clean.js';

/** Resolved from package.json so `--version` cannot drift from what is installed. */
function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of ['../../package.json', '../../../package.json']) {
    try {
      const raw = readFileSync(join(here, candidate), 'utf8');
      return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
    } catch {
      continue;
    }
  }
  return '0.0.0';
}

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
    .action(
      async (
        description: string,
        options: { cache?: boolean; from?: string; skipReview?: boolean },
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
    .argument('<instruction>', 'what to change about the plan')
    .action(async (instruction: string, _options: unknown, command: Command) => {
      exitCode = await runReviseCommand(instruction, globalOptions(command));
    });

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
    .command('review')
    .description('Run validation, inspect the implementation and judge it against the SDD')
    .option('--fix', 'report the corrective tasks the findings would produce')
    .action(async (options: { fix?: boolean }, command: Command) => {
      exitCode = await runReviewCommand(options, globalOptions(command));
    });

  program
    .command('clean')
    .description('Remove old run state')
    .option('--keep <n>', 'how many recent runs to keep (default 5)')
    .option('--cache', 'also drop the cached repository map')
    .option('--force', 'remove the active run too')
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
