# AF-L02 — Config writes, by design

**Status: design only. Nothing in this document is implemented.**

`PATCH /api/v1/config` appears in §86 and does not exist. This is why, and what
would have to be true for it to.

## The problem with the endpoint as specified

The Settings page reads *effective* configuration: built-in defaults, overlaid
with the global file, overlaid with the project's own. `retry.maxAttempts: 5` on
screen could have come from any of the three. A `PATCH /config` that accepted
`{ "retry": { "maxAttempts": 6 } }` would have to guess which file to write, and
both guesses are wrong in a way the user cannot see:

- Writing to the **global** file changes every project on the machine. Somebody
  raising the attempt limit for one repository would silently raise it for eight.
- Writing to the **project** file creates an override where none existed. The next
  change to the global file then has no effect on this project, and nobody
  remembers why.

A settings page whose save button did either of those is worse than no save
button, because the damage is invisible at the moment it is done.

## The contract

Scope is part of the address, not part of the body. Two endpoints, and no way to
call either one without having said which layer you meant:

```text
PATCH /api/v1/config/global
PATCH /api/v1/projects/:projectId/config
```

The second reuses the id the registry already issues, so it inherits the property
every other endpoint has: the browser names a project, the server resolves the
path. No request carries a location.

A single endpoint with a `scope` field would be equivalent and is the fallback if
routing turns out to matter more than symmetry. What is not acceptable is a body
whose scope is optional, because an optional scope has a default and a default is a
guess.

### Request

```json
{ "set": { "retry.maxAttempts": 6 }, "unset": ["parallelism.maxTasks"] }
```

Dotted paths, and `unset` is a first-class operation rather than "set it to the
default value". They are different acts with different futures: an unset key
follows the layer beneath it forever, and a key set to today's default stops
following it. The Settings page already distinguishes the two — every row says
whether the value came from a file or from the built-in default — so the API has to
as well, or the page could not express what it displays.

### Response

The same shape `GET /config` returns, recomputed. Not the request echoed back:
after a write, what matters is the *effective* configuration and the new origin of
each value, and those are the server's to compute. A client that assumed its
requested value was now in force would be wrong the first time a project override
sat above it.

## Validation

Before anything is written, in this order:

1. **Every path must exist in the schema.** `GlobalConfigSchema` and
   `ProjectConfigSchema` are the authority; an unknown path is a 400 naming the
   path, never a key silently added to a YAML file where nothing reads it.
2. **The layer must be allowed to hold the key.** `OVERRIDABLE_KEYS` already
   states which global keys a project may override, and it is exported for exactly
   this reason. A project trying to set something outside that list is refused with
   the list — writing it would produce a file whose contents have no effect, which
   is the worst kind of successful save.
3. **The merged result must parse.** Apply the change to an in-memory copy of the
   layer, re-run the full three-layer merge, and validate the result. A value that
   is individually well-typed can still produce an invalid configuration — a role
   pointing at a runner that the same patch disabled, for instance. The check is on
   the outcome, not on the field.
4. **The result must resolve.** Run `describeRoleRoutes` against the merged config
   and refuse if a role that resolved before now cannot. The Agents page exists to
   show that state; a write should not be able to create it silently.

Validation failures return the structured error shape the write API already uses —
code, message, action — with the offending path in `detail`.

## Merge semantics

The patch applies to **one layer**, never to the merged view. `set` writes into the
addressed file at the dotted path, creating intermediate mappings as needed; `unset`
removes the key and any mapping it leaves empty. The other two layers are not
touched and are not consulted except to validate the outcome.

This is the part that makes the whole thing safe: the file on disk after the write
differs from the file before it only at the paths named. Nothing is normalised,
nothing is defaulted-in, nothing is expanded.

## Preserving the rest of the file

A config file is written by a person. It has comments explaining why
`parallelism.maxTasks` is 1, key ordering that groups related settings, and
possibly anchors. `parse → mutate → stringify` with the `yaml` package's default
options destroys all of it, and a settings page that silently strips a colleague's
comments is a settings page nobody will use twice.

So writes go through the `yaml` package's **document API** — `parseDocument`,
`setIn`, `deleteIn`, `toString` — which preserves comments, ordering and formatting
for every node it does not touch. Two things follow:

- A round-trip with an empty patch must produce a byte-identical file. That is the
  test to write first, against every file in the repository's fixtures.
- A file that will not parse is not modified. The endpoint refuses with the parse
  error and the path, exactly as `GET /config` already does.

## Atomic write

`writeFileAtomic` — temp file in the same directory, then rename. The guarantee it
already provides for `state.json` is the one config needs: a crash mid-write leaves
the previous configuration intact rather than a truncated file that stops the tool
from starting at all.

Concurrency is a separate question from AF-L01's run lock and should not reuse it: a
run lock is per run, and config is per project and per machine. Two simultaneous
config writes are a real possibility (two browser tabs) and the correct treatment is
read-modify-write under an exclusive claim on the file being edited, using the same
`createExclusive` primitive. Left unspecified here beyond that, because it needs its
own design and this document is about the shape of the API.

## Secrets

Nothing changes: the config schema has no field for a credential and this endpoint
must not become the reason to add one. Specifically —

- No path is accepted from a client, for any key. `runners.<id>.command` is an
  executable path and is therefore **not writable through this API**, in either
  layer. Reading it is showing a person their own file; accepting one is letting a
  browser choose what this machine executes.
- The response is the same `ConfigView` the read endpoint produces, which already
  reports values as rendered strings and has a test asserting that no auth file,
  environment variable or key-shaped string appears in it.
- No endpoint reads or writes anything outside the two config files.

## What would be built, in order

1. Round-trip preservation, proved on real files, with an empty patch.
2. Path validation against the schemas, plus the `OVERRIDABLE_KEYS` check.
3. Outcome validation: merge, parse, resolve roles.
4. The two endpoints, atomic write, recomputed response.
5. The Settings page's controls, which are the easy part and should be last.
