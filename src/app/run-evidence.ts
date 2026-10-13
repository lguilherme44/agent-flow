import { isAbsolute } from 'node:path';
import type { FileSystem } from '../ports/file-system.js';

/**
 * Images a person can look at, kept in the run (dogfood 09/10).
 *
 * The e2e stage kept text only and its prompt sent screenshots to `$TMPDIR`, where nothing
 * could find them again; a human's `--e2e-observed` had no way to attach what they saw.
 * Both now land under `runs/<id>/evidence/`, and the run records them by their path relative
 * to the run directory — never an absolute path, which names the machine's user (§21.3).
 *
 * Kept local. Nothing here masks personal data in an image, so nothing here publishes one.
 */

/** What counts as evidence: images, by extension. */
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

/** The largest file `--evidence` copies in: a screenshot, not a screen recording. */
export const EVIDENCE_MAX_BYTES = 20 * 1024 * 1024;

/** A filesystem-safe name for one moment, so each review keeps its own folder. */
export function evidenceStamp(at: string): string {
  return at.replaceAll(/[:.]/g, '-');
}

/** The images directly inside `runDir/relativeDir`, as run-relative paths, sorted. */
export async function listEvidence(fs: FileSystem, runDir: string, relativeDir: string): Promise<string[]> {
  const dir = `${runDir}/${relativeDir}`;
  if (!(await fs.exists(dir))) return [];
  const names = await fs.readDir(dir);
  return names
    .filter((name) => IMAGE.test(name))
    .sort()
    .map((name) => `${relativeDir}/${name}`);
}

export type EvidenceCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly file: string; readonly reason: 'not_local' | 'not_an_image' | 'missing' | 'too_large' };

/** Judged before anything is recorded: a bad file refuses the whole observation. */
export async function checkEvidenceFiles(fs: FileSystem, files: readonly string[]): Promise<EvidenceCheck> {
  for (const file of files) {
    // Judged by its shape before anything touches it: a network path (\\host or //host) makes the
    // hub reach for a share — and on Windows offer its credentials — and a relative one
    // resolves against wherever the hub runs (adversarial review).
    if (/^[\\/]{2}/.test(file) || !isAbsolute(file)) return { ok: false, file, reason: 'not_local' };
    if (!IMAGE.test(file)) return { ok: false, file, reason: 'not_an_image' };
    const stat = await fs.stat(file);
    if (stat === null || stat.isDirectory) return { ok: false, file, reason: 'missing' };
    if (stat.size > EVIDENCE_MAX_BYTES) return { ok: false, file, reason: 'too_large' };
  }
  return { ok: true };
}

/** Copies checked files into `runDir/relativeDir`, keeping their names; returns run-relative paths. */
export async function copyEvidence(
  fs: FileSystem,
  runDir: string,
  relativeDir: string,
  files: readonly string[],
): Promise<string[]> {
  await fs.mkdirp(`${runDir}/${relativeDir}`);
  const copied: string[] = [];
  for (const [index, file] of files.entries()) {
    const base = file.split(/[\\/]/).at(-1) ?? `evidence-${String(index + 1)}`;
    // Two files with one name (two phones, one `screenshot.png`) must not overwrite each other.
    // Compared without case: Windows and macOS would let `Shot.png` overwrite `shot.png`.
    const taken = copied.some((path) => path.toLowerCase().endsWith(`/${base.toLowerCase()}`));
    const name = taken ? `${String(index + 1)}-${base}` : base;
    await fs.copyFile(file, `${runDir}/${relativeDir}/${name}`);
    copied.push(`${relativeDir}/${name}`);
  }
  return copied;
}
