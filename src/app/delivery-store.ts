import { DeliveryRecordSchema, type DeliveryRecord } from '../contracts/index.js';
import type { FileSystem } from '../ports/index.js';
import { runPaths } from './paths.js';
import type { DeliveryRecordStore } from './delivery-service.js';

/**
 * Where a run's delivery record lives (M7 §16).
 *
 * **One document rather than a log, and this is the exception that proves the rule.**
 * Every other state in this product is a fold over an append-only log, and delivery is
 * too — the *events* are the history. This file is the folded answer, kept because the
 * remote objects it names are the only facts here that cannot be re-derived: an Issue
 * number is something GitHub decided, not something a projection can compute.
 *
 * Tolerant on read, following `readReviews`: a malformed file is "no record" rather than a
 * fatal error, because a parse failure must not read as "nothing was ever published" *and*
 * must not stop a run that already completed.
 */
export class DeliveryStore implements DeliveryRecordStore {
  constructor(
    private readonly options: { readonly fs: FileSystem; readonly projectDir: string },
  ) {}

  async read(runId: string): Promise<DeliveryRecord | undefined> {
    const path = runPaths(this.options.projectDir, runId).delivery;
    if (!(await this.options.fs.exists(path))) return undefined;

    try {
      const parsed = DeliveryRecordSchema.safeParse(JSON.parse(await this.options.fs.readFile(path)));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async write(record: DeliveryRecord): Promise<void> {
    const path = runPaths(this.options.projectDir, record.runId).delivery;
    await this.options.fs.writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
  }
}
