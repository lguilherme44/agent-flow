import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { FileSystem } from '../../ports/file-system.js';

/**
 * The real filesystem.
 *
 * `writeFileAtomic` writes to a sibling temp file and renames. Rename is atomic
 * within a filesystem, so a crash mid-write leaves the previous version intact
 * rather than a truncated one. Run state is read back on resume, and a partially
 * written `state.json` would lose work that was actually completed.
 */
export class NodeFileSystem implements FileSystem {
  async readFile(path: string): Promise<string> {
    return fs.readFile(path, 'utf8');
  }

  async writeFileAtomic(path: string, content: string): Promise<void> {
    await this.mkdirp(dirname(path));

    // Same directory as the target: rename is only atomic within a filesystem,
    // and a temp directory may well be on a different one.
    const temp = join(
      dirname(path),
      `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );

    await fs.writeFile(temp, content, 'utf8');

    // On Windows, rename can fail with EPERM, EBUSY, or EACCES if the target file
    // already exists and is locked or briefly held open by a reader (e.g. UI watcher,
    // antivirus, indexer). Retry with backoff, and fall back to copyFile + unlink if needed.
    const maxAttempts = process.platform === 'win32' ? 10 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await fs.rename(temp, path);
        return;
      } catch (error) {
        const err = error as { code?: string };
        const isWindowsLock =
          process.platform === 'win32' &&
          (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES');

        if (isWindowsLock && attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
          continue;
        }

        if (isWindowsLock) {
          try {
            await fs.copyFile(temp, path);
            await fs.rm(temp, { force: true });
            return;
          } catch {
            // If copyFile also fails, proceed to cleanup and throw original error
          }
        }

        await fs.rm(temp, { force: true });
        throw error;
      }
    }
  }

  async appendFile(path: string, content: string): Promise<void> {
    await this.mkdirp(dirname(path));
    await fs.appendFile(path, content, 'utf8');
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async mkdirp(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true });
  }

  async readDir(path: string): Promise<string[]> {
    try {
      return (await fs.readdir(path)).sort();
    } catch {
      return [];
    }
  }

  /**
   * `fs.rm -rf`, with the same Windows patience `writeFileAtomic` needed.
   *
   * Measured in a live run: removing a disposable checkout threw
   * `EBUSY: resource busy or locked, rmdir '…/read-only-planning-pid-41036-7'`. On Windows
   * a directory whose files were open moments ago stays locked for a beat — the agent
   * process that just exited, an indexer, an antivirus scan — and `rm` is not retried by
   * Node. `writeFileAtomic` above already carries this note for `rename`; `remove` had no
   * such tolerance, and a *cleanup* that throws is worse than one that is slow.
   *
   * `maxRetries` is Node's own backoff for exactly this, so the retry is the platform's
   * rather than a loop of ours.
   */
  async remove(path: string): Promise<void> {
    await fs.rm(path, {
      recursive: true,
      force: true,
      ...(process.platform === 'win32' ? { maxRetries: 10, retryDelay: 50 } : {}),
    });
  }

  /**
   * `wx` — create for writing, fail if it exists. One syscall, no window.
   *
   * This is the entire basis of the run lock. `exists()` then `write()` would leave
   * a gap in which two processes both decide the file is absent, and the kernel is
   * the only party that can settle it.
   *
   * **A claim this call cannot finish writing is removed again (AF-L01.1-B).** The
   * open is what wins the race, so once it returns the file exists and is ours — and
   * a failed write then leaves an empty `execution.lock.N` behind. The reader treats
   * an unreadable claim as held, which is the right call and exactly what makes this
   * dangerous: an empty file has no pid, so no liveness check can ever judge it stale,
   * and the run stays refused until a person deletes it by hand. Only the path this
   * call created is removed, and only on the path where its own write failed; an
   * `EEXIST` is somebody else's file and is never touched.
   */
  async createExclusive(path: string, content: string): Promise<boolean> {
    await this.mkdirp(dirname(path));

    let handle: FileHandle;
    try {
      handle = await fs.open(path, 'wx');
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') return false;
      throw error;
    }

    try {
      await handle.writeFile(content, 'utf8');
      await handle.close();
      return true;
    } catch (error) {
      await discard(handle, path);
      // The original failure, not whatever the cleanup made of it. A caller told
      // "unlink failed" would be looking at the wrong problem.
      throw error;
    }
  }

  /**
   * `fs.copyFile` — the kernel's copy, so bytes and nothing else cross.
   *
   * No `COPYFILE_EXCL`: the caller mirrors a working tree into a checkout that already
   * holds HEAD's version of the same path, so overwriting is the operation.
   */
  async copyFile(from: string, to: string): Promise<void> {
    await fs.copyFile(from, to);
  }

  async stat(path: string): Promise<{ isDirectory: boolean; mtimeMs: number; size: number } | null> {
    try {
      const stats = await fs.stat(path);
      return { isDirectory: stats.isDirectory(), mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      return null;
    }
  }

  /**
   * Separators are normalised to `/`, because callers compare these to each other.
   *
   * Everything in this codebase builds paths with `/`, and on Windows `realpath`
   * hands back `\`. A containment check between one of each would decide that
   * nothing is inside anything — which fails safe, but silently and wrongly.
   */
  async realPath(path: string): Promise<string | null> {
    try {
      return (await fs.realpath(path)).replace(/\\/g, '/');
    } catch {
      return null;
    }
  }
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/**
 * Undoes a claim `createExclusive` created but could not fill in.
 *
 * Both steps are best-effort, and neither may throw: the error worth reporting is the
 * one that made the claim unusable, and replacing it with an error about the cleanup
 * would hide it. The `close` is defensive rather than expected — it is the same call
 * the success path may have just failed at, and closing an already-closed handle
 * rejects.
 */
async function discard(handle: FileHandle, path: string): Promise<void> {
  await handle.close().catch(() => undefined);
  await fs.rm(path, { force: true }).catch(() => undefined);
}
