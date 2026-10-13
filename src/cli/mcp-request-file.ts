import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isAtOrUnderRoot } from '../core/path-containment.js';
import type { RequestFileOutcome } from './mcp-server.js';

/**
 * The request file `run_start` may name, read under a guard.
 *
 * **A model chooses this path**, so without a guard it is a way to make the MCP server read
 * any file on the machine — a key, a `.env` — and hand it to the hub as a feature request,
 * where it reaches a planner's prompt and the run's artifacts. What a request file really is
 * bounds it: a regular file, a few pages long, written under a project the hub serves or
 * under the temp directory, which is where the operator skill writes them (outside the
 * repository, so they never end up in a commit).
 *
 * Both sides of the containment check are resolved first (`realpath`, the asynchronous one,
 * which also expands a Windows 8.3 short name): a symlink inside the temp directory that
 * points at a home directory is judged by where it points.
 */

/** A story plus its refinement measured at a few KB; 32 KB is room for that, not for a dump. */
export const REQUEST_FILE_MAX_BYTES = 32 * 1024;

export interface RequestFileOptions {
  /** Where a relative path is resolved from: the directory the MCP server started in. */
  readonly cwd: string;
  /** The operating system's temp directory, the other place a request file may live. */
  readonly tempDir: string;
}

export async function readRequestFileGuarded(
  file: string,
  projectDirs: readonly string[],
  options: RequestFileOptions,
): Promise<RequestFileOutcome> {
  const requested = path.resolve(options.cwd, file);

  let real: string;
  try {
    real = await realpath(requested);
  } catch {
    return { ok: false, message: `Not sent: could not read ${file} (no such file).` };
  }

  // Where before what: a file outside is refused before anything about it is said, or the
  // size refusal would answer "how big is this file" about any path on the machine.
  const roots = await Promise.all(
    [...projectDirs, options.tempDir].map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return undefined;
      }
    }),
  );
  const inside = roots.some((root) => root !== undefined && isAtOrUnderRoot(root, real, path));
  if (!inside) {
    return {
      ok: false,
      message:
        `Not sent: ${file} is outside every project the hub serves and outside the temp ` +
        `directory (${options.tempDir}). A request file is read only from those places; write ` +
        'it under the temp directory or the project, then pass that path.',
    };
  }

  const info = await stat(real);
  if (!info.isFile()) {
    return { ok: false, message: `Not sent: ${file} is not a regular file. Name the request file itself.` };
  }
  if (info.size > REQUEST_FILE_MAX_BYTES) {
    return {
      ok: false,
      message:
        `Not sent: ${file} is ${String(info.size)} bytes, over the 32 KB a request file may be. ` +
        'Trim it to the story, its refinement and the link, or start the run from the CLI: ' +
        '`agent-flow feature --file <path>`.',
    };
  }

  return { ok: true, text: await readFile(real, 'utf8') };
}
