import { ReviewRecordSchema, type ReviewRecord } from '../contracts/index.js';
import type { FileSystem } from '../ports/index.js';
import { runPaths } from './paths.js';

/**
 * The append-only log a run's reviews live in (M6-01).
 *
 * **Append-only, like the two logs beside it, and for the sharper reason.** A review is a
 * statement somebody made about a tree at a moment; editing one would let a later opinion
 * rewrite an earlier one and leave no evidence that it had. A re-review is a *new record*
 * with a higher round, and the projection decides what the pair means — which is exactly
 * how the blackboard handles a superseded entry.
 *
 * There is no `updateReview` and there must not be one.
 *
 * **A finding's status is not here.** `open`, `acknowledged`, `disputed`, `fixed` and
 * `verified` are projected from facts the run already records (I-43); a column for them
 * would be a second copy, and it would be the copy a crash between two writes leaves
 * wrong. What is stored is what the reviewer said and what Agent Flow named it.
 *
 * No Git, no process, no state machine. This class reads and appends lines.
 */

export interface ReviewStoreOptions {
  readonly fs: FileSystem;
  readonly projectDir: string;
}

export class ReviewStore {
  private readonly fs: FileSystem;
  private readonly projectDir: string;

  constructor(options: ReviewStoreOptions) {
    this.fs = options.fs;
    this.projectDir = options.projectDir;
  }

  /**
   * Every review in the run, in the order they were written.
   *
   * Tolerant, following `readMessages` and `readEventsBestEffort`: a malformed line is
   * skipped rather than fatal, because one bad line losing every valid review beside it
   * would render as "nothing was reviewed" — which is the wrong thing to conclude from a
   * parse error, and the dangerous thing to conclude when a gate reads it.
   *
   * A run created before M6 has no file, which is `[]` and never an error.
   */
  async readReviews(runId: string): Promise<ReviewRecord[]> {
    const path = runPaths(this.projectDir, runId).reviews;
    if (!(await this.fs.exists(path))) return [];

    const records: ReviewRecord[] = [];
    for (const line of (await this.fs.readFile(path)).split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = ReviewRecordSchema.safeParse(JSON.parse(line));
        if (parsed.success) records.push(parsed.data);
      } catch {
        continue;
      }
    }

    return records;
  }

  /**
   * Appends one review, whole.
   *
   * One `appendFile` per record, so a crash between two reviews leaves the first intact
   * and the second absent — never half of either. The same guarantee the message log
   * gives, and the reason both are JSONL rather than a document that has to be rewritten.
   */
  async appendReview(runId: string, record: ReviewRecord): Promise<void> {
    const path = runPaths(this.projectDir, runId).reviews;
    await this.fs.mkdirp(runPaths(this.projectDir, runId).dir);
    await this.fs.appendFile(path, `${JSON.stringify(record)}\n`);
  }

  /**
   * The next id, derived by scanning rather than counted in a file.
   *
   * The same call `nextRunId` makes, for the same reason: a counter is a second source of
   * truth about how many reviews exist, and it is the one that survives a crash saying
   * something the log disagrees with.
   */
  async nextReviewId(runId: string): Promise<string> {
    const used = (await this.readReviews(runId))
      .map((record) => Number.parseInt(record.id.slice('REV-'.length), 10))
      .filter((value) => Number.isFinite(value));

    return `REV-${String(Math.max(0, ...used) + 1).padStart(4, '0')}`;
  }

  /** The next finding id in the run, across every review. Same derivation, same reason. */
  async nextFindingNumber(runId: string): Promise<number> {
    const used = (await this.readReviews(runId))
      .flatMap((record) => record.findings)
      .map((finding) => Number.parseInt(finding.id.slice('FIND-'.length), 10))
      .filter((value) => Number.isFinite(value));

    return Math.max(0, ...used) + 1;
  }
}
