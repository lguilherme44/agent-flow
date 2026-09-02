import type {
  ForgeCheck,
  ForgeFailure,
  ForgeIssueRef,
  ForgePullRequestRef,
  ForgeRepository,
} from '../contracts/index.js';

/**
 * A code forge, as this product needs one (M7 §27).
 *
 * **Provider-neutral, and narrow on purpose.** Every operation here is one M7 actually
 * performs; a method nobody calls is a method whose GitHub semantics leak into the domain
 * unchallenged. No GitHub type crosses this boundary — an adapter normalises, and the
 * layering test has forbidden `contracts` from importing `adapters` since MVP 1.
 *
 * **It runs no Git.** Publishing the commit a pull request points at is
 * `RemoteGitPublisher`'s job, and the separation is not stylistic: a provider that could
 * run Git could rewrite history to make its own API call succeed.
 *
 * Every method answers with a value rather than throwing. A remote is a place where
 * failure is ordinary, and an exception here would make "GitHub is rate limiting us" and
 * "this code has a bug" the same control flow.
 */
export type ForgeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ForgeFailure };

/** What the remote says about itself. The default branch comes from here, never from a model. */
export interface ForgeRepositoryInfo {
  readonly repository: ForgeRepository;
  readonly defaultBranch: string;
}

export interface ForgeIssueDraft {
  readonly title: string;
  /** Already composed, redacted and bounded by the caller. Never raw model output. */
  readonly body: string;
  /** From the operator's allowlist. A model does not invent a label. */
  readonly labels: readonly string[];
}

export interface ForgePullRequestDraft {
  readonly title: string;
  readonly body: string;
  /** The run-owned branch the commit was published to. */
  readonly head: string;
  readonly base: string;
}

export interface ForgeProvider {
  readonly id: 'github';

  repository(): Promise<ForgeResult<ForgeRepositoryInfo>>;

  /**
   * The Issue carrying this fingerprint, if exactly one does.
   *
   * `undefined` means none was found *within the scan bound* — which is not the same as
   * "none exists", and the caller treats it accordingly. `forge_ambiguous_recovery` when
   * more than one matches: two objects with one run's mark is a state nothing should
   * resolve by picking.
   */
  findIssueByFingerprint(marker: string): Promise<ForgeResult<ForgeIssueRef | undefined>>;
  getIssue(number: number): Promise<ForgeResult<ForgeIssueRef>>;
  createIssue(draft: ForgeIssueDraft): Promise<ForgeResult<ForgeIssueRef>>;

  /** The open pull request for exactly this head and base, if there is one. */
  findPullRequest(input: {
    readonly head: string;
    readonly base: string;
  }): Promise<ForgeResult<ForgePullRequestRef | undefined>>;
  createPullRequest(draft: ForgePullRequestDraft): Promise<ForgeResult<ForgePullRequestRef>>;
  updatePullRequest(input: {
    readonly number: number;
    readonly title?: string;
    readonly body?: string;
  }): Promise<ForgeResult<ForgePullRequestRef>>;

  /**
   * The checks for one commit.
   *
   * Keyed by commit rather than by pull request, because a PR's checks are the checks of
   * its head and a PR whose head moved has different ones. Asking by number would return
   * whatever the remote currently thinks the head is, which is the question that produces
   * a green badge for a tree nobody reviewed.
   */
  listChecks(commit: string): Promise<ForgeResult<readonly ForgeCheck[]>>;

  /** The comment carrying this fingerprint, if one does. Used to not post it twice. */
  findComment(input: {
    readonly issueOrPr: number;
    readonly marker: string;
  }): Promise<ForgeResult<number | undefined>>;
  postComment(input: {
    readonly issueOrPr: number;
    readonly body: string;
  }): Promise<ForgeResult<number>>;
}
