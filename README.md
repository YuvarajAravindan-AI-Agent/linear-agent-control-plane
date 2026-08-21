# linear-agent-control-plane

Linear as the control plane for parallel AI coding agents — a reference implementation.

**Status: early.** The webhook ingress layer is built and tested. The orchestrator,
dependency graph, human review gate and dashboards are not written yet. See
[Roadmap](#roadmap).

This is a reference implementation, not delivered client work.

---

## The constraint this is built around

Linear's agent API gives you two budgets:

| Requirement | Budget |
|---|---|
| Webhook receiver must return | **5 seconds** |
| `created` session must see a `thought` activity | **10 seconds** |
| Retry schedule on failure | 1 min, 1 hour, 6 hours (3 attempts, then the webhook may be disabled) |

A coding agent takes minutes. **So the work cannot happen in the webhook handler** — and
that isn't an implementation detail, it's the architecture. It forces four things:

1. **Ack-then-queue.** [`src/receiver.ts`](src/receiver.ts) reads the raw body, verifies,
   claims, responds. It never awaits a model call or a Linear mutation.
2. **A holding activity** emitted from the consumer inside the 10s window, before any
   model call.
3. **Idempotency on delivery**, because retries are real and a double delivery must not
   dispatch two agents at one work package.
4. **Durable state** under concurrent writes from N agents.

## Two findings worth the reading time

**Durable dedupe is not optional, and the retry schedule is why.** Retries land at 1
minute, 1 hour and **6 hours**. An in-process `Set` or LRU passes every fast-redelivery
test, then dispatches a second agent at the same work package six hours later — after a
deploy has cycled the process. There is a test for exactly this in
[`test/receiver.test.ts`](test/receiver.test.ts) that fails against an in-memory dedupe
and passes against the SQLite one.

**Verify the raw bytes, never re-stringified JSON.** The hazard is *not* key ordering —
`JSON.stringify(JSON.parse(x))` preserves string-key insertion order, so a key-order
example passes by accident and teaches the wrong lesson. The real hazards are whitespace
and number formatting: `{"a": 1.0}` round-trips to `{"a":1}` and the signature breaks.

## What is actually verified

`npm test` — 18 tests, no network, no API keys, no Anthropic calls.

```
p99=13.1ms  median=4.4ms      # handler latency vs Linear's 5000ms budget
tests 18 | pass 18 | fail 0
```

Covered: signature verification over raw bytes (including the length-mismatch case that
makes `timingSafeEqual` throw), two-sided replay guard, event identity, duplicate delivery
answering 200 while dispatching once, handler p99 under load, dedupe surviving a process
restart, and a consumer killed mid-run recovering instead of stranding the session.

## Running it

Requires **Node ≥ 22.5** for `node:sqlite`.

```bash
npm install
npm test
```

`node:sqlite` needs `--experimental-sqlite` on Node 22 (already in the npm scripts); the
flag is unnecessary from Node 24. `better-sqlite3` was tried first and **segfaults on
Node 22.9**, including when rebuilt from source — hence the built-in.

## Deploying

```bash
cp .env.example .env          # fill LINEAR_WEBHOOK_SECRET from the Linear app page
mkdir -p data && chown -R 1000:1000 data
docker compose up -d
```

The `chown` is not optional. The image runs as `node` (uid 1000), and the bind mount
shadows the Dockerfile's `chown`, so the **host** directory's ownership decides. Get it
wrong and `node:sqlite` reports a bare `unable to open database file` with nothing about
permissions in it.

Put a reverse proxy in front that exposes **only** `/webhook` — see
[`infra/caddy/linear-agents.caddy`](infra/caddy/linear-agents.caddy). Its
`response_header_timeout` is 4s, deliberately inside Linear's 5s budget: fail fast and let
Linear retry on its own schedule rather than holding the connection open.

Verified live: unsigned `POST /webhook` → 401, correctly signed → 200 in ~21ms, and a
duplicate delivery → 200 with exactly one row in the database.

## Roadmap

- [x] Ack-then-queue receiver, signature + replay verification, durable dedupe, recovery
- [ ] Linear workspace: teams/projects/issue structure for work packages + dependencies
- [ ] Agent app-user install (`actor=app`), OAuth, activity emission
- [ ] Orchestrator: epic → dependency-ordered work packages → parallel dispatch
- [ ] Human "understanding review" gate (`elicitation` → `awaitingInput`) with SLA + escalation
- [ ] Notification architecture for several named humans in different roles
- [ ] Founder-readable progress views
- [ ] `replay` / `live` modes and the runbook

**`replay` will be the default mode**: the whole control plane runs off recorded fixtures
with zero token spend. `live` uses cheap workers behind concurrency and spend caps. Most
of a control plane — dispatch, dependency ordering, the gate, escalation — needs no LLM at
all, which is the more interesting claim anyway.

## What this does not prove

It does not prove operating this against a large production codebase with a real
engineering team. It proves the control plane, the dispatch semantics and the failure
handling.

## Open question

Whether **agent app-user installation** works on Linear's free plan is unverified. Free
gives API + webhooks + 2 teams + 250 issues, and agents are documented as non-billable —
but "not billable" is not the same claim as "installable on free". Creating an OAuth app
requires workspace admin, which you have on your own workspace. This gets settled before
anything is built on top of it.
