# linear-agent-control-plane

Linear as the control plane for parallel AI coding agents — a reference implementation.

**Running live against a real Linear workspace.** Delegate an issue to the app user and it
decomposes into dependency-ordered sub-issues and stops at a human review gate. **No model
is called and nothing is spent.**

Apache-2.0 licensed. This is a reference implementation, not delivered client work. See
[What this does not prove](#what-this-does-not-prove).

---

## The constraint the whole thing is built around

| Requirement | Budget |
|---|---|
| Webhook receiver must return | **5 seconds** |
| A `created` session must show an activity | **10 seconds** |
| Retry schedule on failure | 1 min, 1 hour, 6 hours — then the webhook may be disabled |

A coding agent takes minutes. **So the work cannot happen in the webhook handler**, and
that isn't an implementation detail — it's the architecture. It forces four things:

1. **Ack-then-queue.** [`src/receiver.ts`](src/receiver.ts) reads the raw body, verifies,
   claims, responds. It never awaits a model call or a Linear mutation.
2. **A holding activity emitted before the work**, not after — see
   [`src/consumer.ts`](src/consumer.ts). There is a test that runs a 240-second worker and
   asserts the first activity still landed inside 10s.
3. **Idempotency on delivery**, because retries are real.
4. **Durable state** under concurrent writes.

## Four findings worth the reading time

**Durable dedupe is not optional, and the retry schedule is why.** Retries land at 1 minute,
1 hour and **6 hours**. An in-process `Set` passes every fast-redelivery test, then
dispatches a second agent at the same work package six hours later, after a deploy has
cycled the process. There is a test that fails against in-memory dedupe and passes against
SQLite.

**Verify raw bytes, never re-stringified JSON.** The hazard is *not* key ordering —
`JSON.stringify(JSON.parse(x))` preserves string-key insertion order, so a key-order example
passes by accident and teaches the wrong lesson. The real hazards are whitespace and number
formatting: `{"a": 1.0}` round-trips to `{"a":1}` and the HMAC breaks.

**`elicitation` vs `response` is load-bearing.** An `elicitation` drives the session to
`awaitingInput` — that *is* the human review gate. Emitting `response` instead marks the
session complete and silently skips review.

**Most of a control plane needs no model at all.** Dependency ordering, dispatch, the gate,
escalation and the status page are ordinary distributed-systems code. That is why `MODE`
selects the *worker*, not the emitter, and why the default mode is free.

## What is actually verified

`npm test` — **135 tests, no network, no API keys, no model calls.**

```
p99=13.1ms  median=4.4ms      # handler latency vs Linear's 5000ms budget
tests 135 | pass 135 | fail 0
```

Verified live against a real workspace: unsigned `POST /webhook` → 401, correctly signed →
200 in ~21 ms, duplicate delivery → 200 with exactly one row, and an epic delegated to the
app user decomposed into four sub-issues with the `blocks` relations forming a diamond.

## How to use it

Put a `## Work packages` block in an epic's description:

```markdown
## Work packages
- [A] Payment provider adapter
- [B] Cart totals service (depends: A)
- [C] Fraud checks (depends: A)
- [D] Checkout UI (depends: B, C)
```

Delegate the issue to the app user. It creates each package as a real sub-issue, mirrors the
edges as Linear `blocks` relations, and opens the review gate on the plan. **Nothing is
dispatched until a human approves.**

The graph is validated *before* anything is written — a cycle or an unknown dependency id
fails as a parse error, not as four orphaned sub-issues someone cleans up by hand.

In replay mode the decomposition is a **parser, not a planner**. That is deliberate: it is
the one part that genuinely needs a model, so replay mode reads a spec you wrote rather than
inventing one.

**Closing the loop:** assign a ready sub-issue to the app user and it dispatches the real
package and opens a review. Reply to that review — anything not read as a rejection counts as
approval — and it merges, and a comment lands on the *epic* naming whatever just became
dispatchable. The graph this runs against is [persisted](src/graphstore.ts), keyed by the
epic's identifier, so it survives past the request that decomposed it; that used to be exactly
what was missing.

## Endpoints

| Path | Purpose |
|---|---|
| `POST /webhook` | Linear `AgentSessionEvent` ingress |
| `GET /oauth/authorize` · `/oauth/callback` | one-time install as an app user |
| `GET /status` | founder-readable progress — no JS, no build step |
| `GET /healthz` | `{"ok":true,"installed":true}` |

## Running it

Requires **Node ≥ 22.5** for `node:sqlite`.

```bash
npm install
npm test
```

`node:sqlite` needs `--experimental-sqlite` on Node 22 (already in the npm scripts); it is
unflagged from Node 24. `better-sqlite3` was tried first and **segfaults on Node 22.9**,
including rebuilt from source — hence the built-in.

## Deploying

```bash
cp .env.example .env          # fill from the Linear app page
mkdir -p data && chown -R 1000:1000 data
docker compose up -d
```

The `chown` is not optional. The image runs as `node` (uid 1000) and the bind mount shadows
the Dockerfile's `chown`, so the **host** directory decides. Get it wrong and `node:sqlite`
reports a bare `unable to open database file` with nothing about permissions in it.

Front it with a reverse proxy that exposes only the four paths above — see
[`infra/caddy/linear-agents.caddy`](infra/caddy/linear-agents.caddy). The 4s
`response_header_timeout` applies to `/webhook` only: fail fast inside Linear's budget and
let it retry, rather than holding the connection open.

Operational detail, gotchas and a candid **Known gaps** list: [RUNBOOK.md](RUNBOOK.md).
Architecture, HLD/LLD with diagrams and alternatives considered: [docs/DESIGN.md](docs/DESIGN.md).

## Roadmap

- [x] Ack-then-queue receiver, signature + replay verification, durable dedupe, recovery
- [x] OAuth install as an app user (`actor=app`), single-use durable state, token storage
- [x] Agent session consumer: holding activity inside the 10s budget, then the work
- [x] Epic → dependency-ordered work packages as real sub-issues with `blocks` relations
- [x] Human "understanding review" gate (`elicitation` → `awaitingInput`) on stock Linear
- [x] Founder-readable progress at `/status`
- [x] Runbook
- [x] OAuth token refresh — renewed automatically inside the 60s expiry skew, with backoff
- [x] Orchestrator wired to real Linear transitions — assigning a package dispatches it,
  approving a review merges it and unblocks dependents, against a graph that survives past
  the request that built it
- [ ] `live` mode — a model in the loop

## What this does not prove

It does not prove operating this against a large production codebase with a real engineering
team. It proves the control plane, the dispatch semantics, the review gate and the failure
handling.

Assigning a ready sub-issue now dispatches the real, persisted work package, and approving
its review really does merge it and unblock dependents — see [`src/graphstore.ts`](src/graphstore.ts)
and [`src/worker.ts`](src/worker.ts). What replay mode still does not do is call a model or
open a real PR: dispatch always "succeeds" and goes straight to review, because there is
nothing that can fail yet. That is Gap 3 (`live` mode), not this one.

## Answered along the way

**Agent app-users work on Linear's free plan.** Verified in the real UI, not inferred from
docs: OAuth applications, webhooks and the `Agent session events` category are all available
with no paywall, and `actor=app` installs the app as an assignable, mentionable user.
