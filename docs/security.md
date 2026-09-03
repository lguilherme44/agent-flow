# What the local server protects, and what it does not

`agent-flow ui` binds `127.0.0.1:4782`. It has **no authentication**, and it is not
meant to: the threat it is designed against is not a remote attacker but the ordinary
ways a local control plane over a filesystem goes wrong — a request that names a
directory, a plan that reaches a shell, a gate approved for a document nobody read.

Everything below is enforced by construction and checked by a test. Where the guarantee
has a limit, the limit is stated rather than implied.

---

## The filesystem boundary is the registry

**The operator chooses one directory, once, when the server starts.** That directory is
scanned to a bounded depth for repositories that have been through `agent-flow init`,
and each one is issued an id.

**After that, an id is the browser's entire vocabulary for a project.** Every endpoint
takes `?projectId=<id>`, and the id is looked up in a table this process built. There is
no request shape that can address a directory outside it — not a malformed one, not a
crafted one, because there is no field to put a path in.

The alternative would be to accept a path and validate it, which means getting
normalisation, symlinks, `..`, drive letters and UNC shares right in every handler,
forever, on every platform. Two architecture tests keep the choice honest: the request
contracts are read for anything path-shaped, and project discovery is confined to one
module.

### Symlinks

`stat` follows a link and reports an ordinary directory, so containment has to be judged
on **resolved** paths — which is why `realPath` is on the filesystem port at all.

- A link inside the workspace pointing at a repository **outside** it is skipped and
  named, on startup and on the Projects page. Silently dropping it would have somebody
  conclude the scan is broken; following it would publish a directory the operator never
  chose.
- A link that stays **inside** the workspace is followed, and the project is registered
  under its resolved path — so one directory reached twice is one project rather than
  two run histories under two ids.
- A link pointing back up its own tree terminates, because the walk keys on resolved
  paths rather than on path strings.

Containment is `path.relative` and not a string prefix. `/wk` must not contain
`/wknight`, `C:\wk` must contain `C:\wk\api`, and two drives or two UNC shares have no
route between them at all — a prefix comparison gets the first wrong on POSIX and all
three wrong on Windows. The Windows rules are asserted on Linux with `path.win32`,
because a rule about Windows that only runs on Windows is a rule nobody checks.

### The scan is bounded

`ui.workspaceDepth` defaults to 2 and is capped at 6, and dependency and build
directories are never descended into. An unbounded scan of a home directory reads places
nobody asked it to and takes minutes to start.

---

## The browser supplies no path, no command, and no hash

Three things it never sends, each closing a different hole.

**No filesystem path.** Above.

**No shell command.** A plan is model output, and the repository's own contents feed the
prompt that produced it — so a plan is untrusted input. A task names a validation *id*;
the id is resolved against commands a human wrote in the project configuration. A plan
cannot carry a command, so nothing a model writes can reach a shell. One module spawns
`/bin/sh`, and an architecture test says which.

**No trusted plan hash.** `approve` takes no hash. The use case reads the plan on disk
and hashes it, so there is no call that opens the gate for a plan the person did not
see. The dialog *shows* the hash — the server's, computed for that dialog — and sends
none back. An architecture test reads the write contracts for a `planHash` field, and an
E2E test asserts its absence on the wire.

**No runner executable either.** Runners are spawned by the use cases, inside a job,
exactly as the CLI spawns them. No write body names a binary.

---

## Credentials and the UtilityModel trust boundary

Agent Flow executes coding workflows through local CLI runners you have already authenticated.
With MVP 3, an optional, provider-neutral **UtilityModel** port is available for advisory context ranking, compression, and log/diff triage.

### AgentRunner Credentials
- Runner health reports `installed`, `executable`, and whether auth is *configured* — the same shallow check the adapters provide to `doctor`. No handler opens an auth file.
- Agent Flow does not read, store, or transmit CLI credentials.
- No endpoint returns environment variables.
- An architecture test asserts that no module under `src/server/` names an auth file or reads the environment.

### UtilityModel Credential Containment & Network Policy
- **Zero ambient network calls**: Agent Flow performs zero network calls by default. Outbound HTTP requests occur only if the operator explicitly configures `utilityModel` pointing to a local or remote OpenAI-compatible endpoint.
- **`apiKeyEnv` pattern**: Configuration files store only the *name* of the environment variable (e.g., `"apiKeyEnv": "AGENT_FLOW_UTILITY_MODEL_API_KEY"`). The secret key is never written to disk or persisted in config files.
- **In-memory lookup**: The key is resolved in process memory at composition time and is never echoed in events, logs, telemetry observations, errors, or UI payloads.
- **Secret redaction**: Mechanical log and diff triagers strip authorization tokens, Bearer tokens, Basic/Digest headers, and sensitive environment variable patterns before context generation.

### Strict Advisory Authority Boundaries
- **Zero Workflow Authority**: The UtilityModel is strictly advisory. It cannot approve plans, bypass gates, create markers, sign receipts, alter task dependencies, or determine task completion.
- **Zero Evidence Authority**: `allowedEvidence` is strictly empty (`new Set()`) for retrieval prompts. The model cannot manufacture evidence references.
- **Zero Path Discovery Authority**: The repository candidate universe is discovered deterministically via canonical Git (`git ls-files -z`) and filesystem boundaries. Model-suggested paths outside the discovered candidate set are rejected immediately by `validateContextPacket`.
- **Fail-Open Degradation**: If the UtilityModel is absent, offline, timed out, or returns malformed/schema-violating output, the system logs a deterministic telemetry bypass and continues stage execution with zero disruption.

---

## Two processes cannot execute one run

The CLI in a terminal and the server in a browser are two processes over the same
directory, and both can schedule agents. An inter-process lock per run makes that
impossible: `approve`, `reject`, `revise`, `retry` and `run` all take the same lease,
through the same use cases, so the two adapters exclude *each other* rather than each
excluding a set of peers the other is not in.

- The claim is created with an exclusive filesystem primitive, so acquisition is atomic
  rather than a check followed by a write.
- A claim left by a process that died is recovered by generation, and the recovery is
  recorded as an event — reclaiming it silently would leave no trace that a previous
  execution ended without releasing anything.
- A claim written by **another machine** is never judged. Agent Flow refuses and says
  so, because deciding a remote process is dead is a guess, and guessing is how a run
  gets executed twice.
- A claim that cannot be read is also a refusal, and the message names the file to
  remove after confirming no Agent Flow process is working on that run.

Proved with eight real processes racing one lock file, and with an opt-in stress run of
640 (`AF_LOCK_STRESS=1`) — a race is a test that has to pass often rather than once.

**`review` joined that list in worktree mode**, and only there. In sequential mode it
reads the user's working tree and takes nothing. In worktree mode it reads and runs
commands inside the *integration worktree* — the same checkout the Integrator merges
into — so a review issued while the run holds its lease would otherwise observe a
half-merged tree and report a verdict about a state that never existed. It gets
`run_busy` instead.

---

## Binding somewhere other than loopback

Possible, and loud:

```bash
agent-flow ui --host 0.0.0.0
```

The command prints a warning saying exactly what that means: this server has no
authentication, so anything that can reach the port can read every run, every artifact
and every project path on this machine. That is a reasonable thing to want on a trusted
network and an unreasonable thing to do by accident, which is the difference a warning
makes.

---

## Loopback is not a boundary against the browser

**This section replaces a wrong assumption, and the wrongness was measured rather than
argued.** "Only this machine can reach the port" was taken to mean "only the operator can
reach the port". It does not. The operator's browser is on this machine, and every page
it has open can issue requests to `127.0.0.1`. Against the server before this guard
existed, from `Origin: https://evil.example`:

```
POST /api/v1/runs/:id/start   (no body)  →  202  {"status":"running"}
```

`start` spawns coding agents with **write** permission inside the repository and then runs
that project's validation commands. Nothing about CORS prevented it: a `POST` with no body
and no unusual header is a *simple request*, which the browser sends without a preflight.
CORS withholds the **response**, not the effect.

Two vectors, closed by two independent guards, because each one is blind to the other.

### Cross-origin writes

Every `POST`, `PUT`, `PATCH` and `DELETE` is decided before routing:

- an `Origin` is accepted only when it names this server's own authority;
- a request with no `Origin` — a script, `curl`, the CLI — must carry
  `x-agent-flow-client`. Setting a custom header makes a cross-origin request
  *non-simple*, so it earns a preflight, and this server answers none.

Reads are deliberately left to the host guard alone. A cross-origin read is already
useless to a page: this server sends no `Access-Control-Allow-Origin`, so the browser
withholds the body. Adding an origin check there would break nothing and prove nothing.

```bash
curl -X POST -H 'x-agent-flow-client: 1' \
  http://127.0.0.1:4782/api/v1/runs/AF-2026-001/approve
```

### DNS rebinding

A hostile domain whose DNS answer flips to `127.0.0.1` becomes **same-origin** to the
browser. Origin and Host then agree, CORS is out of the picture entirely, and the origin
guard above sees nothing wrong — which is why it cannot be the only guard.

So the `Host` header is checked on **every** request, read included, against one rule:

> An address literal cannot be rebound, because it asks no DNS question.

`127.0.0.1`, `[::1]`, `192.168.1.9`, `[::ffff:127.0.0.1]` — all accepted, whatever the
address. `localhost` is accepted as the one name the operating system resolves and an
attacker cannot move. **Every other name is refused**, including on reads, because
`GET /api/v1/projects` returns the absolute path of every repository on the machine and
the artifact endpoints return plans, SDDs and diffs.

A reverse proxy under a real name is the one legitimate exception, and it is declared:

```yaml
ui:
  allowedHosts: [flow.internal]
```

Empty by default. The emptiness is the defence.

Enforced in `src/server/request-guard.ts`, ahead of body parsing and ahead of routing, so
a refusal cannot have had an effect. Proven in `test/server/request-guard.test.ts`,
including the exact request that used to answer 202.

---

## What a coding agent inherits

A coding CLI is a program with a model inside it, reading a repository somebody else wrote.
Until this was measured it received `{ ...process.env }`: the orchestrator's whole
environment, including every credential that has nothing to do with the task. On the
machine this was built on that was **77 variables, of which 17 are needed** — the rest
included cloud keys, a Kubernetes config, registry tokens and an SSH agent socket.

The list is of what the runners **need**, not of what is dangerous. A denylist of
credential-shaped names is a race against every product that ever invents an environment
variable; this direction fails closed. It lives in `src/core/process-environment.ts` and
each group carries the reason removing it would break something.

Kept: `PATH`, `HOME` and the rest of being a process · locale and terminal · proxy and
certificate-authority settings, without which nothing authenticates behind a corporate
proxy · the runtime prefixes (`NODE_`, `NVM_`, `XDG_`, …) · and **vendor authentication by
prefix** (`ANTHROPIC_`, `OPENAI_`, `CODEX_`, `GOOGLE_`, `AGY_`, …). Those last are
credentials and they are kept on purpose: they are the ones the runner is *for*.

Widen it deliberately, never by accident:

```yaml
execution:
  passEnv: [ACME_, MY_TOOL_HOME]     # trailing `_` is a prefix; otherwise an exact name
```

### Two things that are deliberately dropped

**A parent agent session.** Running Agent Flow from inside a coding CLI is ordinary, and
the vendor prefixes passed that session's id, socket and token straight through to the
spawned agent. §3.6 promises planning, execution and review get *fresh* contexts; an
executor holding a channel back to the orchestrating session has left one. A short,
auditable exception list names them.

**An inherited effort.** Reasoning level is a kernel decision: resolved from the role's
configuration, clamped to what the (runner, model) pair supports, and recorded as
`reasoningClamped` when the two differ. An environment variable that quietly outranked the
flag would reintroduce exactly the defect
[`runner-capabilities.md`](runner-capabilities.md) records against AGY — an invocation
accepted at an effort nobody asked for, with nothing saying so.

### What this costs, stated plainly

**An agent no longer has your SSH agent.** `SSH_AUTH_SOCK` is dropped, so an agent cannot
push with your key or fetch from a private remote in its own shell. Git keeps it — the Git
boundary asks to inherit — so signing, remotes and credential helpers are unaffected for
everything Agent Flow does itself.

**Two callers still inherit everything, and both say why.** The Git boundary subtracts the
eleven variables that can redirect a repository instead, because a scrubbed environment
would lose commit signing and SSH access. And `project.commands.*` are your own commands,
run as you wrote them — an integration test that needs a database URL is not this
boundary's business, and this page already said those are not isolated.

**This bounds reach, not intent.** A model influenced by repository content (T6, T7) is
still influenced. What changed is how much a successfully-influenced one can pick up.

Verified by running the CLIs under it rather than by reasoning about the list —
`scripts/env-allowlist-probe.ts` invokes each installed runner with this environment and
nothing else, and re-runs any failure with the full environment before blaming the list.
Claude Code 2.1.251, Codex 0.149.0 and AGY 1.1.22 all authenticated.

---

## An attempt's evidence cannot be confused with the agent's output

An implementation agent runs with write permission inside its own worktree. Files,
commits, a report block — all of it is the raw material of the task, and all of it is
something the agent chose to write. So the orchestrator's evidence that validation
actually happened has to be *structurally* separate from anything the agent could
produce. Without that separation, "the branch has a commit that looks like a marker" is
the only signal, and a commit that looks like a marker is a commit an agent can write.

The separation is an ordering, and the ordering is the whole mechanism:

```text
the agent's process exits                    ← nothing below can start earlier
        ↓
validation commands run                      agent-flow runs them, not the agent
        ↓
the expectation is judged
        ↓
git add -A · git write-tree                → the tree validation ran over
128 random bits from the OS                  ← the nonce first exists HERE
        ↓
attempt-<n>.json, written atomically         ← the authority
        ↓
git commit-tree <tree> -p <base>             the marker, built from that file
git update-ref <attempt branch>
```

Four properties fall out of it, and each closes something specific:

- **The nonce does not exist while the agent is alive.** There is no moment at which a
  running agent could read it, guess it or copy it.
- **The tree is captured after validation, not before**, so what is recorded is the tree
  the commands actually ran against rather than the one the checkout started with.
- **The artifact is written once, atomically, outside every worktree.** `.agent-flow/runs/`
  lives in the project directory and is gitignored, so it is not part of any checkout an
  agent receives. A second write to an existing `attempt-<n>.json` is refused, not merged
  and not overwritten — including when the bytes are identical, because "it is the same
  content" is the argument that turns an append-only record into a mutable one.
- **The marker is a deterministic function of that file.** Its tree, its parent, its
  message, its identity and both its dates are read back off disk, so re-running
  `commit-tree` after a crash produces the *same* commit id. That is what makes recovery
  need no bookkeeping, and it is why the author is a fixed `Agent Flow <agent-flow@local>`
  rather than your `user.name`: a marker attributed to a person is a statement that is not
  true, and it would also make the commit id depend on the machine it was produced on.

The schema enforces the pairing that makes half-forgery useless: a receipt exists **if and
only if** the judgement is `satisfied`. An artifact with a receipt and an unsatisfied
judgement does not parse, and neither does the reverse. Recovery cross-checks the nonce
**and** the tree — the tree alone would accept any commit that happens to have the right
contents, and the nonce alone would accept a commit whose trailers were copied.

Marker trailers (`Agent-Flow-Receipt`, `Agent-Flow-Tree`, …) are diagnostic. They are text,
and text is what an agent can write; nothing trusts them.

---

---

## What an agent says to another agent is untrusted input

M4 gave a run a channel between its agents. Everything in it is model output arriving
through a different door than a plan, and the defences are the ones a plan already has.

### The agent proposes; Agent Flow decides

An implementation agent runs as a child process inside a sandboxed worktree, and Agent
Flow cannot intercept what it does. So the same ordering that makes a validation receipt
trustworthy makes a message trustworthy:

```text
the agent's process exits                    ← nothing below can start earlier
        ↓
`.agent-flow-outbox.json` is read
        ↓
it is removed from the workspace             ← before any tree is captured
        ↓
schema · redaction · budgets · re-keying
        ↓
appended to the run's collaboration log
        ↓
validation commands run                      (unchanged)
        ↓
git add -A · git write-tree                  the tree never contained the outbox
```

That last property is proved against real Git rather than asserted: an attempt that
speaks captures a tree byte-identical to one that stays silent, the outbox never appears
in `filesChanged`, and it never reaches the operator's own `git status` in sequential
mode.

### Five things an agent cannot do, closed by construction

- **Forge a sender.** The shape an agent writes has no `from` field at all, so a forged
  one is discarded by the parse rather than by a check somebody has to remember. The
  harvest *notices* the attempt and records it, because a defence that leaves no trace is
  a defence nobody can audit.
- **File against another task.** `taskId` is assigned from the dispatch.
- **Choose its own id.** Ids are allocated from the log, by maximum rather than by count,
  so a skipped malformed line never causes a reuse.
- **Reach outside the workspace.** The outbox path is resolved and checked for
  containment through the same rule the project registry uses, so an outbox that is a
  symlink to `~/.ssh/id_rsa` is refused rather than read — and the refusal quotes nothing
  of what it found.
- **Exhaust the machine.** The file's size is checked against the filesystem *before* it
  is parsed: a schema cannot defend against a file it has already been handed.

### A message never reaches a shell, a path or a ref

A body is text. A reference is a closed union whose `file` variant is validated by the
same repository-path rule the ContextPacket trust boundary uses — absolute paths, `..`,
percent-encoded traversal, URL schemes, drive letters, UNC shares, control characters,
`.git` and `.agent-flow` are all rejected. Architecture tests forbid every collaboration
module from importing a shell, a process runner or a Git module, and from importing
anything that can move a run.

### Nothing is silently overwritten

The blackboard is append-only and there is no update, no delete and no edit anywhere in
the product. A change is a new entry naming the one it replaces, and what the pair *means*
is decided by a projection rather than by whoever wrote last:

- superseded by its **own author** — a correction; the old entry drops out of context;
- superseded by **somebody else** — a disagreement. **Both stay live, both reach the next
  agent**, both are marked contested, and an event says so.

The alternative was a permission lattice deciding who may overrule whom, which is an ACL
nobody maintains. This needs none: an executor that finds the architect's contract wrong
can say so, and what it cannot do is make the architect's entry disappear.

### Everything is bounded

Messages per task, bytes per message, bytes of the outbox file, thread depth, handoffs per
task, entries per run, and bytes of the block that reaches a prompt. An exhausted budget
stops the channel, records which budget, and names the one action that clears it.

### What is deliberately withheld

**An accepted handoff does not re-route execution unless an operator says so.**
`collaboration.handoffsReassignExecution` ships `false`. With it off a handoff is a
complete, auditable record that changes no execution; with it on, the target must still
satisfy what an implementation task needs, checked through the same role resolver
everything else uses. Re-routing execution from model output is an ownership transfer, and
ownership is not a model's to decide.

**The whole channel ships off.** With `collaboration.enabled: false` no outbox is read, no
directory is created, and not one byte of any prompt differs from before the milestone —
which is asserted by comparing two runs rather than by inspection.

### The limit

**The block an agent receives is prompt-injection surface, and framing is the only
mitigation.** It is presented exactly as MVP 3's advisory context is: written by another
agent, not validated, carrying no authority, with the task and the specification named as
the contract. Agent Flow branches on nothing in it — no message completes a task, opens a
gate, moves a stage or signs a verdict — so the worst a hostile peer can do is waste an
attempt. It cannot make one succeed.

---

## A review is a claim, and the gate is the authority

M6 gave a run a second kind of model output about its own work: a judgement. A judgement
is more dangerous than a message, because a message is obviously an opinion and a verdict
looks like a decision. The rule that makes it safe is the one the whole product runs on —
**models propose, Agent Flow decides** — applied per field rather than per document.

### The reviewer proposes a verdict and nothing else

The shape a review agent may write is three fields: `verdict`, an optional `summary`, and
`findings`. Everything that carries authority is absent from it by construction, which is
the same defence that closed M4's sender forgery — a field an agent cannot write is a
field nobody has to remember to check.

| An agent cannot | Because |
|---|---|
| name itself as the reviewer | the reviewer comes from the assignment policy; the response schema has no reviewer field |
| choose a finding's id | ids are allocated from the run's log, by maximum rather than by count |
| set a finding's status | status is *derived* from reviews, messages and corrective work — nothing writes it |
| declare a finding verified | `verified` needs a later review of a *different* tree; the event vocabulary has no `finding_verified` to emit |
| declare a quality gate passed | a gate's status is the exit code of a command from human configuration |
| name the command a gate runs | `QualityGateConfigSchema` has no command field; the id resolves through the existing validation registry |
| say which tree it reviewed | `reviewedTree` is the integration merge commit, taken from the run |

### Thirteen threats, and what stops each

| Threat | Defence |
|---|---|
| **Self-review** | `is_author` is an *eligibility* exclusion checked before ranking, so an implementer scoring 1.0 is removed rather than out-ranked. An architecture test holds the ordering. |
| **Reviewer identity forgery** | Not in the schema. The reviewer is whoever `selectReviewer` returned, recorded in `reviewer_assigned` before the call is made. |
| **Finding identity forgery** | Not in the schema. `normaliseReview` assigns `FIND-nnnn` from the log. |
| **Path traversal in a finding** | A finding's `file` goes through the same repository-path rule the ContextPacket boundary uses; a rejected path is *removed* from the finding rather than merely flagged. That removal was a bug once — the code spread the original object and added the key back only when valid, so a rejected path survived — and the regression test now proves the key is gone. |
| **Review prompt injection** | A review is data on the way in and a proposal on the way out. Nothing in it selects a command, a path, a ref or an agent. `prompts/code-review.md` is `permissions: read-only`. |
| **A developer message closing a finding** | Acknowledging closes nothing and disputing closes nothing (§25). `fixed` requires a corrective task that completed; `verified` requires a later review of a different tree. Both are folds over evidence, not writes. |
| **Fake quality evidence** | Gate status joins the *executor's* recorded `CommandResult`s to registry-resolved commands. A model's account of what it ran reaches no gate. |
| **Stale review reuse** | The quality decision's fourth condition compares the review's tree to the integrated one. Identity, never a timestamp: a review written after a change can still have read what came before it. |
| **Reviewing the wrong tree** | `reviewedTree` is the integration merge commit, and the reviewer runs against that workspace. A sequential run has no tree and is `unverifiable` rather than `current`. |
| **Review flood** | `review.maxRounds` is checked before a reviewer is named and before a call is spent. Running out approves nothing: the last review stands, and if it asked for changes the decision still refuses. |
| **Finding flood** | A proposal's findings are truncated to a configured maximum during normalisation, and `ReviewRecordSchema` caps the array at 64 with every string bounded. |
| **Infinite review/correction loop** | `review.maxRounds` bounds re-reviews, `recovery.maxCorrectiveRounds` bounds corrective rounds, and the counter is *written* as well as read — it was read and never written once, and every round compared zero. |
| **Suppressing a required validation** | A gate's `required` flag is human configuration. `NOT_RUN` is never `PASS`, so a gate an agent avoided running blocks exactly as a failing one does. |

### What this does not defend against

A reviewer that is simply wrong. Every defence above is about *authority* — what a model's
output is allowed to decide — and none of them make a judgement correct. That is why the
deterministic gates are separate, why `NOT_RUN` blocks, and why a review's verdict is one
of four conditions rather than the decision.

Nor does it defend against a reviewer on the same provider as the author reaching the same
wrong conclusion. Independence is *measured and recorded*, including when it degrades; it
is not enforced, because a team may honestly have one provider.

## A remote is a destination, and destinations do not decide

M7 gave a run somewhere to go. Everything it publishes is a commit the local workflow has
already approved, and everything it reads back — a check, a review comment, a workflow
name — is untrusted text from a machine this process does not own.

The rule underneath every row below: **GitHub is a destination and a diagnostic source.**
It decides no task completion, no run completion, no approval, no validation, no review
correctness, no quality gate, no integration, no assignment, no ownership and no recovery.

### Three seams, and the separation is the defence

```text
GitClient            local Git facts, read-only, no network
RemoteGitPublisher   one exact commit to one exact ref, through the Git allowlist
ForgeProvider        Issues, pull requests, checks — a REST API, and no Git at all
```

Creating a pull request requires the commit to exist remotely. That is a Git operation, and
it does not become an API operation because an API operation depends on it — **a provider
that could run Git could rewrite history to make its own call succeed.** The architecture
suite checks this transitively rather than by direct import, because proving a file imports
no Git module does not prove it cannot cause Git to run.

### What an operator's credentials are protected from

| Threat | Defence |
|---|---|
| **Token leakage** | The configuration stores the *name* of an environment variable, and its pattern rejects a pasted token. The value is read at one composition boundary, held in one closure, and reaches one header. The architecture suite proves no other file names the variable and that the adapter appends no event, writes no file and touches no console. |
| **Authorization surviving a redirect** | `redirect: 'error'`. Following one re-sends the header, and a redirect to another host is how a token leaves the machine. The API host is a literal in the schema, so a project file cannot move it. |
| **SSRF** | No text from a repository, an agent or a remote becomes a URL. Every path is built from `encodeURIComponent` over an owner and a repo that passed a strict pattern. |
| **Git auth confused with API auth** | Two credentials that never meet. The publisher uses the operator's existing credential helper or SSH agent; the REST token is never written into a Git URL and never persisted into a remote. A URL where a remote *name* belongs is refused. |
| **Repository mismatch** | Three spellings of one URL normalise to three fields, compared field by field before **every** mutation — not once at construction, because a run is long and "we checked at startup" is how work lands in somebody else's repository. |
| **A malicious remote URL** | A dot segment is refused before `URL` normalises it: `https://github.com/../etc/passwd` resolves to a perfectly ordinary `etc/passwd`, and returning an identity nobody wrote down is what the parser exists to prevent. The SCP-form pattern is anchored end to end, so `git@evil.example:x/y#github.com/o/r` is not read as GitHub. |
| **A malicious branch or ref** | The destination is *computed* from the run id, never passed. `main`, `master`, `trunk`, `develop` and `HEAD` are refused by name; so is any branch that is not this run's own; so is any shape Git could read as something other than a branch — a leading dash, a range, a reflog selector, a refspec colon, a glob, a `.lock` suffix, a control character. |
| **Remote branch overwrite** | `--force`, `-f`, `--force-with-lease`, `--force-if-includes`, `--delete`, `--mirror`, `--prune`, `--all`, `--tags` and `--receive-pack` are refused by name at the layer that builds the argv. A remote holding a commit that is not an ancestor is a divergence a person resolves; `--force-with-lease` reads as careful and still discards what the lease did not know about. |
| **Publishing a stale SHA** | The input is a forty-character object id validated by the schema — never `HEAD`, never a name resolved at push time, never an abbreviation. |
| **A push that reports success and a branch that holds something else** | The branch is read again afterwards and compared. `exitCode 0` is a claim; "the branch holds the approved commit" is a different sentence. |
| **Model-controlled PR or Issue fields** | No schema a model writes has a field for a ref, a pull request or an issue number. Bodies are composed from a template over facts, bounded, and labels come from a human allowlist. |
| **A duplicate object after a crash** | Every mutation writes its intent, calls the remote, then writes the outcome — so a crash between the last two is *visible*. Recovery reads local evidence, then the remote's own copy of this run's fingerprint, then creates. Two objects carrying one mark is `forge_ambiguous_recovery`, never a choice. |
| **A recovery that misses the object it is looking for** | The scan **lists** rather than searches, because GitHub's search index is eventually consistent and "not found" from a stale index means "create another one". A scan that reaches its bound without an end answers ambiguous rather than empty. |
| **A malformed response** | Every response is size-checked before and after reading, parsed inside a `try`, and narrowed by a schema. A field that is missing or a shape that is wrong is `forge_invalid_response`, never a partially-trusted object. |
| **Rate-limit loops** | One request per call, no internal retry. `429`, and `403` with `x-ratelimit-remaining: 0`, become `forge_rate_limited` with the wait the remote asked for. Rate limiting is a delivery failure, never a task failure. |
| **Unbounded responses** | A declared `content-length` over the ceiling is refused before the body is read, and the body is measured again after. |
| **Remote prompt injection** | Nothing from the remote reaches an agent. M7 reads Issues, pull requests and checks; it feeds none of them into a prompt, and the delivery projection renders them as text. |
| **A check becoming local authority** | `ForgeCheck` carries no `required`, no `gateId` and no `category` — the three fields that make a quality gate a gate. A conversion has to be written by hand, and the architecture suite refuses it. An unrecognised status or conclusion is `unknown`, and `unknown` counts as pending rather than green. |
| **A forge failure mutating run completion** | Nothing under the forge may call `updateRun` or write a completed status, and the suite checks it. A failed delivery is recorded on the delivery record; the run stays exactly as the local workflow left it. |
| **Cross-repository credential exposure** | A pull request is opened in the configured repository from a run-owned branch in that same repository. Cross-repository pull requests are out of scope, and a fork never sees the token. |

### What this does not defend against

An operator who exports a token with more scope than delivery needs. Agent Flow uses what
it is given, and nothing here can tell a `repo`-scoped token from one that could also
administer the organisation. The mitigation is a fine-grained token limited to the one
repository — a sentence in a document, which is the weakest kind of control and the only
one available from this side.

Nor does it defend against a person merging the pull request. M7 opens one and stops:
there is no merge, no auto-merge, no branch deletion and no repository administration. What
happens after a human reads it is a human's decision, which is the point.

## The control plane renders decisions and reaches none

M8 puts a board, a queue and a set of buttons in front of an operator. None of it is new
authority, and three properties keep it that way.

**Eligibility on screen is presentation; the server decides at the click.** A run moves
between the render and the press — a task finishes, a gate opens, another process takes the
execution lock. So a button that is enabled and then refused is correct behaviour, and the
refusal is the server's. There is no write path that trusts what the browser believed a
second ago, and no request carries a hash, a ref or a path for the same reason it never
did.

**Nothing on these surfaces is stored.** A lane is a question about a task, the DAG and the
run; an attention item is a fold over facts something else decided. Neither has a
`*.schema.ts` module, because every file with that suffix describes something written to
disk, and a crash mid-write would persist an opinion. The practical consequence is the one
that matters: an item disappears when its fact does, and there is no dismiss — a failed
gate somebody could close is a failed gate nobody sees the second time.

**Everything the queue and the board render is untrusted text.** A task title, a finding, a
degradation's impact sentence, a remote check's name, a delivery failure's detail — every
one of them was written by a model or by a stranger's repository. All of it renders as
text. No `dangerouslySetInnerHTML` was added, and the component tests plant a payload in
each source and assert it appears on screen as characters.

**A remote check is still not a local verdict.** M8 raises red remote checks in the queue,
because three failed checks on a pull request are something an operator acts on — and the
item's own sentence says which kind of failure it is, rather than leaving the reader to
know. An architecture rule asserts the two never merge in the reader that serves them
together.

## The limits, stated plainly

**The receipt is not unforgeable against an agent that escapes its worktree.** This is a
stated limit rather than a hidden one. An agent that can write into
`<projectDir>/.agent-flow/runs/` can write a fabricated attempt artifact *and* a matching
ref, and no scheme available to a local-first tool without a secret store changes that —
the same capability lets it write `state.json` directly, at which point there are no
defences left at all.

So the honest claim, and the only one made: the receipt raises the bar from *structurally
indistinguishable from normal agent output* to *requires escaping the worktree and writing
into orchestrator-private state*. Containment during execution remains the runner's job,
below, unchanged.

**Which ref the Integrator asks Git about is derived, not read.** The artifact is the
authority on *what was validated*; it is not the authority on which ref this process then
resolves. Those are separable, so they are separated: the attempt ref is composed from the
run's own identity through the same function that created it and that recovery re-derives,
and the branch recorded in the artifact is required to agree with it. This closes nothing
that §11.3 leaves open — an agent that can write the artifact can write the ref too — but
it means a corrupted artifact is refused as a mismatch rather than sending a lookup
somewhere else. Every ref is re-validated at the adapter besides, against a character
allowlist and a hostile-pattern check, immediately before it becomes an argv element.

**Parallel attempts do not share anything writable.** Each holds its own locked worktree,
cut from the wave base on its own branch; nothing writes to the user's checkout at any
point; and integration is serialised behind a mutex, so two merges never interleave even
when four agents finish at once.

**Containment during execution is the runner's, not ours.** Read-only stages run under
`--permission-mode plan` (Claude Code) or `-s read-only` (Codex), and Agent Flow never
passes the flags that disable them. But Agent Flow spawns a CLI as a child process and
cannot intercept what that process runs. Anything stronger needs a container.

**A read-only sandbox is not "writes nothing anywhere".** See
[`engineering/findings.md`](engineering/findings.md) for what was measured.

**No Git hook runs inside an Agent Flow operation.** Every internal Git command carries
`-c core.hooksPath=<an owned, empty directory>`, placed before the subcommand where no
caller-supplied argument can reach. `--no-verify` was rejected as the mechanism: it does
not exist for `update-ref`, does not cover the `post-checkout` that `git worktree add`
runs, and covers only some merge paths. Your hooks are untouched and still run normally
when *you* merge the integration branch — the repository's configuration is never
modified, and `agent-flow` never writes to `git config`. Hooks are also **not** isolated
from `project.commands.*`: those are your commands, run as you wrote them.

**There is no authorisation model.** Anyone who can reach the port *and satisfy the
request guard* can approve a plan and start a run. The guard establishes that the request
came from this server's own dashboard or from a non-browser client on this machine; it
does not establish **who**. On loopback that is the person at the keyboard and any local
process that can open a socket. Bound elsewhere, it is everybody on that network — the
guard does not change that, and `--host 0.0.0.0` still warrants the warning it prints.

**The process timeout cannot signal a process tree on Windows.** Elsewhere the child runs
in its own process group and the whole tree is signalled; on Windows only the direct
child is reached, so a CLI that spawns children can outlive its timeout.

**Diagnosis under contention has a known gap.** A claim can be observed after creation
and before its contents are written, and the refusal then says the claim could not be
read rather than naming who holds it. Mutual exclusion is unaffected — the file exists,
so acquisition fails — and the fix is deferred rather than forgotten. See
[`engineering/findings.md`](engineering/findings.md).
