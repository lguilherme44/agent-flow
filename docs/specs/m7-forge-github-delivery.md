# M7 — Forge & Remote Delivery

**Status:** specified. Normative for M7; where this document and the code disagree, the
code is the current truth.

M6 ended with a run that can prove which commit is approved. M7 publishes exactly that
commit, creates exactly one remote artifact for it, and observes the remote **without
handing it any authority**.

```text
models propose
Agent Flow decides locally
Forge publishes and observes
```

---

## 1. Repository assessment — what already exists

Nothing here is a green field, and three of the pieces M7 needs are already load-bearing
elsewhere.

| Existing | What it gives M7 | What it must not become |
|---|---|---|
| `GitCommand` | a closed subcommand allowlist, separated arguments, no shell, `GIT_TERMINAL_PROMPT=0`, timeouts and output bounds | a way to reach a network API |
| `GitClient` | local Git facts — diffs, changed files, tracked files | a PR creator |
| `Integrator` | `integrationHead`, `openForReview`, the one place an integration checkout is opened | a publisher |
| `decideQuality` + `checkDefinitionOfDone` | the single answer to "may this proceed" | reimplemented per destination |
| `projectReviews` | the review and quality summary a PR body needs | recomputed for the remote |
| `Host` | the composition boundary that already resolves environment facts rather than reading `process.env` deep in the code | a place to store a token |
| `OpenAiUtilityModel` | the precedent for an **injected `fetch`** with timeouts and bounded responses | copied by hand into a new adapter |

**Two things do not exist and are genuinely new:** an HTTP port shaped for a REST API with
pagination and rate limits, and any Git verb that touches a remote. `GIT_SUBCOMMANDS` has
sixteen entries and none of them is `push` or `ls-remote`.

**The `affects` gap is closed first** (§2 of the charter), before any Forge code, because
it is M6's debt rather than M7's design.

---

## 2. Boundaries — the rule the milestone rests on

Three seams, and the whole point is that they are three.

```text
GitClient            local Git facts, read-only, no network
RemoteGitPublisher   publishes one exact commit to one exact remote ref, via GitCommand
ForgeProvider        Issues, PRs, checks — a REST API, no Git
```

Creating a pull request requires the commit to exist remotely. That is a *Git* operation
and it does not become a Forge operation because a Forge operation depends on it. A
provider that could run Git would be a provider that could rewrite history to make its own
API call succeed.

Enforced by architecture test, not by convention: M7-A01 … M7-A03.

---

## 3. What GitHub decides

Nothing.

```text
task completion · run completion · approval · validation · review correctness
quality gates · integration · assignment · ownership · recovery
```

A remote check is **delivery observability**. `ForgeCheck` cannot become a
`QualityGateResult`, a red check cannot change `run.status`, and a forge failure cannot
un-complete a completed run. These are invariants with tests (M7-A07, M7-A08), not
guidance.

---

## 4. Publication

**Exact, or refused.** The source is `state.integrationHead` — the commit the local
authority approved — resolved to a `CommitOid` and published to a run-owned branch. Never
"whatever HEAD is", never a branch name resolved at push time.

```text
run complete · quality satisfied · review fresh · Definition of Done satisfied
        ↓
integrationHead → CommitOid
        ↓
push <oid>:refs/heads/agent-flow/<runId>
        ↓
assert published SHA == approved SHA
```

Refused, always:

- **the default branch**, and `main`/`master` by name regardless of what the remote says
  its default is;
- **any non-fast-forward update**. No `--force`, no `--force-with-lease` — a diverged
  remote branch is a person's decision, not a flag;
- **a branch that exists without local evidence this run created it.** Run-owned means
  provably run-owned.

The ref is derived from the run id and sanitised mechanically. No agent chooses a ref, and
no model output reaches `GitCommand`.

---

## 5. Configuration

Opt-in at every level, and off by default.

```yaml
forge:
  provider: none          # github, when the operator says so
  github:
    tokenEnv: GITHUB_TOKEN   # the NAME. never the value.
  publish:
    enabled: false
    autoAfterCompletion: false
  issues: { create: false, comment: false }
  pullRequests: { create: false, update: false, postSummary: false }
  checks: { read: false }
```

Detecting a GitHub remote may *suggest* a provider. It never enables one.

**Global only.** A repository overlay cannot enable a write, choose the token env, change
the API host, or turn on publication. Credentials and the authority to spend them belong
to the operator, not to a checked-in file.

---

## 6. Authentication

Two credentials, deliberately not shared:

| | Used by | Source |
|---|---|---|
| Git auth | `RemoteGitPublisher` | the operator's existing credential helper or SSH agent |
| API token | `ForgeProvider` | the environment variable named in config, read once at composition |

The REST token is never written into a Git URL and never persisted into a remote. The
value exists in one place — the composition boundary — and the architecture test proves it
cannot reach events, errors, HTTP diagnostics, the CLI or the dashboard.

---

## 7. Repository identity

Normalised mechanically from the origin URL, never by a model:

```text
https://github.com/owner/repo.git   ┐
git@github.com:owner/repo.git       ├──►  { host: 'github.com', owner, repo }
ssh://git@github.com/owner/repo.git ┘
```

If the local origin and the configured repository disagree, **every mutation refuses**.
"Probably intentional" is how a run publishes into somebody else's repository.

GitHub.com only. GHES is backlog.

---

## 8. Idempotency — the centre of the milestone

Every remote mutation must answer one question:

> What if the remote succeeded and this process died before persisting that?

The answer is a **fingerprint**: deterministic, non-secret, derived from run id, object
kind and the commit, embedded in the object Agent Flow creates.

```html
<!-- agent-flow:run=AF-2026-123;kind=issue;fingerprint=<digest> -->
```

Recovery, in order: read local evidence; if absent, search the remote for the fingerprint;
exactly one match → adopt it; zero → create; **more than one → refuse.** Never "create one
more".

`requested`, `attempted`, `succeeded`, `failed` and `ambiguous` are five different facts
and the log distinguishes them. A crash between remote success and local persistence is a
first-class case, not an edge one.

---

## 9. Delivery domain

The smallest thing that cannot be derived:

```ts
interface DeliveryRecord {
  runId: RunId
  provider: ForgeProviderId
  repository: ForgeRepositoryRef
  sourceCommit: CommitOid
  remoteBranch?: string
  issue?: ForgeIssueRef
  pullRequest?: ForgePullRequestRef
}
```

Everything else — `not_published`, `pr_open`, `checks_pending`, `checks_red`,
`delivery_failed`, `remote_diverged` — is **projected** from these facts and the event log.
No mutable status enum, for the same reason a finding has no stored status.

Append-only, in the run's own log or a `forge.jsonl` beside it.

---

## 10. Local status and delivery status are separate

```text
RUN        completed
DELIVERY   PR #42 open, checks pending
```

A run does not become pending because GitHub is slow, and the scheduler never blocks on a
remote poll. `forge sync` is a bounded, explicit refresh.

---

## 11. Everything from the remote is untrusted

Issue text, PR text, comments, check names, workflow output, user names, branch names. None
of it is automatically fed to an agent, none of it selects a path, a ref or a command, and
M7 does not need to give agents remote comments at all.

Outbound, the model does not write the remote either: an Issue or PR body is composed from
a **template** over M6's existing projections, schema-validated, redacted and bounded.
Labels come from a human allowlist.

---

## 12. Security

The threat model is written into `docs/security.md` alongside M4's and M6's, covering
token leakage, repository mismatch, SSRF, Authorization leaking across a redirect,
malicious remote URLs and refs, model-controlled PR/Issue fields, duplicate objects after a
crash, remote branch overwrite, pushing to a default branch, publishing a stale SHA,
malformed responses, rate-limit loops, unbounded bodies, remote prompt injection, a check
becoming local authority, and a forge failure mutating run completion.

---

## 13. Failure taxonomy

HTTP status codes are not a domain. Normalised:

```text
forge_not_configured · forge_auth_required · forge_permission_denied
forge_repository_mismatch · forge_rate_limited · forge_unavailable
forge_invalid_response · forge_conflict · forge_remote_ref_conflict
forge_ambiguous_recovery
```

Bounded everywhere: request timeout, max response bytes, max mutation attempts, max sync
attempts, max comments per run. Rate limiting is a delivery failure with a `resetAt`, never
a retry loop and never a task failure.

---

## 14. Surfaces

**CLI** — `agent-flow forge status | publish | issue | pr | sync`, each sub-operation
separately testable and `publish` coordinating whatever is configured.

**API** — one delivery projection, behind the existing control-plane hardening: allowed
Host, safe Origin, loopback policy, current run, config permission. The `evil.example →
POST → mutation` hole stays closed.

**Dashboard** — one card: repository, published branch and SHA, Issue, PR, checks, last
sync, delivery errors. The browser renders the projection and derives nothing, and never
speaks to GitHub.

---

## 15. Test strategy

| Layer | What it must prove |
|---|---|
| contract | config defaults to `none`; legacy config produces zero network activity; repository URL normalisation; token name persists and value never does |
| unit | fingerprint determinism; ref sanitisation; delivery projection over facts |
| adapter | 2xx/401/403/404/409/422/429/5xx, malformed JSON, oversized body, missing fields, unexpected enums, pagination bounds — no real network |
| crash | after push · after Issue · after PR · after comment · during sync, each resuming without a duplicate |
| security | one per row of §12 |
| architecture | M7-A01 … M7-A15 |
| live | a real Issue, a real branch, a real PR, real checks, and a rerun that creates nothing twice |

---

## 16. Acceptance

M7-ACC-01 … M7-ACC-30, verbatim from the charter, each greppable in `test/`.

---

## 17. Architectural critique of this specification

Written before the code, as the charter requires. Four things about the design above are
worth arguing with.

**The three-seam rule is stated as principle and enforced as import hygiene, which is
weaker than it sounds.** An architecture test proving `ForgeProvider` imports no Git module
does not prove it cannot *cause* Git to run — it could call an app-level use case that
does. The rule that actually holds is narrower: no Forge module may reach `GitCommand`,
transitively. That is checkable, and this document should have said "transitively" rather
than "separate" from the start.

**Fingerprint recovery assumes the remote is searchable, and GitHub's search is eventually
consistent.** An Issue created seconds before a crash may not appear in the search that
recovery runs. The design then reads "zero matches → create" and produces the duplicate the
fingerprint exists to prevent. The mitigation is to prefer *listing* the repository's recent
Issues over *searching* them, bounded, and to refuse rather than create when the bound is
hit — which makes recovery correct and occasionally unhelpful. That trade is the right one
and it should be explicit rather than discovered.

**"The default branch is refused" is two rules pretending to be one.** Refusing `main` and
`master` by name is a static check; refusing *the repository's declared default* requires an
API call, which requires a configured provider — so a `publish` with `provider: none` can
only enforce the static half. A repository whose default branch is `develop` gets less
protection than one whose default is `main`, from a rule that reads as absolute. The honest
version: the name check is unconditional, the metadata check is best-effort, and publication
without a provider is restricted to run-owned refs whose shape cannot collide with anything
a human would name.

**The delivery projection will want to be a status field within one milestone.** Every
projection in this product has held, but this one folds over a log that includes *remote*
facts fetched at different times — a check read at 10:00 and a PR state read at 10:05 are
both "current". A projection cannot fix that; only recording the observation time per fact
can, and then the projection has to decide what "stale" means for each. This document
specifies `lastSync` and leaves per-fact staleness unaddressed, which is a gap I expect the
first real PR to expose.
