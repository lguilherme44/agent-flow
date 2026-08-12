import { GitCommand } from '../../src/adapters/git/git-command.js';
import type { ProcessRunner } from '../../src/ports/index.js';

/** Where {@link FakeHost} would put the owned empty hooks directory. */
export const FAKE_NO_HOOKS_DIR = '/fake-home/.agent-flow/no-hooks';

/**
 * A real `GitCommand` over a fake `ProcessRunner`.
 *
 * The wrapper itself is never faked — its whole job is the argv it builds, and a
 * stand-in that produced different argv would make every test above it a test of
 * the stand-in. What is faked is the process underneath, which is what lets a
 * unit test assert on the command line without a repository.
 */
export function testGitCommand(processRunner: ProcessRunner): GitCommand {
  return new GitCommand({ processRunner, noHooksDir: FAKE_NO_HOOKS_DIR });
}
