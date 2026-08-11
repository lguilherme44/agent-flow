import type { FileSystem } from '../../src/ports/index.js';

/**
 * In-memory FileSystem for tests.
 *
 * `writeFileAtomic` is modelled honestly: `failNextAtomicWriteAfterTemp` lets a
 * test crash the process between the temp write and the rename, which is the
 * exact window the real implementation exists to survive.
 */
export class InMemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>(['/']);

  /** Set by a test to simulate a crash mid-write. */
  failNextAtomicWriteAfterTemp = false;

  /** Every path handed to writeFileAtomic, in order. Includes temp files. */
  readonly writes: string[] = [];

  seed(path: string, content: string): void {
    this.ensureParents(path);
    this.files.set(path, content);
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files);
  }

  private ensureParents(path: string): void {
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts.slice(0, -1)) {
      current += `/${part}`;
      this.dirs.add(current);
    }
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }

  async writeFileAtomic(path: string, content: string): Promise<void> {
    const temp = `${path}.tmp`;
    this.writes.push(temp);
    this.files.set(temp, content);

    if (this.failNextAtomicWriteAfterTemp) {
      this.failNextAtomicWriteAfterTemp = false;
      throw new Error('simulated crash between write and rename');
    }

    this.files.delete(temp);
    this.ensureParents(path);
    this.files.set(path, content);
    this.writes.push(path);
  }

  async appendFile(path: string, content: string): Promise<void> {
    this.ensureParents(path);
    this.files.set(path, (this.files.get(path) ?? '') + content);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  async mkdirp(path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      this.dirs.add(current);
    }
  }

  async readDir(path: string): Promise<string[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const entries = new Set<string>();
    for (const key of [...this.files.keys(), ...this.dirs]) {
      if (!key.startsWith(prefix) || key === path) continue;
      const rest = key.slice(prefix.length);
      const head = rest.split('/')[0];
      if (head) entries.add(head);
    }
    return [...entries].sort();
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.dirs.delete(path);
    const prefix = `${path}/`;
    for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) this.files.delete(key);
    for (const key of [...this.dirs]) if (key.startsWith(prefix)) this.dirs.delete(key);
  }

  /**
   * Atomic here because the whole fake is single-threaded.
   *
   * Which is exactly why it cannot prove the lock: an in-memory map has no TOCTOU
   * window to lose, so a passing test here says nothing about two real processes.
   * That is what `test/app/run-execution-lock.race.test.ts` is for. This fake is
   * for the *policy* — stale recovery, cross-host caution, the refusal shape.
   */
  async createExclusive(path: string, content: string): Promise<boolean> {
    if (this.files.has(path)) return false;
    this.ensureParents(path);
    this.files.set(path, content);
    return true;
  }

  async rename(from: string, to: string): Promise<boolean> {
    const content = this.files.get(from);
    if (content === undefined) return false;

    this.files.delete(from);
    this.ensureParents(to);
    this.files.set(to, content);
    return true;
  }

  async stat(path: string): Promise<{ isDirectory: boolean; mtimeMs: number; size: number } | null> {
    if (this.dirs.has(path)) return { isDirectory: true, mtimeMs: 0, size: 0 };
    const content = this.files.get(path);
    if (content === undefined) return null;
    return { isDirectory: false, mtimeMs: 0, size: content.length };
  }
}
