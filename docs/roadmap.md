# Roadmap

What is done, what is being built now, and what is deliberately not being built.

The normative source for MVP 2 is
[`specs/mvp2-safe-parallel-execution.md`](specs/mvp2-safe-parallel-execution.md).
Where this page and that document disagree, the specification wins — and where the
specification and the code disagree, **the code is the current truth**.

```text
MVP 1  ─────────────────────────────────►  the execution foundation, complete
MVP 2  ─────────────────────────────────►  safe parallel execution, complete
MVP 3  ─────────────────────────────────►  context intelligence & advisory local model, complete
                                        ▲
                                        you are here: MVP3 corrective audit closure complete
```

---

## MVP 1 — the execution foundation · complete

Specified in [`specs/implementation-spec-v3.md`](specs/implementation-spec-v3.md),
kept as a historical record. It established everything the current product runs on:

- the logical role model, the deterministic router and the reasoning abstraction
- the planning pipeline: discovery → architecture impact → SDD → plan → plan review
- the approval gate, bound to one exact plan hash
- the DAG, the scheduler, the task executor, resume and retry
- validation commands run by the orchestrator, never by an agent
- final review and Definition of Done evaluated as code
- the local Web Control Plane, and write actions as use cases both adapters share
- the inter-process run execution lock

Two things were designed under MVP 1 and deliberately **not** built. Both are still
unbuilt, and both have their own document:

- [`config-write-design.md`](config-write-design.md) — `PATCH /config`
- [`pause-resume-cancel-design.md`](pause-resume-cancel-design.md) — `pause` / `resume` / `cancel`

---

## MVP 2 — Safe Parallel Execution · complete

Specified in [`specs/mvp2-safe-parallel-execution.md`](specs/mvp2-safe-parallel-execution.md).
Delivered Git worktree isolation, receipt-first marker verification, deterministic integration,
crash recovery, and parallel scheduler activation across M2-00 through M2-12.

---

## MVP 3 — Context Intelligence & Advisory Local Model · complete

Specified in [`specs/implementation-spec-v4-draft.md`](specs/implementation-spec-v4-draft.md).
Introduces an optional, provider-neutral, strictly advisory local UtilityModel layer that reduces
context bloat and accelerates stage execution while preserving all security invariants.

| | Milestone | Status |
|---|---|---|
| M3-00 | Architecture and probes | **done** |
| M3-01 | UtilityModel port | **done** |
| M3-02 | OpenAI-compatible adapter | **done** |
| M3-03 | ContextPacket | **done** |
| M3-04 | Repository retrieval | **done** |
| M3-05 | Hierarchical compression | **done** |
| M3-06 | Log and diff triage | **done** |
| M3-07 | Context telemetry | **done** |
| M3-08 | Primary-runner context integration | **done** |
| M3-09 | Dogfood and benchmark | **done** |

### Core Invariants Guaranteed by MVP 3

- **Zero Workflow Authority**: The UtilityModel is strictly advisory. It cannot sign gates, create markers, modify DAGs, alter verdicts, or execute commands.
- **Fail-Open Advisory Degradation**: An offline, unconfigured, failing, or timed-out utility model degrades cleanly to an empty advisory context; stage execution continues unaffected.
- **Deterministic Candidate Discovery**: The repository file universe is discovered via canonical Git/filesystem methods; model-invented paths are rejected by strict trust boundaries.
- **Symlink & Inode Security**: The secure content reader rejects all symlinks, checks exact file bounds, and snapshots file handles against TOCTOU manipulation.
- **Credential Containment**: Configuration stores only the environment variable name (`apiKeyEnv`), never secrets. Telemetry, logs, and artifacts are strictly sanitized.

---

## Beyond MVP 3

See [`docs/post-mvp3-backlog.md`](post-mvp3-backlog.md) for non-normative enhancement ideas and future backlog items.
