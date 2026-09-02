import {
  AgentMessageSchema,
  BlackboardEntrySchema,
  type AgentMessage,
  type BlackboardEntry,
} from '../contracts/index.js';
import type { FileSystem } from '../ports/index.js';
import { runPaths } from './paths.js';

/**
 * The two append-only logs a run's collaboration lives in (M4-02).
 *
 * **Append-only, and that is the design rather than an implementation detail.** §42 of
 * this milestone's charter forbids one agent silently overwriting another's contribution;
 * a store with an update method would make that a rule somebody has to remember rather
 * than a shape nobody can express. There is no `updateMessage` here and there must not be
 * one — a correction is a new line naming the one it corrects, and the projection decides
 * what the pair means.
 *
 * Two logs rather than one, because they are two concepts with two lifecycles:
 * conversation is a sequence, and knowledge is a set with supersession. One log would
 * have made the blackboard a projection over messages, which reads elegantly right up to
 * the point where an entry needs a status that a message never has.
 *
 * **Handoffs are *not* a third log.** A handoff is a conversation — request, accept or
 * reject — and modelling it separately would give one exchange two records that a crash
 * between two writes could make disagree.
 *
 * No Git, no process, no state machine (I-27). This class reads and appends lines.
 */

export interface CollaborationStoreOptions {
  readonly fs: FileSystem;
  readonly projectDir: string;
}

export class CollaborationStore {
  private readonly fs: FileSystem;
  private readonly projectDir: string;

  constructor(options: CollaborationStoreOptions) {
    this.fs = options.fs;
    this.projectDir = options.projectDir;
  }

  /**
   * Every message in the run, in the order they were written.
   *
   * **Tolerant, following `readEventsBestEffort`.** A malformed line is skipped rather
   * than fatal, because the alternative is that one bad legacy line loses every valid
   * message beside it — and a run whose collaboration view is empty reads as "nobody
   * said anything", which is the wrong thing to conclude from a parse error.
   *
   * A run created before M4 has no file at all, which is `[]` and never an error.
   */
  async readMessages(runId: string): Promise<AgentMessage[]> {
    return this.readLines(runPaths(this.projectDir, runId).messages, (value) =>
      AgentMessageSchema.safeParse(value),
    );
  }

  async readEntries(runId: string): Promise<BlackboardEntry[]> {
    return this.readLines(runPaths(this.projectDir, runId).blackboard, (value) =>
      BlackboardEntrySchema.safeParse(value),
    );
  }

  /**
   * Appends messages, validating each one first.
   *
   * Validated here as well as at the harvest, and deliberately: this is the last gate
   * before something becomes part of the run's record, and a second caller — a future
   * MCP transport, a CLI command — must not be able to write a line the readers cannot
   * parse. The cost is one parse of data that is usually already valid.
   *
   * One `appendFile` call for the whole batch, so a wave of five messages is one write
   * rather than five. `O_APPEND` places each write at the end of the file, which is what
   * lets eight concurrent tasks harvest without a lock: the failure a lock would prevent
   * is a *partial* line, and a single small write cannot produce one.
   */
  async appendMessages(runId: string, messages: readonly AgentMessage[]): Promise<void> {
    if (messages.length === 0) return;

    const lines = messages.map((message) => `${JSON.stringify(AgentMessageSchema.parse(message))}\n`);
    await this.append(runPaths(this.projectDir, runId).messages, lines.join(''));
  }

  async appendEntries(runId: string, entries: readonly BlackboardEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const lines = entries.map((entry) => `${JSON.stringify(BlackboardEntrySchema.parse(entry))}\n`);
    await this.append(runPaths(this.projectDir, runId).blackboard, lines.join(''));
  }

  private async append(path: string, content: string): Promise<void> {
    // Created on first write rather than at run creation, so a run that never used
    // collaboration leaves no empty directory to explain.
    await this.fs.mkdirp(path.slice(0, path.lastIndexOf('/')));
    await this.fs.appendFile(path, content);
  }

  private async readLines<T>(
    path: string,
    parse: (value: unknown) => { success: true; data: T } | { success: false },
  ): Promise<T[]> {
    if (!(await this.fs.exists(path))) return [];

    const parsed: T[] = [];
    for (const line of (await this.fs.readFile(path)).split('\n')) {
      const candidate = line.trim();
      if (candidate.length === 0) continue;
      try {
        const result = parse(JSON.parse(candidate));
        if (result.success) parsed.push(result.data);
      } catch {
        // A line that is not JSON at all — a torn write from a killed process, or a file
        // edited by hand. Absent from this read model, present on disk, and never a
        // reason to lose the lines around it.
      }
    }
    return parsed;
  }
}
