/**
 * Filesystem access, behind a port so state handling can be tested in memory.
 *
 * The interesting member is `writeFileAtomic`: run state must never be left
 * half-written, so the implementation writes to a temp file and renames (AD-06).
 * Making that part of the contract keeps the guarantee from being an
 * implementation detail an adapter could quietly drop.
 */
export interface FileSystem {
  readFile(path: string): Promise<string>;
  writeFileAtomic(path: string, content: string): Promise<void>;
  appendFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  readDir(path: string): Promise<string[]>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<{ isDirectory: boolean; mtimeMs: number; size: number } | null>;
}
