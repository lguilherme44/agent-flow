# M6 — Collaborative Review, QA & Quality Gates

## 0. Status and scope

Normative for M6-00 … M6-09. Where this document and the code disagree, the code is the
current truth and this document is the defect.

M4 answered *who the agents are* and *how they speak*. M5 answered *who should do this
work, and why*. M6 answers what happens **after** the work exists:

```text
who reviews it?
what exactly did the reviewer find?
how does the implementer answer?
who verifies the correction?
what is QA responsible for?
what evidence proves quality?
when may the workflow continue?
```

It does **not** build the forge — no PR, no remote comment, no GitHub issue: that is M7 —
and it does not build the Kanban, which is M8. M6 ends at a **quality-approved local
result**.

---

## 1. What M6 is being built on

The single most important fact about this milestone is how much of it already exists.
Every subsection below is a thing the repository does today, and M6's job is to give it a
lifecycle rather than to build it again.

### 1.1 Findings are already structured

`src/contracts/review.schema.ts` has carried `Finding` since MVP 3: `severity`, `type`,
`requirement?`, `description`, `suggestedAction`, `file?`. A `FAIL` verdict without
findings is refused by the schema itself. `CorrectiveOrigin` records where a finding came
from, and deliberately does *not* invent a requirement for a finding that names none.

**M6 adds an id, a status and a home. It does not redesign the shape.**

### 1.2 Findings already become work

`src/core/corrective-plan.ts` turns actionable findings into corrective tasks that
re-enter the same pipeline — routed, assigned, worktree-isolated, validated, integrated.
The plan hash changes, which invalidates the approval, deliberately.

**This is §28 of the charter, already built, at run granularity.** M6 keeps the mechanism
and changes what triggers it.

### 1.3 Semantic and mechanical are already separate

`ReviewOutcome` carries `mechanicalVerification: 'PASS' | 'FAIL' | 'NOT_RUN'` *beside*
`verificationReview: { verdict, findings }`. The doc comment on the first says why in as
many words: "exit codes answer *did the commands pass*, a model answers *does this look
right* … the evidence run rendered them under one label with opposite answers, and the
operator reasonably concluded the tool was lying."

**The charter's central rule (§9) and its `NOT_RUN ≠ PASS` (§41) are already law here.**
What is missing is the *third* thing — QA — and the per-task granularity.

### 1.4 The Definition of Done is already code

`checkDefinitionOfDone` gates on approval, every task completed, mechanical verification
`PASS`, and a final review `PASS`. §43 is this function plus two conditions.

### 1.5 Quality commands already come from a human

`buildValidationRegistry` resolves an id a plan names against a command a person wrote in
`commands` or `validationCommands`. The trust boundary is already the right way round:
**a plan picks from a list; it never supplies a command.** §37's "command continua vindo
da configuração humana existente. Nunca de LLM output" is satisfied by construction, and
§36's warning against a second `QualityCommandRegistry` is why M6 adds metadata beside
this registry rather than a registry beside it.

### 1.6 Freshness already has its mechanism

`ReviewResult` carries `planHash` and `integrationHead`. Freshness is already assessed
against tree identity rather than a timestamp.

### 1.7 M4 left the door open

`MESSAGE_TYPES` already declares `review_request` and `review_feedback`, commented
"declared for M6, produced by nothing in M4".

### 1.8 M5 is the assignment seam

`resolveTaskAgent` is the one answer to "who does this work". §18 is explicit that a
reviewer is assigned work like any other, and that there is to be no `ReviewRouter`.

---

## 2. What is missing, precisely

| | Gap | Consequence today |
|---|---|---|
| G1 | Review is **run-level**. There is no review of one change. | A seven-task run gets one review at the end, so a defect in task one is found after six tasks were built on it. |
| G2 | A finding is an **immutable line in an artifact**. | Nobody can acknowledge, dispute or verify one. "Fixed" is a claim in prose. |
| G3 | There is **no developer response**. | The reviewer's finding and the implementer's answer live in two documents that never meet. |
| G4 | There is **no re-review**, and so no budget for one. | A correction is integrated and nothing looks at it again. |
| G5 | **QA does not exist.** `verification` is a semantic review stage, not exploratory testing. | Nobody is responsible for the test that was never written. |
| G6 | Quality gates are **one run-level verdict**, not per-gate results with required/advisory. | `NOT_RUN` is preserved for the aggregate and lost for the individual gate. |
| G7 | **No review events.** `state.schema.ts` has no review vocabulary. | §63's timeline has nothing to fold. |
| G8 | **`assessReviewFreshness` runs in the browser.** | §59 forbids exactly this: the dashboard derives review freshness by its own rules. |
| G9 | Reviewer assignment **bypasses M5**. `final-review` uses `roles.finalReviewer`. | Skills, capacity, ownership and independence play no part. |
| G10 | Author ≠ reviewer is **recorded, not enforced**. `authorsOf` describes independence; nothing refuses. | A single-provider setup can review its own work and say so in a field nobody gates on. |

---

## 3. Invariants

Continuing from I-40.

- **I-41 — A review is a statement about one tree.** Every review names the commit it
  read. A review whose tree is not the tree now under consideration is *stale*, and a
  stale review satisfies no gate. Identity, never a timestamp.

- **I-42 — The implementer does not approve its own work.** Author and reviewer are
  different agents, enforced by the assignment policy rather than recorded after the
  fact. Where one provider is all there is, a fresh invocation with fresh context is the
  floor, and the degradation is persisted.

- **I-43 — A finding's status is derived, never stored.** Created by a review, answered
  by a message, fixed by an integrated corrective task, verified by a re-review: every
  transition is already a fact the run records. A second copy is a copy that can disagree.

- **I-44 — A model's verdict is advice; the gate is the authority.** A reviewer may say
  `approve`, QA may say "looks good", and neither passes a quality gate. A required gate
  passes when its command was executed by Agent Flow and exited zero.

- **I-45 — `NOT_RUN` is never `PASS`.** Absence of evidence is reported as absence, per
  gate, and a required gate that did not run blocks exactly as a failed one does.

- **I-46 — Every loop terminates.** Review rounds, correction rounds and disputes are all
  bounded. Exhaustion escalates to a person with what remains open, what was tried, why
  automation stopped, and one concrete action.

- **I-47 — A review cannot be an instruction.** Review output is validated against a
  schema before anything reads it, and a malformed review is not an approval. Nothing in
  a finding is interpolated into a command, a path or a ref; a finding's `file` goes
  through the repository-path validator, exactly as a collaboration reference does.

---

## 4. Domain

### 4.1 What is persisted, and what is not

Three stores already exist and M6 adds **one**:

```text
.agent-flow/runs/<runId>/
  events.jsonl                     audit — gains a review vocabulary
  collaboration/messages.jsonl     the conversation, including review dialogue
  collaboration/blackboard.jsonl   shared decisions
  reviews.jsonl                    NEW: one line per review, with its findings
```

**A finding's *content* is persisted; its *status* is projected.** `open`, `acknowledged`,
`disputed`, `fixed` and `verified` are each derivable without ambiguity from facts already
recorded — the review that raised it, the message that answered it, the corrective task
that integrated, the re-review that saw the corrected tree. Persisting the status as well
would be the second copy I-43 forbids, and it would be the copy a crash between two writes
leaves wrong.

This is the same call M4 made for `MessageThread` and M5 made for capacity, for the same
reason.

### 4.2 `ReviewRecord` — persisted

```ts
interface ReviewRecord {
  id: ReviewId;                 // REV-0001, allocated by Agent Flow
  runId: RunId;
  taskId: AnyTaskId;            // the change under review
  round: number;                // 1 for the first, 2 for a re-review, …
  reviewer: AgentId;
  author: AgentId;              // who wrote the code, for I-42
  independence: IndependenceLevel;
  reviewedTree: string;         // the commit the reviewer read (I-41)
  verdict: 'approve' | 'changes_requested' | 'blocked';
  scope: readonly RepositoryPath[];
  findings: readonly ReviewFinding[];
  summary?: string;
  createdAt: IsoTimestamp;
}
```

`verdict` is the reviewer's *proposal*. Whether the workflow advances is decided by §8's
gate, not by this field.

### 4.3 `ReviewFinding` — persisted content, projected status

```ts
interface ReviewFinding {
  id: FindingId;                // FIND-0001, allocated by Agent Flow (§16)
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  category: FindingCategory;
  requirement?: RequirementId;
  file?: RepositoryPath;        // validated, never invented
  location?: SourceLocation;
  description: string;
  evidence: readonly EvidenceReference[];
  suggestedAction?: string;
}
```

`FindingCategory` starts small and useful, exactly as §15 asks: `correctness`, `security`,
`requirement`, `architecture`, `maintainability`, `test-gap`, `performance`,
`accessibility`, `ux`. Open at the edges — an unknown category is carried, not rejected —
because a taxonomy that refuses the word a reviewer needed is a taxonomy that loses the
finding.

**Severity is extended downward, not sideways.** The existing `FindingSeverity` is
`low | medium | high | critical`; M6 adds `info`. Every artifact written before M6 still
parses.

### 4.4 `ReviewThread` — projected

Status comes from the log:

```text
requested          a review_requested event exists, no record yet
in_review          the reviewer is assigned and running
changes_requested  the latest record's verdict, with at least one blocking finding open
awaiting_recheck   every blocking finding is fixed and no re-review has seen the new tree
approved          the latest record approves, and it read the current tree
closed             the run moved past it
```

Nothing here is written down. Each state is a question about facts that already exist.

### 4.5 `QualityGateResult` — projected

```ts
interface QualityGateResult {
  gateId: ValidationId;                 // an id the registry already knows
  category: QualityCategory;
  required: boolean;
  status: 'passed' | 'failed' | 'not_run' | 'not_applicable';
  exitCode?: number;
  evidence: readonly EvidenceReference[];
  durationMs?: number;
}
```

Built from validation runs the executor already records. **No second registry** (§36):
configuration gains a `quality:` block that attaches *metadata* to ids the validation
registry already resolves.

```yaml
quality:
  gates:
    typecheck: { category: typecheck, required: true }
    lint:      { category: lint,      required: true }
    test:      { category: unit,      required: true }
    e2e:       { category: e2e,       required: false, appliesTo: ['apps/**', 'src/server/**'] }
```

`appliesTo` is mechanical (§40): a glob over the change's files, matched with the same
segment-aware matcher M5's ownership uses. A UtilityModel may *suggest* applicability and
may never switch a required gate off (§39).

---

## 5. Review lifecycle

```text
task integrated
   │
   ├─ review requested                    an explicit operation (§17), never implied
   ├─ reviewer assigned                   resolveTaskAgent, with review requirements
   ├─ review runs                         fresh invocation, fresh context (I-42)
   ├─ structured output validated         malformed ≠ approval (I-47)
   ├─ findings persisted with ids         Agent Flow allocates (§16)
   │
   ├─ implementer responds                acknowledge or dispute, via collaboration
   ├─ corrective tasks created            existing mechanism (§1.2)
   ├─ corrective work executes            AssignmentPolicy → worktree → validation → integration
   │
   ├─ re-review                           sees the corrected tree, or it is not a re-review
   └─ approved                            or budget exhausted → human
```

**Who reviews.** `resolveTaskAgent` with `TaskRequirements` carrying the review skills and
a new exclusion: `is_author`. Preference order, all through the existing score: different
provider, then different member, then — as a floor — the same member on a fresh
invocation with fresh context, with the degradation persisted (§19).

**Independence levels** (§19), persisted as the effective level:

```text
3  different provider, different context
2  same provider, different model or context
1  same provider and model, fresh invocation and fresh context
0  same execution context                                        FORBIDDEN
```

Level 0 is not a configuration an operator can reach: the reviewer is always a fresh
invocation, and an architecture test asserts the review stage does not reuse the
implementation's context.

---

## 6. Finding lifecycle

```text
open ──acknowledge──► acknowledged ──corrective task integrated──► fixed ──re-review──► verified
  │
  └──dispute──► disputed ──independent re-review──► verified | escalated
```

Neither an acknowledgement nor a dispute closes a finding (§25). `fixed` requires
**evidence of a corrective attempt**, not a message saying so (§26). `verified` requires
corrective work *and* either a re-review that read the corrected tree or mechanical
evidence appropriate to the category (§27) — a `test-gap` finding is verified by the test
existing and passing, not by a second opinion.

**A developer cannot verify its own finding** (M6-ACC-09): `verified` is derived from a
re-review or a gate, and neither is the implementer's to write.

### Disputes

A dispute is not a failure (§32). First dispute on a finding routes to an *independent*
re-review; a second unresolved dispute escalates to a person. Bounded by
`review.maxDisputeRounds`, default 1.

---

## 7. QA

**A QA agent is a team member with QA skills, not a tenth `WorkflowRole`** (§33). M5
already lets a member declare skills and serve several roles; adding a role for semantic
flavour would be adding a concept the assignment policy already has.

QA receives *tasks*, derived from the plan or from a review's `test-gap` findings, and
those tasks pass through the same AssignmentPolicy, worktree, validation and integration
as any other (§34). QA is exploratory: it writes tests, exercises edge cases, probes
concurrency, checks accessibility behaviour.

**QA saying PASS is advisory** (§35). It is a model's opinion about coverage. The gate is
what the commands did.

---

## 8. The final quality decision

A task's review is settled, and the run may continue, when **all** of:

```text
every required quality gate for this change   status === 'passed'
no open finding of blocking severity
the latest review verdict                     approve
that review's tree                            === the tree now integrated
the Definition of Done                        satisfied
```

**Severity policy** (§44), mechanical and documented:

| severity | effect |
|---|---|
| `critical` | blocks |
| `high` | blocks |
| `medium` | blocks when `review.blockOnMedium` (default `true`) |
| `low` | does not block |
| `info` | does not block |

`security` findings get the conservative treatment (§45): a `critical` or `high` security
finding cannot be downgraded by a later reviewer, and only a person may accept it as
residual risk — which the existing `ACCEPT_AS_RESIDUAL_RISK` adjudication already
expresses.

**No quality score.** §42 permits an aggregate as UX and warns what it costs; there is no
concrete question a number answers here that the gate list does not, so it is deferred
rather than added.

---

## 9. Budgets

| budget | default | on exhaustion |
|---|---|---|
| `review.maxRounds` | 3 | escalate with what remains open |
| `review.maxCorrectionRounds` | 2 | escalate |
| `review.maxDisputeRounds` | 1 | escalate |
| `review.maxFindingsPerReview` | 50 | truncate, count, and say so |

Every escalation carries the four things §30 requires: what remains open, what was
attempted, why automation stopped, one concrete action.

---

## 10. Context policy

A review receives *selected* context (§47), through M4/M5's existing machinery: the
requirements, the task, the validated diff and tree, the architecture decisions and
blackboard entries relevant to it, the open findings, and the quality evidence. Not the
whole history.

The reviewer sees **the tree under review** (§48). Not the working tree, not `HEAD` — the
commit the change integrated as. A review that read a different tree is not a review of
this change, and I-41 makes that a fact the projection can check rather than a hope.

---

## 11. Security

| Threat | Closure |
|---|---|
| Implementer forges a reviewer identity | `from` is assigned from the dispatch (I-28); a `ReviewRecord`'s `reviewer` comes from the assignment, not from the output. |
| Reviewer approves its own work | `is_author` exclusion in the assignment policy, plus an architecture test (I-42). |
| Agent marks a finding verified | `verified` is projected from a re-review or a gate; there is no field to write it in. |
| Finding with a traversal path | `file` goes through `validateAndNormalizeRepositoryPath`; a path that fails is dropped and counted. |
| Review message injects a workflow command | Review output is parsed into a schema; nothing in it is interpolated into a command, path or ref (I-47). |
| Agent suppresses a required gate | `required` comes from configuration a person wrote; no model output can change it (§39). |
| Stale review reused | I-41: the gate compares the reviewed tree against the integrated tree. |
| Review of the wrong commit | Same mechanism, same comparison. |
| Fake quality evidence | A gate's status comes from a command Agent Flow executed and an exit code it read. |
| Malformed review becoming approval | Schema validation precedes interpretation; a malformed review is `blocked` with a parse failure recorded (§22). |
| Finding flood | `maxFindingsPerReview`, truncated visibly. |
| Review loop exhaustion | §9's budgets, all terminating. |

---

## 12. Projections and surfaces

One projection, three surfaces — the rule M5-ACC-15 established and M6 keeps.
`core/review/view.ts` folds `reviews.jsonl` plus the audit log plus run state into a
`ReviewView`, and the CLI prints it, the API returns it and the dashboard draws it.

**Review freshness moves out of the browser.** `apps/web/src/lib/review-freshness.ts`
derives `current | stale | unverifiable` by its own rules today; §59 names review freshness
among the things the browser must never derive. The logic moves to the projection and the
browser renders the answer.

The timeline (§63) is folded from the existing event log. **No timeline store.**

---

## 13. Observability

Events added to `state.schema.ts`: `review_requested`, `reviewer_assigned`,
`review_started`, `review_completed`, `finding_raised`, `finding_acknowledged`,
`finding_disputed`, `finding_fixed`, `finding_verified`, `corrective_task_created`,
`re_review_started`, `quality_gate_evaluated`, `review_budget_exhausted`.

Metrics (§64), all folded rather than stored: review duration, time to first finding,
findings by severity and category, review rounds, corrective rounds, reviewer
independence, stale reviews, disputes, QA tasks, gate duration, gate failures, context
bytes, collaboration messages.

---

## 14. Backward compatibility

- A run with no reviewer in its team gets no per-task review, and behaves exactly as M5.
- A run created before M6 has no `reviews.jsonl`; absence is "no reviews", never an error.
- `ReviewResult`, `applyFixes`, `checkDefinitionOfDone` and the `review` command keep
  working. M6 extends them; it does not replace them.
- `FindingSeverity` gains `info` at the bottom; every existing artifact still parses.

---

## 15. Test strategy

| Layer | What it must prove |
|---|---|
| contract | Review, finding, gate and quality-config schemas; a config with no `quality:` parses unchanged; `info` severity round-trips. |
| unit | Finding status projection for each transition; severity policy; applicability matching; freshness against tree identity; budget termination. |
| integration | A review request assigns an independent reviewer; a blocking finding prevents approval; a corrective task passes through AssignmentPolicy, worktree and validation; a re-review reads the corrected tree. |
| crash | The five kill points of §51. Resume duplicates no review, loses no finding, approves no stale tree, re-runs no completed gate, exceeds no budget invisibly. |
| security | One per row of §11. |
| architecture | §66's eleven rules. |
| acceptance | M6-ACC-01 … 28, verbatim. |
| visual | Review panel, finding list, finding detail, quality gates, stale review, changes requested, re-review, blocked — inspected by eye, not regenerated blindly. |
| dogfood | M6-09, live. |

**Every fix the dogfood finds gets a test that fails when the fix is reverted** (§68).
Every acceptance fixture is audited against the question §69 asks: *does this fixture
represent the production state the test claims to represent?*

---

## 16. Work items

| | Item |
|---|---|
| M6-00 | This document, criticised before any code |
| M6-01 | Review and finding contracts; `reviews.jsonl`; the review vocabulary in the audit log |
| M6-02 | Reviewer assignment through M5's policy, with independence and `is_author` |
| M6-03 | Review execution: selected context, structured output, tree identity |
| M6-04 | Finding lifecycle as a projection; developer response through collaboration |
| M6-05 | Corrective work through the existing generator, triggered per finding |
| M6-06 | QA as skills, QA tasks through the ordinary path |
| M6-07 | Quality gates: metadata beside the validation registry, projected results |
| M6-08 | Freshness and blocking policy; the final quality decision |
| M6-09 | Read model, CLI, dashboard; acceptance, crash and threat suites; live dogfood |

---

## 17. Architectural critique of this specification

Written before the code, as §8 requires. Four things about the design above are worth
arguing with.

**The per-task review doubles the model calls, and this document does not price it.** A
seven-task plan becomes seven implementations plus seven reviews, plus whatever
corrections follow. §1.2's existing run-level review costs one call. The mitigation here
is that per-task review happens only when a team declares a reviewer — so the cost is
opted into by configuration rather than imposed — but that is a way of *avoiding* the
question rather than answering it. The honest position: the dogfood measures wall clock
and call count, and if the ratio is bad the answer is a policy about which tasks get
reviewed, decided on that evidence rather than now.

**"Status is derived" is the right call and the expensive one.** Deriving a finding's
status means every read walks the message log, the event log and the plan. M4 made the
same call for threads and it has been fine at the scale of one run; a run with fifty
findings and a hundred messages is a bigger fold. The projection is bounded and pure, so
the fix if it matters is a cache with a stated invalidation — but a cache is a second copy
and I-43 exists to prevent one. Measured, not assumed, is the position.

**The severity policy is a default dressed as a principle.** `high` and `critical` block,
`medium` blocks by default: those numbers come from the charter, not from evidence, and
this document should not pretend otherwise. What makes it safe is that it is mechanical
and configured rather than decided per run by a model — which is the property that
matters — not that the thresholds are right.

**The weakest part of the design is `verified`.** For `correctness` and `security` a
re-review is a genuine second look. For `test-gap` the mechanical evidence is strong. But
for `maintainability`, `architecture` and `ux`, "verified" means a model looked again and
did not complain, which is a weaker claim than the word suggests. This document does not
solve that; it names it, and requires that the *category* determine what counts as
verification, so at least the weakness is visible per finding rather than hidden in an
aggregate.

---

## 18. Acceptance

The charter's M6-ACC-01 … 28, verbatim.

| | Criterion |
|---|---|
| M6-ACC-01 | implementation receives independent reviewer |
| M6-ACC-02 | reviewer cannot equal implementation invocation |
| M6-ACC-03 | provider independence is preferred and degradation recorded |
| M6-ACC-04 | structured finding is persisted |
| M6-ACC-05 | invalid finding paths are refused/dropped safely |
| M6-ACC-06 | blocking finding prevents review approval |
| M6-ACC-07 | non-blocking finding does not incorrectly block workflow |
| M6-ACC-08 | developer response uses collaboration, not duplicate messaging store |
| M6-ACC-09 | developer cannot self-verify finding |
| M6-ACC-10 | corrective task passes through AssignmentPolicy |
| M6-ACC-11 | corrective task passes through Scheduler/worktree/validation |
| M6-ACC-12 | re-review observes corrected tree |
| M6-ACC-13 | review becomes stale after tree changes |
| M6-ACC-14 | stale review cannot satisfy final gate |
| M6-ACC-15 | QA can create/execute test work |
| M6-ACC-16 | QA output alone cannot pass quality gate |
| M6-ACC-17 | required validation gate executes mechanically |
| M6-ACC-18 | NOT_RUN is never PASS |
| M6-ACC-19 | review loop budget terminates |
| M6-ACC-20 | crash/resume does not duplicate review/findings |
| M6-ACC-21 | CLI/API/dashboard use same review projection |
| M6-ACC-22 | M4 collaboration invariants remain valid |
| M6-ACC-23 | M5 assignment/ownership/capacity invariants remain valid |
| M6-ACC-24 | live handoff/reassignment demonstrated |
| M6-ACC-25 | live collaboration payload changes downstream agent behavior |
| M6-ACC-26 | live review finds a real issue |
| M6-ACC-27 | live corrective loop fixes and verifies that issue |
| M6-ACC-28 | all mandatory quality gates green |

---

## Related documents

- [M4 — Collaboration Foundation](m4-collaboration-foundation.md)
- [M5 — Team Orchestration](m5-team-orchestration.md)
- [M5 — live dogfood report](m5-live-dogfood-report.md)
