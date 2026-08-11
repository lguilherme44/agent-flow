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

  /**
   * Set by a test to fail one specific write, by path and content.
   *
   * Coarser hooks were not enough for AF-L01.1: the failures worth testing are "the
   * append of *this* audit event throws" and "the write of `state.json` throws", and a
   * counter would break the moment an unrelated write was added ahead of it.
   */
  failWrite?: (operation: 'append' | 'atomic', path: string, content: string) => Error | undefined;

  /** Every path handed to writeFileAtomic, in order. Includes temp files. */
  readonly writes: string[] = [];

  /** Symbolic links, as link path → what it really is. */
  private readonly links = new Map<string, string>();

  seed(path: string, content: string): void {
    this.ensureParents(path);
    this.files.set(path, content);
  }

  /**
   * Declares `path` to be a symbolic link to `target`.
   *
   * Reads go through it, which is the point: a fake where a link resolved but
   * nothing behind it was reachable would let a discovery test pass by finding
   * nothing, for the wrong reason. Every read below resolves the longest declared
   * link that prefixes the path, so `/wk/current/.agent-flow/config.yaml` is the
   * file at the target — exactly the situation UI-29's containment rule exists
   * for.
   */
  link(path: string, target: string): void {
    this.links.set(path, target);
    this.mkdirpSync(path);
  }

  /** The longest declared link that prefixes `path`, applied. */
  private resolve(path: string): string {
    const longest = [...this.links.keys()]
      .filter((link) => path === link || path.startsWith(`${link}/`))
      .sort((a, b) => b.length - a.length)[0];

    return longest === undefined
      ? path
      : `${this.links.get(longest) ?? longest}${path.slice(longest.length)}`;
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
    const content = this.files.get(this.resolve(path));
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }

  async writeFileAtomic(path: string, content: string): Promise<void> {
    const injected = this.failWrite?.('atomic', path, content);
    if (injected !== undefined) throw injected;

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
    const injected = this.failWrite?.('append', path, content);
    if (injected !== undefined) throw injected;

    this.ensureParents(path);
    this.files.set(path, (this.files.get(path) ?? '') + content);
  }

  async exists(path: string): Promise<boolean> {
    const resolved = this.resolve(path);
    return this.files.has(resolved) || this.dirs.has(resolved);
  }

  async mkdirp(path: string): Promise<void> {
    this.mkdirpSync(path);
  }

  private mkdirpSync(path: string): void {
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      this.dirs.add(current);
    }
  }

  async readDir(path: string): Promise<string[]> {
    const resolved = this.resolve(path);
    const prefix = resolved.endsWith('/') ? resolved : `${resolved}/`;
    const entries = new Set<string>();
    for (const key of [...this.files.keys(), ...this.dirs]) {
      if (!key.startsWith(prefix) || key === resolved) continue;
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

  async stat(path: string): Promise<{ isDirectory: boolean; mtimeMs: number; size: number } | null> {
    const resolved = this.resolve(path);
    if (this.dirs.has(resolved)) return { isDirectory: true, mtimeMs: 0, size: 0 };
    const content = this.files.get(resolved);
    if (content === undefined) return null;
    return { isDirectory: false, mtimeMs: 0, size: content.length };
  }

  async realPath(path: string): Promise<string | null> {
    return (await this.exists(path)) ? this.resolve(path) : null;
  }
}
