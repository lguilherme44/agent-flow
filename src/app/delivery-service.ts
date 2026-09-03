import {
  DeliveryRecordSchema,
  type DeliveryRecord,
  type ForgeConfig,
  type ForgeFailure,
  type ForgeRepository,
} from '../contracts/index.js';
import type { ForgeProvider } from '../ports/index.js';
import { fingerprint, fingerprintMarker } from './forge-fingerprint.js';
import { sameRepository } from '../core/forge/repository.js';
import { runBranchFor } from '../core/forge/remote-ref.js';
import type { StateStore } from './state-store.js';

/**
 * Remote delivery, orchestrated (M7 §13, §18, §19, §20, §33, §36, §45).
 *
 * **Every mutation is: write the intent, call the remote, write the outcome.** A crash
 * between the call and the outcome is the case this whole design exists for, and it is
 * only recoverable because the intent was written first — a log of outcomes cannot tell
 * "we never tried" from "we tried and lost the answer", and those need opposite recoveries.
 *
 * **Nothing here can un-complete a run.** A forge failure is recorded on the delivery
 * record and the run's status is not touched, which is `§14` and also the difference
 * between a build system and a delivery system.
 *
 * Every write is separately gated by configuration. A method whose flag is off returns a
 * refusal rather than doing the work quietly, because "it was configured off" is
 * information an operator needs when they were expecting a pull request.
 */

export interface DeliveryPublisher {
  publish(input: {
    readonly runId: string;
    readonly commit: string;
    readonly remote: string;
    readonly cwd: string;
  }): Promise<
    | { readonly kind: 'published'; readonly branch: string; readonly commit: string }
    | { readonly kind: 'unchanged'; readonly branch: string; readonly commit: string }
    | { readonly kind: 'refused'; readonly reason: string; readonly detail: string }
  >;
}

export interface DeliveryServiceOptions {
  readonly store: StateStore;
  readonly config: ForgeConfig;
  readonly repository: ForgeRepository;
  readonly provider: ForgeProvider;
  readonly publisher: DeliveryPublisher;
  readonly records: DeliveryRecordStore;
  readonly clock: { now(): string };
  readonly projectDir: string;
  readonly remote: string;
}

/** Where the delivery record lives. Append-only, like every other log in this product. */
export interface DeliveryRecordStore {
  read(runId: string): Promise<DeliveryRecord | undefined>;
  write(record: DeliveryRecord): Promise<void>;
}

export type DeliveryStep<T> =
  | { readonly ok: true; readonly value: T; readonly adopted?: boolean }
  | { readonly ok: false; readonly failure: ForgeFailure };

export class DeliveryService {
  constructor(private readonly options: DeliveryServiceOptions) {}

  /**
   * Publishes the approved commit to this run's branch.
   *
   * The caller supplies the commit — this service does not decide which one is approved,
   * because that decision belongs to `decideQuality` and `checkDefinitionOfDone` and
   * copying it here would be a second answer.
   */
  async publish(runId: string, approvedCommit: string): Promise<DeliveryStep<string>> {
    const gate = this.gate('publish', this.options.config.publish.enabled);
    if (gate !== undefined) return gate;

    const mismatch = this.repositoryMismatch();
    if (mismatch !== undefined) return mismatch;

    await this.options.store.appendEvent(runId, 'forge_publish_requested', {
      runId,
      commit: approvedCommit,
      branch: runBranchFor(runId),
    });

    const outcome = await this.options.publisher.publish({
      runId,
      commit: approvedCommit,
      remote: this.options.remote,
      cwd: this.options.projectDir,
    });

    if (outcome.kind === 'refused') {
      const failure: ForgeFailure = {
        code: outcome.reason === 'remote_diverged' ? 'forge_remote_ref_conflict' : 'forge_unavailable',
        detail: outcome.detail,
      };
      await this.fail(runId, 'publish', failure, approvedCommit);
      return { ok: false, failure };
    }

    await this.options.store.appendEvent(runId, 'forge_branch_published', {
      branch: outcome.branch,
      commit: outcome.commit,
      // Verified against the remote by the publisher, not inferred from an exit code.
      verified: true,
    });

    await this.patch(runId, approvedCommit, (record) => ({
      ...record,
      remoteBranch: outcome.branch,
      sourceCommit: outcome.commit,
      failure: undefined,
    }));

    return { ok: true, value: outcome.branch, adopted: outcome.kind === 'unchanged' };
  }

  /**
   * Creates this run's Issue, or adopts the one a previous attempt already created.
   *
   * Recovery order is local evidence, then the remote's own copy of our mark, then create
   * (§19). "Create one more" is never an outcome.
   */
  async issue(runId: string, draft: { title: string; body: string }): Promise<DeliveryStep<number>> {
    const gate = this.gate('issues.create', this.options.config.issues.create);
    if (gate !== undefined) return gate;

    const mismatch = this.repositoryMismatch();
    if (mismatch !== undefined) return mismatch;

    const existing = await this.options.records.read(runId);
    if (existing?.issue !== undefined) {
      return { ok: true, value: existing.issue.number, adopted: true };
    }

    const marker = this.markerFor(runId, 'issue');
    await this.options.store.appendEvent(runId, 'forge_issue_create_requested', {
      fingerprint: marker,
    });

    const found = await this.options.provider.findIssueByFingerprint(marker);
    if (!found.ok) return this.failed(runId, 'issue', found.failure);

    if (found.value !== undefined) {
      await this.recordIssue(runId, found.value, true);
      return { ok: true, value: found.value.number, adopted: true };
    }

    const created = await this.options.provider.createIssue({
      title: draft.title,
      body: `${draft.body}\n\n${marker}\n`,
      labels: this.options.config.labels,
    });
    if (!created.ok) return this.failed(runId, 'issue', created.failure);

    await this.recordIssue(runId, created.value, false);
    return { ok: true, value: created.value.number };
  }

  /**
   * Opens this run's pull request, or updates the one already open for this head and base.
   *
   * **The head is checked against the approved commit before anything is written** (§33).
   * A pull request pointing at a tree this run did not approve is the thing M7 exists to
   * make impossible, and finding out afterwards is not the same as refusing.
   */
  async pullRequest(
    runId: string,
    approvedCommit: string,
    draft: { title: string; body: string; base: string },
  ): Promise<DeliveryStep<number>> {
    const gate = this.gate('pullRequests.create', this.options.config.pullRequests.create);
    if (gate !== undefined) return gate;

    const mismatch = this.repositoryMismatch();
    if (mismatch !== undefined) return mismatch;

    const head = runBranchFor(runId);
    const marker = this.markerFor(runId, 'pull_request', approvedCommit);

    await this.options.store.appendEvent(runId, 'forge_pr_create_requested', {
      fingerprint: marker,
      head,
      base: draft.base,
    });

    const found = await this.options.provider.findPullRequest({ head, base: draft.base });
    if (!found.ok) return this.failed(runId, 'pull_request', found.failure);

    if (found.value !== undefined) {
      if (found.value.headSha !== undefined && found.value.headSha !== approvedCommit) {
        const failure: ForgeFailure = {
          code: 'forge_remote_ref_conflict',
          detail:
            `pull request #${String(found.value.number)} points at ` +
            `${found.value.headSha.slice(0, 8)} and this run approved ` +
            `${approvedCommit.slice(0, 8)}; publish the approved commit before updating it`,
        };
        return this.failed(runId, 'pull_request', failure);
      }

      if (this.options.config.pullRequests.update) {
        const updated = await this.options.provider.updatePullRequest({
          number: found.value.number,
          title: draft.title,
          body: `${draft.body}\n\n${marker}\n`,
        });
        if (!updated.ok) return this.failed(runId, 'pull_request', updated.failure);

        await this.options.store.appendEvent(runId, 'forge_pr_updated', {
          number: updated.value.number,
          headSha: approvedCommit,
        });
        await this.recordPullRequest(runId, approvedCommit, updated.value, true);
        return { ok: true, value: updated.value.number, adopted: true };
      }

      await this.recordPullRequest(runId, approvedCommit, found.value, true);
      return { ok: true, value: found.value.number, adopted: true };
    }

    const created = await this.options.provider.createPullRequest({
      title: draft.title,
      body: `${draft.body}\n\n${marker}\n`,
      head,
      base: draft.base,
    });
    if (!created.ok) return this.failed(runId, 'pull_request', created.failure);

    await this.options.store.appendEvent(runId, 'forge_pr_created', {
      number: created.value.number,
      url: created.value.url,
      headSha: approvedCommit,
      adopted: false,
    });
    await this.recordPullRequest(runId, approvedCommit, created.value, false);
    return { ok: true, value: created.value.number };
  }

  /**
   * Reads the checks for the approved commit.
   *
   * By commit rather than by pull request, for the reason the port says: a PR's checks are
   * its head's, and a PR whose head moved has different ones. Observation only — nothing
   * here reaches a quality gate, a task state or a run status.
   */
  async sync(runId: string): Promise<DeliveryStep<number>> {
    const gate = this.gate('checks.read', this.options.config.checks.read);
    if (gate !== undefined) return gate;

    const record = await this.options.records.read(runId);
    // **No commit means no checks to read, and saying so beats reading somebody else's.**
    // A record can exist before publication — an Issue linked during planning writes one —
    // so "there is a record" is not "there is a published commit".
    if (record?.sourceCommit === undefined) {
      return {
        ok: false,
        failure: { code: 'forge_not_configured', detail: 'this run has published nothing to sync' },
      };
    }
    const commit = record.sourceCommit;

    const checks = await this.options.provider.listChecks(commit);
    if (!checks.ok) return this.failed(runId, 'sync', checks.failure);

    await this.options.store.appendEvent(runId, 'forge_checks_observed', {
      commit,
      total: checks.value.length,
    });

    await this.options.records.write(
      DeliveryRecordSchema.parse({
        ...record,
        checks: checks.value,
        syncedAt: this.options.clock.now(),
        failure: undefined,
      }),
    );

    return { ok: true, value: checks.value.length };
  }

  /**
   * Posts one summary comment per logical update, and never a second one for the same.
   *
   * `topic` is what makes two different updates two comments and one retried update one
   * comment. A retry that spams a pull request is a retry that teaches people to mute it.
   */
  async comment(
    runId: string,
    input: { readonly on: number; readonly body: string; readonly topic: string },
  ): Promise<DeliveryStep<number>> {
    const gate = this.gate('pullRequests.postSummary', this.options.config.pullRequests.postSummary);
    if (gate !== undefined) return gate;

    const record = await this.options.records.read(runId);
    const marker = this.markerFor(runId, 'comment', record?.sourceCommit, input.topic);

    const found = await this.options.provider.findComment({ issueOrPr: input.on, marker });
    if (!found.ok) return this.failed(runId, 'comment', found.failure);
    if (found.value !== undefined) {
      await this.options.store.appendEvent(runId, 'forge_comment_posted', {
        on: input.on,
        number: found.value,
        adopted: true,
      });
      return { ok: true, value: found.value, adopted: true };
    }

    const posted = await this.options.provider.postComment({
      issueOrPr: input.on,
      body: `${input.body}\n\n${marker}\n`,
    });
    if (!posted.ok) return this.failed(runId, 'comment', posted.failure);

    await this.options.store.appendEvent(runId, 'forge_comment_posted', {
      on: input.on,
      number: posted.value,
      adopted: false,
    });
    return { ok: true, value: posted.value };
  }

  /* ─── plumbing ───────────────────────────────────────────────────────────── */

  private markerFor(
    runId: string,
    kind: 'issue' | 'pull_request' | 'comment',
    commit?: string,
    topic?: string,
  ): string {
    return fingerprintMarker({
      runId,
      kind,
      digest: fingerprint({
        runId,
        kind,
        repository: this.options.repository,
        ...(commit === undefined ? {} : { commit }),
        ...(topic === undefined ? {} : { topic }),
      }),
    });
  }

  /**
   * Typed as the failure half rather than as `DeliveryStep<T>`.
   *
   * A refusal carries no value, so it is assignable to every `DeliveryStep<T>` at once —
   * the same reasoning `GitRefusal` uses, and the same ceremony it saves at every call
   * site.
   */
  private gate(name: string, enabled: boolean): { ok: false; failure: ForgeFailure } | undefined {
    if (this.options.config.provider === 'none') {
      return {
        ok: false,
        failure: { code: 'forge_not_configured', detail: 'no forge provider is configured' },
      };
    }
    if (!enabled) {
      return {
        ok: false,
        failure: {
          code: 'forge_not_configured',
          detail: `forge.${name} is off; nothing was sent`,
        },
      };
    }
    return undefined;
  }

  /**
   * Whether the repository this is configured for is the one the run lives in (§26).
   *
   * Checked before every mutation rather than once at construction: a run is long, a
   * configuration can be reloaded, and "we checked at startup" is how work ends up in
   * somebody else's repository.
   */
  private repositoryMismatch(): { ok: false; failure: ForgeFailure } | undefined {
    const configured = this.options.config.repository;
    if (configured === undefined) return undefined;
    if (sameRepository(configured, this.options.repository)) return undefined;

    return {
      ok: false,
      failure: {
        code: 'forge_repository_mismatch',
        detail:
          `this run's remote is ${this.options.repository.owner}/${this.options.repository.repo} ` +
          `and forge.repository names ${configured.owner}/${configured.repo}`,
      },
    };
  }

  private async failed(
    runId: string,
    operation: string,
    failure: ForgeFailure,
  ): Promise<{ ok: false; failure: ForgeFailure }> {
    await this.fail(runId, operation, failure);
    return { ok: false, failure };
  }

  private async fail(
    runId: string,
    operation: string,
    failure: ForgeFailure,
    commit?: string,
  ): Promise<void> {
    await this.options.store.appendEvent(runId, 'forge_operation_failed', {
      operation,
      code: failure.code,
      detail: failure.detail,
    });

    const existing = await this.options.records.read(runId);
    if (existing === undefined && commit === undefined) return;

    await this.options.records.write(
      DeliveryRecordSchema.parse({
        ...(existing ?? this.blank(runId, commit)),
        failure,
      }),
    );
  }

  private async recordIssue(
    runId: string,
    issue: DeliveryRecord['issue'],
    adopted: boolean,
  ): Promise<void> {
    await this.options.store.appendEvent(runId, 'forge_issue_created', {
      number: issue?.number,
      url: issue?.url,
      adopted,
    });
    await this.patch(runId, undefined, (record) => ({ ...record, issue, failure: undefined }));
  }

  private async recordPullRequest(
    runId: string,
    commit: string,
    pullRequest: DeliveryRecord['pullRequest'],
    adopted: boolean,
  ): Promise<void> {
    if (adopted) {
      await this.options.store.appendEvent(runId, 'forge_pr_created', {
        number: pullRequest?.number,
        url: pullRequest?.url,
        headSha: commit,
        adopted: true,
      });
    }
    await this.patch(runId, commit, (record) => ({ ...record, pullRequest, failure: undefined }));
  }

  private async patch(
    runId: string,
    commit: string | undefined,
    change: (record: DeliveryRecord) => DeliveryRecord,
  ): Promise<void> {
    const existing = await this.options.records.read(runId);
    const base = existing ?? this.blank(runId, commit);
    await this.options.records.write(DeliveryRecordSchema.parse(change(base)));
  }

  private blank(runId: string, commit: string | undefined): DeliveryRecord {
    return {
      runId,
      provider: this.options.config.provider,
      repository: this.options.repository,
      ...(commit === undefined ? {} : { sourceCommit: commit }),
      checks: [],
    };
  }
}
