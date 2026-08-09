import type { ProcessRunner } from '../../ports/process-runner.js';

export interface GitChange {
  readonly path: string;
  readonly status: string;
}

/**
 * The bits of git the workflow needs.
 *
 * Deliberately no full diff. Without worktrees every task writes to the same
 * tree, so by review time the accumulated diff can be thousands of lines — and
 * pasting that into a prompt is how a reviewer runs out of context before it
 * reaches the interesting part (R-12). The reviewer gets a summary and the file
 * list, and reads what it needs: it has the repository, read-only.
 */
export class GitClient {
  constructor(
    private readonly processRunner: ProcessRunner,
    private readonly cwd: string,
  ) {}

  async isRepository(): Promise<boolean> {
    const result = await this.run(['rev-parse', '--is-inside-work-tree']);
    return result.exitCode === 0 && result.stdout.trim() === 'true';
  }

  /** `git diff --stat` against HEAD, including untracked files. */
  async diffStat(): Promise<string> {
    const result = await this.run(['diff', '--stat', 'HEAD']);
    const tracked = result.exitCode === 0 ? result.stdout.trim() : '';

    const untracked = await this.untrackedFiles();
    if (untracked.length === 0) return tracked || 'No changes against HEAD.';

    return [tracked, '', 'Untracked files:', ...untracked.map((path) => `  ${path}`)]
      .filter((line) => line !== '')
      .join('\n');
  }

  /** Changed paths with their status letters, plus untracked files. */
  async changedFiles(): Promise<GitChange[]> {
    const result = await this.run(['status', '--porcelain=v1']);
    if (result.exitCode !== 0) return [];

    return result.stdout
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3).trim() }));
  }

  /** True when nothing has been modified — used to prove a read-only stage behaved. */
  async isClean(): Promise<boolean> {
    return (await this.changedFiles()).length === 0;
  }

  private async untrackedFiles(): Promise<string[]> {
    const result = await this.run(['ls-files', '--others', '--exclude-standard']);
    return result.exitCode === 0
      ? result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
      : [];
  }

  private async run(args: string[]) {
    return this.processRunner.run({
      command: 'git',
      args,
      cwd: this.cwd,
      timeoutSeconds: 60,
      maxOutputBytes: 256 * 1024,
    });
  }
}

/** Compact rendering of a change list for a prompt. */
export function renderChanges(changes: readonly GitChange[]): string {
  if (changes.length === 0) return 'No files were changed.';
  return changes.map((change) => `- ${change.status.padEnd(2)} ${change.path}`).join('\n');
}
