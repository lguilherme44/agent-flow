# M5 — closing the live gaps, and what closing them found

M5 shipped with three paths proved by scripted test and never by execution: a handoff, a
reassignment, and an agent consuming a collaboration payload. This is the attempt to close
them before M6, what it cost, and what it turned up instead.

**Two product defects were found and fixed. The paths themselves are still not
demonstrated live, and the reason is worth more than the demonstration would have been.**

---

## The attempt

Four independent planning runs against a purpose-built repository (`~/wk/m6-dogfood`: an
order service with three areas and two owners across two providers), plus one full
execution of seven tasks.

The scenario was designed so a handoff would be *semantically necessary*: a task whose
work lands in an area another member holds exclusively, with the team's convention written
down. §2 of the charter is explicit that the conversation must not be fabricated, so the
messages had to come from the agents.

---

## Defect 1 — the protocol had no handoff in it

The bootstrap closed with:

> Use it only for a real question, blocker, finding, handoff or shared decision.

over a type list reading `question|answer|acknowledge|information|finding|decision|blocker`
— **no handoff** — and a JSON sketch with no `taskId`. A handoff is the one message kind
that must name both an agent and a task, and neither the type nor the field was shown.

An agent that wanted to hand work over had the word and not the form. That is the M4
deadlock in a different costume: a capability announced without the means to use it.

Fixed as a delta on the sketch already present, 105 bytes.

## Defect 2 — ownership was a policy no agent could see

M5 gave a team exclusive areas and gave the assignment policy teeth. The map reached the
scheduler, the ranking, the CLI and the dashboard. **It never reached the prompt.**

So an implementer could not know it was about to write into somebody else's area, could
not decline, and had no reason to ask for a handoff. The one channel by which an agent
could learn the boundary was `AGENTS.md`, written by hand — and duplicating the ownership
map there is precisely the second copy M5's own rules forbid.

Fixed: a member's briefing — who it is, what it owns, which areas are somebody else's and
what to do about it — appended to the bootstrap when a team is configured. Only exclusive
claims are named: `preferred` ranks a candidate and forbids nobody.

Both fixes have positive controls. The second exists because the first attempt at it did
not: the unit test for the builder passed while the service was passing it nothing.

---

## What four plans said

The scenario never arose, and not by accident.

**Four independent planning runs decomposed the work by module, and a module boundary is
the ownership boundary in a repository organised the way this one is.** Every time, the
work that belonged in the store became a task in the store, and the assignment policy
routed it to the store's owner. The cross-area situation a handoff exists to resolve was
resolved upstream, by the plan.

That is the plan gate working. Manufacturing a handoff would have meant manufacturing a
wrong plan, which §2 forbids in as many words.

The honest characterisation: **a handoff becomes necessary when a plan's `files.likely` is
wrong about where the work lands.** That happens — plans are estimates — but it is not a
thing a competent planner does on demand.

---

## What the execution said

Seven tasks, two providers, ownership routing correct on every one, one retry that changed
hands through capacity.

**Zero messages. Zero blackboard entries.**

The briefing did reach the prompts — 910 bytes for the member with no foreign boundary to
respect, 1 081 for the one that has one, measured on every implementation prompt. The
protocol was complete. The boundary was stated. Nothing was written.

| | agents invoked | outbox messages |
|---|---|---|
| M4 live dogfood | 5 | 1 |
| M5 live dogfood | 9 | 0 |
| M5 gap closure | 7 | 0 |
| **total** | **21** | **1** |

Twenty-one agent invocations across three milestones and two providers have produced one
message. The channel is not broken — M4's one message proves the machinery — and it is not
unavailable: it is on every prompt, and now with a complete protocol. **Agents given a
well-specified task simply do it.**

---

## The score floor (charter §5)

M5 deferred a decision: an assignment picked a member scoring 0.00 while the specialist
scoring 0.738 was full. Four options were to be compared against concrete cases.

Three concrete cases exist, all from live runs:

| case | selected score | best busy score | outcome |
|---|---|---|---|
| `AF-2026-005` TASK-004 | 0.00 | 0.738 | completed; the code is correct and idiomatic |
| `AF-2026-006` TASK-003 | 0.20 | — | completed |
| `AF-2026-006` TASK-001 | fallback, no eligible member | — | completed, with tests |

In every observed case a low score did not predict a poor result, and the only quality
signal available — validation — passed in all three.

**Deferred, with the condition that unblocks it named.** A floor trades latency for
quality and there is no quality measurement to trade against: "completed" is not "good".
M6 produces the first per-assignment quality signal this product has ever had — review
findings — and §56 asks its dogfood to record selected score against outcome. The decision
belongs there, on that evidence, not here on an invented threshold.

---

## What this means for M6

Per the charter's own contingency (§55), the handoff, the reassignment and the payload
carry forward into the M6 dogfood rather than blocking the milestone.

That is the better vehicle, and §54 says why: **M6 is the first thing this product has
built that gives an agent a reason to speak.** A reviewer with a finding and an
implementer with an answer is a conversation that has to happen for the work to proceed —
unlike a handoff, which a good plan removes the need for, and unlike a blackboard entry,
which a well-specified task does not require.

If M6's live dogfood also produces no traffic, the conclusion about
`collaboration.enabled` writes itself.
