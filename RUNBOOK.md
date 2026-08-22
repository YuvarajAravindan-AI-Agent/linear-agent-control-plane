# Runbook — Agent Control Plane

For the team that owns this after handover. Assumes no prior context.

---

## What it is

Linear is the control plane. A human delegates an issue to the app user; Linear opens an
**AgentSession** and posts an `AgentSessionEvent` to `/webhook`. The service verifies the
signature, queues the event durably, and a consumer emits activities back to the session.

An **epic** (issue with no parent) is decomposed into work packages, created as real
sub-issues with `blocks` relations. A **work package** (issue with a parent) is worked
directly. Neither dispatches anything until a human approves at the gate.

## The two numbers everything is built around

| Budget | Value | Consequence of missing it |
|---|---|---|
| Webhook handler must return | **5 s** | Linear retries at 1 m / 1 h / 6 h, then disables the webhook |
| `created` session must show an activity | **10 s** | Session is marked unresponsive |

A coding agent takes minutes. **This is why the handler only acks and queues, and why the
consumer emits a holding `thought` before calling the worker.** If you change one thing in
this codebase, do not change that ordering.

## Daily checks

- **`/status`** — founder-readable. Counts, recent sessions, whether a model is in the loop.
- **`/healthz`** — `{"ok":true,"installed":true}`. `installed:false` means the OAuth token is
  gone and nothing will work.
- **Linear → Settings → API → Applications → Agent Control Plane → Webhook delivery failures.**
  Empty is correct. Entries here mean Linear gave up after all retries.

## Common situations

**Session stuck at "Working…"**
Nothing emitted an activity. Check `docker compose logs` for `consumer error`. The row is
settled `failed` — it will not retry on its own. Re-assign the issue to create a fresh session.

**Everything 401s**
The signing secret in `.env` no longer matches Linear. Compare shapes: the signing secret is
**51 chars starting `lin_wh_`**; the client id/secret are **32 hex**. They are easy to paste
into the wrong line and nothing warns you.

**`installed:false` after it was working**
Access tokens last **24 hours**. There is a refresh token stored but **automatic refresh is
not implemented** — see Known gaps. Re-run `/oauth/authorize`.

**Events arrive but nothing happens**
Check the token exists (`/healthz`) — the poll loop skips entirely when there is none.

**Duplicate work**
Should be impossible: dedupe is keyed on `session:action:timestamp` and stored in SQLite, so
it survives restarts. If you see it, check that `data/` is a persistent volume and not being
recreated.

## Operations

```bash
cd /opt/linear-agents/repo

docker compose logs -f                 # follow
docker compose up -d --force-recreate  # after ANY .env change
docker compose restart                 # code only — does NOT re-read .env
```

**`docker compose restart` does not re-read `env_file`.** Env is baked at container creation.
This has bitten twice; use `up -d --force-recreate`.

The `data/` directory must be owned by uid 1000 — the image runs as `node`, and the bind
mount shadows the Dockerfile's `chown`. Symptom is a bare `unable to open database file`
that says nothing about permissions.

## Deploying

Source lives at `/opt/linear-agents/repo`, secrets at `/opt/linear-agents/.env` (chmod 600,
symlinked into the repo). The repo is private, so the box cannot `git clone` it — it is
rsynced from the laptop. **A deploy key is the proper fix and has not been done.**

## Known gaps — read before promising anything

- **Token refresh is not implemented.** A refresh token is stored and `isExpired()` exists,
  but nothing calls it. After 24 hours you must re-authorize by hand. This is the first
  thing to fix.
- **`live` mode does not exist.** `MODE=live` is read and reported but there is no model in
  the loop; the worker is always the replay one. Decomposition is a *parser*, not a planner.
- **The orchestrator is not wired to Linear state.** `graph.ts`, `gate.ts` and
  `orchestrator.ts` are tested and correct, but dispatch/merge is driven by tests, not by
  real issue transitions. Approving a gate in Linear does not currently unblock dependents.
- **Notifications route by role in code only.** No Slack, email or Linear notification
  configuration is wired.
- **SLA escalation is not scheduled.** `ReviewGate.sweep()` is correct and tested but nothing
  calls it on a timer in the running service.

## Security notes

- Caddy exposes only `/webhook`, `/oauth/*`, `/healthz`, `/status`. Everything else 404s
  before reaching Node — scanners probing `/.env` are visible in the Caddy log and get nothing.
- Signature verification runs on **raw bytes** before any parse. Never verify re-stringified
  JSON: whitespace and number formatting survive a round trip and break the HMAC.
- The replay guard is two-sided — a timestamp far in the future is as suspect as a stale one.
- OAuth state is single-use, 10-minute TTL, and stored on disk so a callback can outlive a
  restart.
