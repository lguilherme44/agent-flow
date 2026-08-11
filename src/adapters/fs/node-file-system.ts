import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
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
    const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);

    await fs.writeFile(temp, content, 'utf8');
    try {
      await fs.rename(temp, path);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
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

  async remove(path: string): Promise<void> {
    await fs.rm(path, { recursive: true, force: true });
  }

  /**
   * `wx` — create for writing, fail if it exists. One syscall, no window.
   *
   * This is the entire basis of the run lock. `exists()` then `write()` would leave
   * a gap in which two processes both decide the file is absent, and the kernel is
   * the only party that can settle it.
   */
  async createExclusive(path: string, content: string): Promise<boolean> {
    await this.mkdirp(dirname(path));

    let handle;
    try {
      handle = await fs.open(path, 'wx');
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') return false;
      throw error;
    }

    try {
      await handle.writeFile(content, 'utf8');
      return true;
    } finally {
      await handle.close();
    }
  }

  async stat(path: string): Promise<{ isDirectory: boolean; mtimeMs: number; size: number } | null> {
    try {
      const stats = await fs.stat(path);
      return { isDirectory: stats.isDirectory(), mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      return null;
    }
  }
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
