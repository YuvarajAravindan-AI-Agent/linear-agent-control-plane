import { EventStore } from "./store.js";
import { TokenStore } from "./tokens.js";
import { startApp } from "./app.js";
import { LinearEmitter } from "./activity.js";
import { Consumer } from "./consumer.js";
import { replayWorker } from "./worker.js";
import { LinearClient } from "./linear.js";

/**
 * Service entrypoint: webhook ingress plus the OAuth install endpoints.
 *
 * The orchestrator is driven by the queue consumer, not by this HTTP process, for
 * the reason the whole design turns on — Linear gives the handler 5 seconds and a
 * coding agent takes minutes.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env var ${name} (see .env.example)`);
    process.exit(1);
  }
  return v;
}

const webhookSecret = required("LINEAR_WEBHOOK_SECRET");
const baseUrl = required("PUBLIC_BASE_URL").replace(/\/$/, "");

// Neither OAuth credential is required. Without them only *installation* is
// unavailable; webhook ingress and /status keep serving and /oauth/* answers 503
// naming what is missing. Taking a working endpoint down over a feature nobody is
// currently using is the worse failure — and it is what makes a local run possible
// with no Linear app at all.
const clientId = process.env.LINEAR_CLIENT_ID ?? "";
const clientSecret = process.env.LINEAR_CLIENT_SECRET ?? "";

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? "./data/events.db";
const mode = process.env.MODE ?? "replay";

const events = new EventStore(dbPath);
const tokens = new TokenStore(dbPath);

// A consumer killed mid-run leaves its event in `running` forever, and the Linear
// session ages into `stale` with no explanation. Recovery is a startup concern.
const requeued = events.requeueStale(15 * 60_000);
if (requeued > 0) console.log(`requeued ${requeued} stale event(s) from a previous run`);
tokens.purgeExpiredStates();

const server = startApp({
  webhookSecret,
  events,
  tokens,
  port,
  mode,
  oauth: {
    clientId,
    clientSecret,
    redirectUri: `${baseUrl}/oauth/callback`,
  },
});

console.log(`listening on :${port}  mode=${mode}  db=${dbPath}`);
if (!clientId || !clientSecret) {
  console.warn("OAuth credentials not set — webhook ingress and /status are live, installation is not");
} else {
  console.log(
    tokens.getToken()
      ? "app is installed"
      : `not installed yet — visit ${baseUrl}/oauth/authorize`,
  );
}

/**
 * Queue consumer.
 *
 * The emitter is ALWAYS the real Linear one — emitting activities is free, and a
 * session that never hears back sits at "Working..." until it goes stale. `MODE`
 * selects the worker, not the emitter: `replay` spends nothing, `live` would call
 * a model. Keeping that split is what lets the whole control plane be demonstrated
 * against real Linear at zero cost.
 */
const linear = new LinearClient(() => tokens.getToken()?.accessToken);

const consumer = new Consumer({
  store: events,
  emitter: new LinearEmitter(() => tokens.getToken()?.accessToken),
  worker: replayWorker(linear),
});

const POLL_MS = 2_000;
let draining = false;

const poll = setInterval(() => {
  // Never let two drains overlap — a slow worker would otherwise stack timers.
  if (draining || !tokens.getToken()) return;
  draining = true;
  consumer
    .drain()
    .then((n) => { if (n) console.log(`processed ${n} event(s)`); })
    // A failed emit must not take the process down; the row is already settled.
    .catch((err) => console.error("consumer error:", err instanceof Error ? err.message : err))
    .finally(() => { draining = false; });
}, POLL_MS);

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`${sig} received, closing`);
    clearInterval(poll);
    server.close(() => { events.close(); tokens.close(); process.exit(0); });
  });
}
