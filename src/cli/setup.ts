import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import type { GlobalOptions } from './index.js';
import { nodeAdapters } from './adapters.js';
import { detectStack } from '../config/stack-detection.js';
import { runInitCommand } from './init.js';
import { runDoctorCommand } from './doctor.js';

export interface SetupOptions {
  readonly force?: boolean;
  readonly yes?: boolean;
}

export async function runSetupCommand(
  options: SetupOptions,
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  const adapters = nodeAdapters();

  process.stdout.write('=== Agent Flow Setup Wizard ===\n\n');

  // 1. Verify Git Repository
  const isGit = await adapters.fs.exists(`${globals.cwd}/.git`);
  if (!isGit) {
    process.stderr.write('Error: Current directory is not a Git repository. Run `git init` first.\n');
    return ExitCode.CONFIG_ERROR;
  }
  process.stdout.write('✓ Git repository verified\n');

  // 2. Project Detection
  const stack = await detectStack(adapters.fs, globals.cwd);
  process.stdout.write(`✓ Detected project type: ${stack.type} (${stack.name})\n`);

  // 3. Initialize Agent Flow config & AGENTS.md
  process.stdout.write('\nInitializing repository configuration...\n');
  const initCode = await runInitCommand({ force: options.force }, globals);
  if (initCode !== ExitCode.OK) {
    return initCode;
  }

  // 4. Environment & Doctor Checks
  process.stdout.write('\nRunning environment checks...\n');
  const doctorCode = await runDoctorCommand({}, globals);

  process.stdout.write('\nSetup completed successfully!\n');
  return doctorCode === ExitCode.OK ? ExitCode.OK : ExitCode.OK;
}
