import { EventStore } from "./store.js";
import { startReceiver } from "./receiver.js";

/**
 * Service entrypoint: the webhook ingress only.
 *
 * The orchestrator is driven by the queue consumer, not by the HTTP process, for
 * the reason the whole design turns on — Linear gives this handler 5 seconds and a
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

const secret = required("LINEAR_WEBHOOK_SECRET");
const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? "./data/events.db";
const mode = process.env.MODE ?? "replay";

const store = new EventStore(dbPath);

// A consumer killed mid-run leaves its event in `running` forever, and the Linear
// session ages into `stale` with no explanation. Recovery is a startup concern.
const requeued = store.requeueStale(15 * 60_000);
if (requeued > 0) console.log(`requeued ${requeued} stale event(s) from a previous run`);

const server = startReceiver({ secret, store, port });
console.log(`listening on :${port}  mode=${mode}  db=${dbPath}`);

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`${sig} received, closing`);
    server.close(() => { store.close(); process.exit(0); });
  });
}
