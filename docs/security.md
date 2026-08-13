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

## Credentials are never read

Agent Flow invokes CLIs you have already authenticated. It does not read, store or
transmit credentials, and the server does not either:

- Runner health reports `installed`, `executable` and whether auth is *configured* —
  the same shallow answer the adapters give `doctor`. No handler opens an auth file.
- No endpoint returns environment variables.
- An architecture test asserts that no module under `src/server/` names an auth file or
  reads the environment.

`doctor --deep` probes each runner for real, which spends quota. It is an explicit,
one-off command and the dashboard never triggers it — a page that polled it would spend
quota repeatedly without anybody asking.

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

**There is no authorisation model.** Anyone who can reach the port can approve a plan and
start a run. On loopback that is the person at the keyboard; bound elsewhere, it is
everybody.

**The process timeout cannot signal a process tree on Windows.** Elsewhere the child runs
in its own process group and the whole tree is signalled; on Windows only the direct
child is reached, so a CLI that spawns children can outlive its timeout.

**Diagnosis under contention has a known gap.** A claim can be observed after creation
and before its contents are written, and the refusal then says the claim could not be
read rather than naming who holds it. Mutual exclusion is unaffected — the file exists,
so acquisition fails — and the fix is deferred rather than forgotten. See
[`engineering/findings.md`](engineering/findings.md).
