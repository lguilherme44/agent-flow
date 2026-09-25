import nodePath from 'node:path';
import type { GitResult } from '../adapters/git/git-command.js';
import type { GitWorkspaces } from '../adapters/git/git-workspaces.js';
import { directoryCandidates, mayNameDirectory } from '../core/directory-candidates.js';
import { isAtOrUnderRoot } from '../core/path-containment.js';
import type { FileSystem } from '../ports/index.js';
import { chooseInstructions, needsFallback } from './project-instructions.js';

/**
 * The instructions of every directory a task touches, read on the agent's behalf (N1).
 *
 * The runner's isolation flags stop the CLI from loading a nested `CLAUDE.md` itself —
 * measured 24/09/2026 with Claude Code 2.1.281: a `sub/CLAUDE.md` rule was obeyed without
 * the flags and ignored with `--setting-sources '' --safe-mode` — so the orchestrator opens
 * those files and hands their text to the stage.
 *
 * That makes this the same kind of read as the implementation stage's root `AGENTS.md`
 * (T6, PRI-20): the orchestrator's privileges, no sandbox, and a repository deciding what
 * the file is. The same two bounds apply, per file — a size cap with an explicit marker,
 * and no symlink followed out of the tree (FR-008) — and one more: a directory Git ignores
 * is not the repository's, so its rules are not read (FR-005).
 *
 * **It never throws** (FR-009). The files are a convenience; a task that could not run
 * because one directory held a strange one would be a worse outcome than a task that runs
 * without that directory's rules. So a failure skips *that directory*, is recorded with a
 * repository-relative name — never an absolute path, which would reach persisted events
 * (SEC-008) — and every other directory is still read.
 */

export type DirectorySkipReason =
  | 'not_a_file'
  | 'unreadable'
  | 'unresolvable'
  | 'outside_tree'
  | 'ignore_check_failed';

export interface DirectorySkip {
  /** Repository-relative, with `/`, whatever the host separator is (NFR-005). */
  readonly directory: string;
  readonly reason: DirectorySkipReason;
}

export interface DirectoryInstructions {
  /** The rendered block, or `''` when no directory contributed text. */
  readonly block: string;
  readonly skipped: readonly DirectorySkip[];
}

/**
 * The three calls the reader makes, and no more — so the code-review adapter, whose fs is
 * deliberately narrow, can hand over what it has rather than a whole filesystem.
 */
export type InstructionsFileSystem = Pick<FileSystem, 'readFile' | 'stat' | 'realPath'>;

export interface DirectoryInstructionsDeps {
  readonly fs: InstructionsFileSystem;
  /** Whether Git's ignore rules close `directory` (repository-relative, no trailing `/`). */
  isIgnoredDirectory(cwd: string, directory: string): Promise<GitResult<boolean>>;
}

/**
 * The ignore question FR-005 asks, over the Git adapter.
 *
 * Here rather than at each wiring site because both halves of the question are part of the
 * rule, and a caller that forgot either would get a plausible wrong answer: `--no-index`,
 * because without it a force-added `AGENTS.md` inside an ignored directory reopens it
 * (measured, see `GitWorkspaces.isIgnored`), and the trailing `/`, so Git judges the path
 * as a directory and a directory-only rule (`sub/`) applies whatever is on disk.
 */
export function gitIgnoredDirectory(
  workspaces: Pick<GitWorkspaces, 'isIgnored'>,
): DirectoryInstructionsDeps['isIgnoredDirectory'] {
  return (cwd, directory) => workspaces.isIgnored({ cwd, path: `${directory}/`, noIndex: true });
}

/**
 * How much of one nested instruction file reaches a prompt.
 *
 * The implementation reader's number (`MAX_AGENTS_MD_BYTES` in `task-executor.ts`), and
 * measured the same way — in string length, as that reader does — so a nested file and the
 * root file are held to one bound rather than two that disagree.
 */
const MAX_INSTRUCTIONS_BYTES = 64 * 1024;

const HEADING = '## Directory instructions';

type FileRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'skip'; readonly reason: DirectorySkipReason };

export async function readDirectoryInstructions(
  deps: DirectoryInstructionsDeps,
  input: { readonly treeRoot: string; readonly likely: readonly string[] },
): Promise<DirectoryInstructions> {
  const { treeRoot } = input;
  const candidates = directoryCandidates(input.likely, await existingDirectories(deps.fs, input));
  // NFR-003: a task that touches nothing below the root costs no Git call and no read.
  if (candidates.length === 0) return { block: '', skipped: [] };

  const root = await resolveQuietly(deps.fs, treeRoot);
  const excluded: string[] = [];
  const skipped: DirectorySkip[] = [];
  const sections: string[] = [];

  for (const directory of candidates) {
    // Candidates arrive shallowest first, so an ignored parent is always decided before
    // its children — and a directory under an ignored one is ignored by Git's own rule,
    // so asking again would cost a process for an answer already known.
    if (excluded.some((parent) => directory.startsWith(`${parent}/`))) continue;

    const ignored = await askIgnored(deps, treeRoot, directory);
    if (ignored === 'failed') {
      // Fails closed: a directory whose status is unknown may be one the rules close.
      skipped.push({ directory, reason: 'ignore_check_failed' });
      continue;
    }
    if (ignored) {
      excluded.push(directory);
      continue;
    }

    const agents = await readBounded(deps.fs, root, treeRoot, directory, 'AGENTS.md');
    if (agents.kind === 'skip') {
      skipped.push({ directory, reason: agents.reason });
      continue;
    }
    const agentsText = agents.kind === 'text' ? agents.text : undefined;

    let claudeText: string | undefined;
    if (needsFallback(agentsText)) {
      const claude = await readBounded(deps.fs, root, treeRoot, directory, 'CLAUDE.md');
      if (claude.kind === 'skip') {
        skipped.push({ directory, reason: claude.reason });
        continue;
      }
      claudeText = claude.kind === 'text' ? claude.text : undefined;
    }

    const chosen = chooseInstructions(agentsText, claudeText);
    if (chosen.source === 'none') continue;
    sections.push(`### ${directory}/${chosen.source}\n\n${chosen.text.trimEnd()}`);
  }

  // Nothing at all when nothing contributed — not even the heading — so a repository
  // with no nested instruction files gets exactly today's prompt (NFR-001).
  const block = sections.length === 0 ? '' : [HEADING, ...sections].join('\n\n');
  return { block, skipped };
}

/**
 * The `likely` entries that are directories on disk, for FR-003's "names an existing
 * directory". A failed look is "not a directory": it decides only whether the entry adds
 * itself, and its ancestors are candidates either way.
 */
async function existingDirectories(
  fs: InstructionsFileSystem,
  input: { readonly treeRoot: string; readonly likely: readonly string[] },
): Promise<string[]> {
  const found: string[] = [];
  for (const entry of input.likely.filter(mayNameDirectory)) {
    try {
      const stat = await fs.stat(`${input.treeRoot}/${entry}`);
      if (stat?.isDirectory === true) found.push(entry);
    } catch {
      // Not a directory this reader can see; the entry contributes its ancestors only.
    }
  }
  return found;
}

async function askIgnored(
  deps: DirectoryInstructionsDeps,
  treeRoot: string,
  directory: string,
): Promise<boolean | 'failed'> {
  try {
    const answer = await deps.isIgnoredDirectory(treeRoot, directory);
    return answer.ok ? answer.value : 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * One instruction file, under FR-008's bounds, or the reason it was not read.
 *
 * The order is the order of the questions: is there a file, is it a file, where does it
 * really live, is that inside the tree — and only then is it opened. Reading first and
 * checking after would already have pulled the bytes of whatever a link pointed at into
 * this process.
 */
async function readBounded(
  fs: InstructionsFileSystem,
  root: string | null,
  treeRoot: string,
  directory: string,
  name: 'AGENTS.md' | 'CLAUDE.md',
): Promise<FileRead> {
  const path = `${treeRoot}/${directory}/${name}`;

  let stat: Awaited<ReturnType<FileSystem['stat']>>;
  try {
    stat = await fs.stat(path);
  } catch {
    return { kind: 'skip', reason: 'unreadable' };
  }
  if (stat === null) return { kind: 'absent' };
  if (stat.isDirectory) return { kind: 'skip', reason: 'not_a_file' };

  const resolved = await resolveQuietly(fs, path);
  // An unresolvable tree root is the same unknown as an unresolvable file: containment
  // cannot be decided, so the file is not read.
  if (resolved === null || root === null) return { kind: 'skip', reason: 'unresolvable' };
  if (resolved === root || !isAtOrUnderRoot(root, resolved, nodePath)) {
    return { kind: 'skip', reason: 'outside_tree' };
  }

  let content: string;
  try {
    content = await fs.readFile(path);
  } catch {
    return { kind: 'skip', reason: 'unreadable' };
  }
  return { kind: 'text', text: bounded(name, content) };
}

async function resolveQuietly(fs: InstructionsFileSystem, path: string): Promise<string | null> {
  try {
    return await fs.realPath(path);
  } catch {
    return null;
  }
}

/** The implementation reader's truncation, marker included, so both read the same. */
function bounded(name: string, content: string): string {
  if (content.length <= MAX_INSTRUCTIONS_BYTES) return content;
  return (
    `${content.slice(0, MAX_INSTRUCTIONS_BYTES)}\n\n` +
    `… [truncated: ${name} is ${String(content.length)} bytes and this prompt ` +
    `carries the first ${String(MAX_INSTRUCTIONS_BYTES)}]`
  );
}
