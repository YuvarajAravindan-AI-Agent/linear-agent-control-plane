import { EventStore } from "./store.js";
import { TokenStore } from "./tokens.js";
import { startApp } from "./app.js";

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
const clientId = required("LINEAR_CLIENT_ID");
const baseUrl = required("PUBLIC_BASE_URL").replace(/\/$/, "");

// Deliberately NOT required: without it only installation is unavailable, and
// taking webhook ingress down over a feature nobody is currently using would be
// the worse failure. /oauth/* answers 503 with the reason instead.
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
  oauth: {
    clientId,
    clientSecret,
    redirectUri: `${baseUrl}/oauth/callback`,
  },
});

console.log(`listening on :${port}  mode=${mode}  db=${dbPath}`);
if (!clientSecret) {
  console.warn("LINEAR_CLIENT_SECRET not set — webhook ingress is live, installation is not");
} else {
  console.log(
    tokens.getToken()
      ? "app is installed"
      : `not installed yet — visit ${baseUrl}/oauth/authorize`,
  );
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`${sig} received, closing`);
    server.close(() => { events.close(); tokens.close(); process.exit(0); });
  });
}
