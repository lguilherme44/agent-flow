# Device proof: show a native app reacting to a backend contract that is not deployed yet

e2e cannot reach a device, and the target environment does not send the new contract yet
(a new error, a new field). The proof is a local reverse proxy in front of the real
environment: it answers only the endpoints under test and forwards everything else.

## Set up

- Proxy (e.g. mitmproxy in reverse mode towards `https://<env-host>`, on a local port), one
  per host the app calls, outside the repository. The device reaches it via `adb reverse tcp:<port> tcp:<port>`
  (Android) or the simulator's localhost (iOS). Point the app's hosts at it through its
  environment file, never through a code change.
- The proxy addon answers the target endpoints WITHOUT forwarding them, so the environment
  never changes state. Read the exact method and path in the app code before touching any
  button that writes (close, pay): a path the addon misses is a real write.
- Modes from a file the addon reads on every request: the new contract, another error, and
  pass-through. All three are needed: the new behaviour, the old error handling unchanged,
  and nothing different when the contract is absent.
- The addon logs every non-GET with its full path, and every status (proxy logs truncate URLs).
- Login on an external identity provider is the human's. Never type their credentials.

## Prove

- Every place the plan says reacts to the contract, in every layout the app has (phone,
  tablet, wide). A width-locked layout is reached by changing the device density, not by
  rotating. Count calls in the log for double-tap guards.
- An error on the way: reproduce it through the path that existed before the change. Same
  error there means environment or old bug: record it, do not fix it in this run.
- A mock that gets past an old bug only to reach the screen under test is allowed, commented
  in the addon and named in the report. A chain of mocks proves nothing: stop and write
  "not verified on the device" with what covers it (tests).

## Record

- Screenshots with personal data masked (store, tax id, person names); a screen listing
  other customers is not published.
- Observation (what was done, seen, and not verified) and screenshots go to the run's
  evidence: `agent-flow review --e2e-observed-file <file> --observed-by "<name>"
  --evidence <png...>`. Observed-by is the human who saw it, or the operator they
  delegated to, named as such. With `roles.e2e.enabled: false` the review refuses the
  observation today: keep the file and screenshots under `runs/<id>/e2e/` and say so.
- Undo what the proof changed in the environment (pass-through mode, revert a setting it
  changed, reset the density) and restore files the build regenerated.

## Never

- Never forward a target endpoint in the contract mode, never point the app at production.
- Never report a place as verified because its unit test passed.
