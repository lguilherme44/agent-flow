import { z } from 'zod';
// `CommitOidSchema` is MVP 2's, not M7's. A second forty-hex rule would be a second
// definition of "a commit", and the two would drift the day one of them learned about
// abbreviated ids.
import { CommitOidSchema, RunIdSchema } from './common.schema.js';

/**
 * Remote delivery (M7).
 *
 * **A destination and a diagnostic source, never an authority.** Everything in this file
 * describes something that happens *after* the local workflow has decided — a commit that
 * is already approved, published to a branch that is already named, observed by checks
 * that cannot change what was decided. `ForgeCheck` deliberately shares no shape with
 * `QualityGateResult`, and the architecture suite proves one cannot become the other.
 *
 * Provider-neutral by construction: no GitHub type reaches this file, and an adapter that
 * leaked one would be importing into `contracts` from `adapters`, which the layering test
 * has forbidden since MVP 1.
 */

/* ─── Identity ─────────────────────────────────────────────────────────────── */

export const FORGE_PROVIDERS = ['none', 'github'] as const;
export const ForgeProviderIdSchema = z.enum(FORGE_PROVIDERS);
export type ForgeProviderId = z.infer<typeof ForgeProviderIdSchema>;

/**
 * A repository, normalised.
 *
 * Mechanically derived from the origin URL — `https://`, `git@` and `ssh://` all collapse
 * to the same three fields — because "is this the repository we were configured for" has
 * to be answerable by comparison rather than by matching strings a human typed two
 * different ways.
 */
export const ForgeRepositorySchema = z.object({
  host: z.string().min(1).max(253),
  owner: z
    .string()
    .min(1)
    .max(39)
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, 'a GitHub owner is alphanumeric with hyphens'),
  repo: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/, 'a GitHub repository name is alphanumeric with . _ -'),
});
export type ForgeRepository = z.infer<typeof ForgeRepositorySchema>;

/* ─── Remote objects ───────────────────────────────────────────────────────── */

export const ForgeIssueRefSchema = z.object({
  number: z.number().int().positive(),
  url: z.url().max(500),
  title: z.string().max(500).optional(),
  state: z.enum(['open', 'closed', 'unknown']).default('unknown'),
});
export type ForgeIssueRef = z.infer<typeof ForgeIssueRefSchema>;

export const ForgePullRequestRefSchema = z.object({
  number: z.number().int().positive(),
  url: z.url().max(500),
  state: z.enum(['open', 'closed', 'merged', 'unknown']).default('unknown'),
  /** The commit the remote says this PR's head is. Compared, never assumed. */
  headSha: CommitOidSchema.optional(),
  baseBranch: z.string().max(255).optional(),
});
export type ForgePullRequestRef = z.infer<typeof ForgePullRequestRefSchema>;

/**
 * One remote check, normalised.
 *
 * **Structurally unlike `QualityGateResult`, on purpose.** No `required`, no `gateId`, no
 * `category` — the three fields that make a quality gate a gate. A reader who wants to
 * treat a green check as a passing gate has to write the conversion by hand, and the
 * architecture suite refuses it.
 */
export const FORGE_CHECK_STATUSES = ['queued', 'in_progress', 'completed', 'unknown'] as const;
export const FORGE_CHECK_CONCLUSIONS = [
  'success',
  'failure',
  'cancelled',
  'timed_out',
  'skipped',
  'neutral',
  'unknown',
] as const;

export const ForgeCheckSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(300),
  status: z.enum(FORGE_CHECK_STATUSES),
  conclusion: z.enum(FORGE_CHECK_CONCLUSIONS).optional(),
  url: z.url().max(500).optional(),
});
export type ForgeCheck = z.infer<typeof ForgeCheckSchema>;

/* ─── Failures ─────────────────────────────────────────────────────────────── */

/**
 * Why a remote operation could not produce the outcome asked for.
 *
 * A domain vocabulary rather than HTTP status codes: `403` is three different problems
 * depending on what was attempted, and a caller that switches on the number ends up
 * treating "your token cannot write here" as "this repository does not exist".
 */
export const FORGE_ERROR_CODES = [
  'forge_not_configured',
  'forge_auth_required',
  'forge_permission_denied',
  'forge_repository_mismatch',
  'forge_rate_limited',
  'forge_unavailable',
  'forge_invalid_response',
  'forge_conflict',
  'forge_remote_ref_conflict',
  /** More than one remote object matches this run's fingerprint. Refuse; never pick. */
  'forge_ambiguous_recovery',
] as const;
export const ForgeErrorCodeSchema = z.enum(FORGE_ERROR_CODES);
export type ForgeErrorCode = z.infer<typeof ForgeErrorCodeSchema>;

export const ForgeFailureSchema = z.object({
  code: ForgeErrorCodeSchema,
  /** For a person. Never carries a token, a header or a raw response body. */
  detail: z.string().min(1).max(1_000),
  /** Present when the remote said when it would accept work again. */
  retryAfterMs: z.number().int().nonnegative().optional(),
});
export type ForgeFailure = z.infer<typeof ForgeFailureSchema>;

/* ─── The record ───────────────────────────────────────────────────────────── */

/**
 * What this run published, and where.
 *
 * **Only what cannot be derived.** Whether delivery is pending, open, green or diverged is
 * a projection over these facts and the event log — the same rule that keeps a finding's
 * status out of storage. A mutable `deliveryStatus` here would be the field that disagrees
 * with the events the first time a sync is interrupted.
 */
export const DeliveryRecordSchema = z.object({
  runId: RunIdSchema,
  provider: ForgeProviderIdSchema,
  repository: ForgeRepositorySchema,
  /**
   * The approved commit, once one has been published.
   *
   * **Optional, because an Issue exists before a commit does.** The first version made it
   * required and a run that linked an Issue during planning could not write its own
   * delivery record — a model that said publication had already happened. Compared against
   * what the remote reports, never trusted from it.
   */
  sourceCommit: CommitOidSchema.optional(),
  remoteBranch: z.string().max(255).optional(),
  issue: ForgeIssueRefSchema.optional(),
  pullRequest: ForgePullRequestRefSchema.optional(),
  checks: z.array(ForgeCheckSchema).max(100).default([]),
  /** When the remote facts above were last read. */
  syncedAt: z.iso.datetime().optional(),
  failure: ForgeFailureSchema.optional(),
});
export type DeliveryRecord = z.infer<typeof DeliveryRecordSchema>;

/* ─── Configuration ────────────────────────────────────────────────────────── */

/**
 * How to authenticate to GitHub's API.
 *
 * **The name of an environment variable, never a value.** A token in a config file is a
 * token in a diff, in a backup and in whatever the operator pastes into an issue. The
 * value is resolved once, at the composition boundary, and the architecture suite proves
 * it cannot reach an event, a projection, a rendered page or a persisted request.
 */
export const GitHubForgeConfigSchema = z.object({
  tokenEnv: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'an environment variable name is upper snake case')
    .default('GITHUB_TOKEN'),
  /**
   * The API host, for a future GitHub Enterprise Server.
   *
   * Fixed for now, and *not* overridable by a repository: a project file that could point
   * the API somewhere else is a project file that can exfiltrate the operator's token.
   */
  apiBaseUrl: z.literal('https://api.github.com').default('https://api.github.com'),
});
export type GitHubForgeConfig = z.infer<typeof GitHubForgeConfigSchema>;

/**
 * Remote delivery, off unless the operator says otherwise (§21).
 *
 * Every write is its own flag, because "GitHub is configured" and "Agent Flow may open a
 * pull request in it" are different permissions. Detecting a GitHub remote can suggest a
 * provider; nothing detects consent.
 */
export const ForgeConfigSchema = z.object({
  provider: ForgeProviderIdSchema.default('none'),
  github: GitHubForgeConfigSchema.prefault({}),
  publish: z
    .object({
      enabled: z.boolean().default(false),
      /** Publishing the moment a run completes locally. Off, and deliberately dull. */
      autoAfterCompletion: z.boolean().default(false),
    })
    .prefault({}),
  issues: z
    .object({
      create: z.boolean().default(false),
      comment: z.boolean().default(false),
    })
    .prefault({}),
  pullRequests: z
    .object({
      create: z.boolean().default(false),
      update: z.boolean().default(false),
      postSummary: z.boolean().default(false),
    })
    .prefault({}),
  checks: z.object({ read: z.boolean().default(false) }).prefault({}),
  /**
   * The repository this run may talk to, when the operator wants it stated rather than
   * derived. A mismatch with the local origin refuses every mutation (§26).
   */
  repository: ForgeRepositorySchema.optional(),
  /** The PR's base. From repository metadata when absent; never from a model. */
  baseBranch: z.string().min(1).max(255).optional(),
  /** Labels a created Issue may carry. An allowlist, because a model must not invent one. */
  labels: z.array(z.string().min(1).max(50)).max(20).default([]),
  budgets: z
    .object({
      requestTimeoutMs: z.number().int().min(1_000).max(120_000).default(20_000),
      maxResponseBytes: z.number().int().min(1_024).max(10_485_760).default(1_048_576),
      maxMutationAttempts: z.number().int().min(1).max(5).default(3),
      maxSyncAttempts: z.number().int().min(1).max(20).default(5),
      maxCommentsPerRun: z.number().int().min(0).max(50).default(5),
      /**
       * How many remote objects a recovery scan may read before refusing as ambiguous.
       *
       * **Three pages, not one.** GitHub's page size is 100, so a bound of 100 means the
       * scan can never reach page two — and any repository with a hundred issues would
       * answer `forge_ambiguous_recovery` forever. Caught by a test whose arithmetic
       * disagreed with the default's.
       */
      maxRecoveryScan: z.number().int().min(100).max(1_000).default(300),
    })
    .prefault({}),
});
export type ForgeConfig = z.infer<typeof ForgeConfigSchema>;
