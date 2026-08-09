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
