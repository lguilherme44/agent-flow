import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { SystemClock } from '../adapters/clock/system-clock.js';
import { NodeProcessRunner } from '../adapters/process/node-process-runner.js';
import { resolvePromptsDir } from '../app/prompt-paths.js';
import type { Clock, FileSystem, ProcessRunner } from '../ports/index.js';

/**
 * The real adapters, in one place, for the CLI to hand to a use case.
 *
 * This is what the CLI *is*: the process that decides the ports are the real ones.
 * The use cases below `src/app` used to construct these themselves, which meant
 * only one caller could ever drive them — the local server holds its own
 * `FileSystem`, and the test suite holds an in-memory one.
 */
export interface NodeAdapters {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly processRunner: ProcessRunner;
  readonly promptsDir: string;
}

export function nodeAdapters(): NodeAdapters {
  return {
    fs: new NodeFileSystem(),
    clock: new SystemClock(),
    processRunner: new NodeProcessRunner(),
    promptsDir: resolvePromptsDir(),
  };
}
