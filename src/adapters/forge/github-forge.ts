import {
  ForgeCheckSchema,
  ForgeIssueRefSchema,
  ForgePullRequestRefSchema,
  type ForgeCheck,
  type ForgeFailure,
  type ForgeIssueRef,
  type ForgePullRequestRef,
  type ForgeRepository,
} from '../../contracts/index.js';
import type {
  ForgeIssueDraft,
  ForgeProvider,
  ForgePullRequestDraft,
  ForgeRepositoryInfo,
  ForgeResult,
} from '../../ports/index.js';

/**
 * GitHub, behind the provider port (M7 §28).
 *
 * **Every GitHub-shaped thing stops here.** The port speaks in `ForgeIssueRef` and
 * `ForgeCheck`; this file is the only place that knows about `html_url`, `check_runs` or
 * the difference between a check run and a commit status.
 *
 * **It runs no Git**, holds no repository on disk, and spawns nothing. The token exists as
 * a closure variable and reaches exactly one place: the `Authorization` header of a
 * request to a host this class pins.
 *
 * Bounded on every axis the charter names — timeout, response size, redirects, pagination
 * — because the failure mode of an unbounded HTTP client is a run that never ends and a
 * heap that never stops growing.
 */

export interface GitHubForgeOptions {
  readonly repository: ForgeRepository;
  /** Resolved once at the composition boundary. Never read from `process.env` here. */
  readonly token: string;
  readonly apiBaseUrl: string;
  readonly fetch: typeof fetch;
  readonly requestTimeoutMs: number;
  readonly maxResponseBytes: number;
  /** How many objects a recovery scan may read before answering "ambiguous". */
  readonly maxRecoveryScan: number;
}

export class GitHubForgeProvider implements ForgeProvider {
  readonly id = 'github' as const;

  constructor(private readonly options: GitHubForgeOptions) {}

  async repository(): Promise<ForgeResult<ForgeRepositoryInfo>> {
    const response = await this.request<{ default_branch?: unknown }>('GET', this.repoPath());
    if (!response.ok) return response;

    const branch = response.value.default_branch;
    if (typeof branch !== 'string' || branch.length === 0) {
      return invalid('the repository response carried no default branch');
    }

    return { ok: true, value: { repository: this.options.repository, defaultBranch: branch } };
  }

  async findIssueByFingerprint(marker: string): Promise<ForgeResult<ForgeIssueRef | undefined>> {
    // **Listed rather than searched, and the spec's critique is why.** GitHub's search
    // index is eventually consistent, so an Issue created seconds before a crash may not
    // appear in a search — and "not found" then means "create another one", which is the
    // duplicate the fingerprint exists to prevent. Listing is immediately consistent.
    const scanned = await this.scan<{ number?: unknown; body?: unknown; html_url?: unknown; state?: unknown }>(
      `${this.repoPath()}/issues?state=all&per_page=100`,
    );
    if (!scanned.ok) return scanned;

    const matches = scanned.value.filter(
      (issue) => typeof issue.body === 'string' && issue.body.includes(marker),
    );

    if (matches.length === 0) return { ok: true, value: undefined };
    if (matches.length > 1) {
      return {
        ok: false,
        failure: {
          code: 'forge_ambiguous_recovery',
          detail:
            `${String(matches.length)} issues carry this run's fingerprint. Two objects with ` +
            'one run’s mark is a state nothing should resolve by picking; close the ' +
            'duplicates and try again',
        },
      };
    }

    return this.asIssue(matches[0]);
  }

  async getIssue(number: number): Promise<ForgeResult<ForgeIssueRef>> {
    const response = await this.request<unknown>('GET', `${this.repoPath()}/issues/${String(number)}`);
    return response.ok ? this.asIssue(response.value) : response;
  }

  async createIssue(draft: ForgeIssueDraft): Promise<ForgeResult<ForgeIssueRef>> {
    const response = await this.request<unknown>('POST', `${this.repoPath()}/issues`, {
      title: draft.title,
      body: draft.body,
      ...(draft.labels.length === 0 ? {} : { labels: [...draft.labels] }),
    });
    return response.ok ? this.asIssue(response.value) : response;
  }

  async findPullRequest(input: {
    readonly head: string;
    readonly base: string;
  }): Promise<ForgeResult<ForgePullRequestRef | undefined>> {
    // `head` is qualified with the owner because GitHub reads a bare branch name as
    // "any fork's branch of that name", which would match somebody else's.
    const head = `${this.options.repository.owner}:${input.head}`;
    const scanned = await this.scan<unknown>(
      `${this.repoPath()}/pulls?state=all&per_page=100&head=${encodeURIComponent(head)}&base=${encodeURIComponent(input.base)}`,
    );
    if (!scanned.ok) return scanned;

    if (scanned.value.length === 0) return { ok: true, value: undefined };
    if (scanned.value.length > 1) {
      return {
        ok: false,
        failure: {
          code: 'forge_ambiguous_recovery',
          detail: `${String(scanned.value.length)} pull requests share this head and base`,
        },
      };
    }

    return this.asPullRequest(scanned.value[0]);
  }

  async createPullRequest(draft: ForgePullRequestDraft): Promise<ForgeResult<ForgePullRequestRef>> {
    const response = await this.request<unknown>('POST', `${this.repoPath()}/pulls`, {
      title: draft.title,
      body: draft.body,
      head: draft.head,
      base: draft.base,
    });
    return response.ok ? this.asPullRequest(response.value) : response;
  }

  async updatePullRequest(input: {
    readonly number: number;
    readonly title?: string;
    readonly body?: string;
  }): Promise<ForgeResult<ForgePullRequestRef>> {
    const response = await this.request<unknown>(
      'PATCH',
      `${this.repoPath()}/pulls/${String(input.number)}`,
      {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
      },
    );
    return response.ok ? this.asPullRequest(response.value) : response;
  }

  async listChecks(commit: string): Promise<ForgeResult<readonly ForgeCheck[]>> {
    const response = await this.request<{ check_runs?: unknown }>(
      'GET',
      `${this.repoPath()}/commits/${commit}/check-runs?per_page=100`,
    );
    if (!response.ok) return response;

    const runs = Array.isArray(response.value.check_runs) ? response.value.check_runs : [];
    const checks: ForgeCheck[] = [];

    for (const run of runs) {
      const row = run as Record<string, unknown>;
      const parsed = ForgeCheckSchema.safeParse({
        id: String(row['id'] ?? ''),
        name: typeof row['name'] === 'string' ? row['name'] : 'unnamed check',
        // **Unknown rather than guessed.** A status GitHub adds next year must not be read
        // as `completed`, and a conclusion this does not recognise must not be `success`.
        status: statusOf(row['status']),
        ...(row['conclusion'] === null || row['conclusion'] === undefined
          ? {}
          : { conclusion: conclusionOf(row['conclusion']) }),
        ...(typeof row['html_url'] === 'string' ? { url: row['html_url'] } : {}),
      });
      if (parsed.success) checks.push(parsed.data);
    }

    return { ok: true, value: checks };
  }

  async findComment(input: {
    readonly issueOrPr: number;
    readonly marker: string;
  }): Promise<ForgeResult<number | undefined>> {
    const scanned = await this.scan<{ id?: unknown; body?: unknown }>(
      `${this.repoPath()}/issues/${String(input.issueOrPr)}/comments?per_page=100`,
    );
    if (!scanned.ok) return scanned;

    const match = scanned.value.find(
      (comment) => typeof comment.body === 'string' && comment.body.includes(input.marker),
    );
    const id = match?.id;
    return { ok: true, value: typeof id === 'number' ? id : undefined };
  }

  async postComment(input: {
    readonly issueOrPr: number;
    readonly body: string;
  }): Promise<ForgeResult<number>> {
    const response = await this.request<{ id?: unknown }>(
      'POST',
      `${this.repoPath()}/issues/${String(input.issueOrPr)}/comments`,
      { body: input.body },
    );
    if (!response.ok) return response;

    const id = response.value.id;
    return typeof id === 'number'
      ? { ok: true, value: id }
      : invalid('the comment response carried no id');
  }

  /* ─── plumbing ───────────────────────────────────────────────────────────── */

  private repoPath(): string {
    const { owner, repo } = this.options.repository;
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  /**
   * One request, bounded on every axis.
   *
   * `redirect: 'error'` rather than `'follow'`: following a redirect re-sends the
   * `Authorization` header, and a redirect to another host is how a token leaves the
   * machine (§29). GitHub's API does not need one.
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
  ): Promise<ForgeResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.options.requestTimeoutMs);

    try {
      const response = await this.options.fetch(`${this.options.apiBaseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          authorization: `Bearer ${this.options.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: controller.signal,
      });

      const failure = failureFor(response);
      if (failure !== undefined) return { ok: false, failure };

      const text = await this.readBounded(response);
      if (!text.ok) return text;
      if (text.value.trim().length === 0) return { ok: true, value: undefined as T };

      try {
        return { ok: true, value: JSON.parse(text.value) as T };
      } catch {
        return invalid('the response was not JSON');
      }
    } catch (error) {
      // **Nothing from the error reaches the detail.** A fetch error can carry the request
      // URL, and the URL is the one string in this class that has been near the token.
      const timedOut = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        failure: {
          code: timedOut ? 'forge_rate_limited' : 'forge_unavailable',
          detail: timedOut
            ? `the request exceeded ${String(this.options.requestTimeoutMs)}ms`
            : 'the request could not be completed',
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The body, or a refusal once it is larger than a body has any business being. */
  private async readBounded(response: Response): Promise<ForgeResult<string>> {
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > this.options.maxResponseBytes) {
      return invalid(`the response declared ${String(declared)} bytes`);
    }

    const text = await response.text();
    if (text.length > this.options.maxResponseBytes) {
      return invalid(`the response exceeded ${String(this.options.maxResponseBytes)} bytes`);
    }

    return { ok: true, value: text };
  }

  /**
   * A bounded walk of a collection.
   *
   * Stops at `maxRecoveryScan` and says so by answering `forge_ambiguous_recovery` rather
   * than returning a partial list: a recovery that concluded "no match" from half the
   * pages would create the duplicate it was looking for.
   */
  private async scan<T>(path: string): Promise<ForgeResult<T[]>> {
    const collected: T[] = [];
    let page = 1;

    while (collected.length < this.options.maxRecoveryScan) {
      const response = await this.request<unknown>('GET', `${path}&page=${String(page)}`);
      if (!response.ok) return response;

      const rows = Array.isArray(response.value) ? (response.value as T[]) : [];
      collected.push(...rows);
      if (rows.length < 100) return { ok: true, value: collected };
      page += 1;
    }

    return {
      ok: false,
      failure: {
        code: 'forge_ambiguous_recovery',
        detail:
          `more than ${String(this.options.maxRecoveryScan)} objects were scanned without ` +
          'reaching the end, so "no match" cannot be concluded safely',
      },
    };
  }

  private asIssue(raw: unknown): ForgeResult<ForgeIssueRef> {
    const row = (raw ?? {}) as Record<string, unknown>;
    const parsed = ForgeIssueRefSchema.safeParse({
      number: row['number'],
      url: row['html_url'],
      ...(typeof row['title'] === 'string' ? { title: row['title'] } : {}),
      state: row['state'] === 'open' || row['state'] === 'closed' ? row['state'] : 'unknown',
    });
    return parsed.success ? { ok: true, value: parsed.data } : invalid('an issue was malformed');
  }

  private asPullRequest(raw: unknown): ForgeResult<ForgePullRequestRef> {
    const row = (raw ?? {}) as Record<string, unknown>;
    const head = (row['head'] ?? {}) as Record<string, unknown>;
    const base = (row['base'] ?? {}) as Record<string, unknown>;

    const parsed = ForgePullRequestRefSchema.safeParse({
      number: row['number'],
      url: row['html_url'],
      state: row['merged_at'] != null ? 'merged' : row['state'] === 'open' ? 'open' : row['state'] === 'closed' ? 'closed' : 'unknown',
      ...(typeof head['sha'] === 'string' ? { headSha: head['sha'] } : {}),
      ...(typeof base['ref'] === 'string' ? { baseBranch: base['ref'] } : {}),
    });
    return parsed.success
      ? { ok: true, value: parsed.data }
      : invalid('a pull request was malformed');
  }
}

/* ─── shared ─────────────────────────────────────────────────────────────── */

function invalid<T>(detail: string): ForgeResult<T> {
  return { ok: false, failure: { code: 'forge_invalid_response', detail } };
}

/**
 * The domain failure a status code means here.
 *
 * A status is not a domain: `403` is "your token cannot do this" and *also* how GitHub
 * reports a secondary rate limit, and a caller switching on the number treats one as the
 * other. The `x-ratelimit-remaining` header is what separates them.
 */
function failureFor(response: Response): ForgeFailure | undefined {
  if (response.ok) return undefined;

  const remaining = response.headers.get('x-ratelimit-remaining');
  const resetAt = Number(response.headers.get('x-ratelimit-reset') ?? '0');
  const retryAfter = Number(response.headers.get('retry-after') ?? '0');
  const rateLimited =
    response.status === 429 || (response.status === 403 && remaining === '0');

  if (rateLimited) {
    const waitMs =
      retryAfter > 0 ? retryAfter * 1_000 : resetAt > 0 ? Math.max(0, resetAt * 1_000 - Date.now()) : 0;
    return {
      code: 'forge_rate_limited',
      detail: 'the remote is rate limiting this token',
      ...(waitMs > 0 ? { retryAfterMs: waitMs } : {}),
    };
  }

  switch (response.status) {
    case 401:
      return { code: 'forge_auth_required', detail: 'the token was rejected' };
    case 403:
      return { code: 'forge_permission_denied', detail: 'the token may not do this here' };
    case 404:
      return {
        code: 'forge_permission_denied',
        // GitHub answers 404 for a private repository a token cannot see, so "not found"
        // and "not permitted" are the same response and must not read as "does not exist".
        detail: 'the repository or object is not visible to this token',
      };
    case 409:
      return { code: 'forge_conflict', detail: 'the remote refused because of a conflict' };
    case 422:
      return { code: 'forge_conflict', detail: 'the remote rejected the request as invalid' };
    default:
      return {
        code: 'forge_unavailable',
        detail: `the remote answered ${String(response.status)}`,
      };
  }
}

function statusOf(value: unknown): ForgeCheck['status'] {
  return value === 'queued' || value === 'in_progress' || value === 'completed'
    ? value
    : 'unknown';
}

function conclusionOf(value: unknown): NonNullable<ForgeCheck['conclusion']> {
  const known = ['success', 'failure', 'cancelled', 'timed_out', 'skipped', 'neutral'] as const;
  return (known as readonly string[]).includes(String(value))
    ? (value as NonNullable<ForgeCheck['conclusion']>)
    : 'unknown';
}
