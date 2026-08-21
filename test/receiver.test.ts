import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { EventStore } from "../src/store.js";
import { startReceiver, eventKey } from "../src/receiver.js";
import { verifySignature, verifyTimestamp } from "../src/verify.js";

const SECRET = "test-signing-secret";

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(Buffer.from(body, "utf8")).digest("hex");
}

function payload(sessionId: string, action = "created", ts = Date.now()): string {
  return JSON.stringify({
    action,
    type: "AgentSessionEvent",
    webhookTimestamp: ts,
    agentSession: { id: sessionId, issue: { identifier: "ENG-1" } },
  });
}

describe("signature verification", () => {
  test("accepts a correct signature over the raw bytes", () => {
    const body = payload("s1");
    assert.equal(verifySignature(Buffer.from(body), sign(body), SECRET), true);
  });

  test("rejects a tampered body", () => {
    const body = payload("s1");
    const sig = sign(body);
    assert.equal(verifySignature(Buffer.from(body + " "), sig, SECRET), false);
  });

  test("rejects a missing header without throwing", () => {
    assert.equal(verifySignature(Buffer.from("{}"), undefined, SECRET), false);
  });

  test("rejects a signature of the wrong length without throwing", () => {
    // timingSafeEqual throws on length mismatch; the length pre-check must absorb it.
    assert.doesNotThrow(() => verifySignature(Buffer.from("{}"), "abc", SECRET));
    assert.equal(verifySignature(Buffer.from("{}"), "abc", SECRET), false);
  });

  test("re-stringified JSON does NOT verify — raw bytes are load-bearing", () => {
    // Note key ORDER is not the hazard: JSON.stringify(JSON.parse(x)) preserves
    // string-key insertion order, so a reordering example would pass by accident.
    // The real hazards are whitespace and number formatting — both survive a
    // parse and both change the bytes.
    const body = '{"a": 1.0, "b": "\\u00e9"}';
    const sig = sign(body);
    const restringified = JSON.stringify(JSON.parse(body));

    assert.equal(restringified, '{"a":1,"b":"é"}');
    assert.notEqual(restringified, body);
    assert.equal(verifySignature(Buffer.from(restringified), sig, SECRET), false);
    // ...while the untouched raw bytes verify fine.
    assert.equal(verifySignature(Buffer.from(body), sig, SECRET), true);
  });
});

describe("replay guard", () => {
  const now = 1_700_000_000_000;

  test("accepts a timestamp inside the window", () => {
    assert.equal(verifyTimestamp(now - 30_000, now), true);
  });

  test("rejects a stale timestamp", () => {
    assert.equal(verifyTimestamp(now - 120_000, now), false);
  });

  test("rejects a FUTURE timestamp — the check is two-sided", () => {
    assert.equal(verifyTimestamp(now + 120_000, now), false);
  });

  test("rejects a missing or non-numeric timestamp", () => {
    assert.equal(verifyTimestamp(undefined, now), false);
    assert.equal(verifyTimestamp(NaN, now), false);
  });
});

describe("event identity", () => {
  test("the same logical event yields the same key", () => {
    const ts = Date.now();
    assert.equal(eventKey(JSON.parse(payload("s1", "created", ts))),
                 eventKey(JSON.parse(payload("s1", "created", ts))));
  });

  test("different sessions do not collide", () => {
    const ts = Date.now();
    assert.notEqual(eventKey(JSON.parse(payload("s1", "created", ts))),
                    eventKey(JSON.parse(payload("s2", "created", ts))));
  });

  test("created and prompted on one session do not collide", () => {
    const ts = Date.now();
    assert.notEqual(eventKey(JSON.parse(payload("s1", "created", ts))),
                    eventKey(JSON.parse(payload("s1", "prompted", ts))));
  });
});

describe("receiver over real HTTP", () => {
  let dir: string;
  let store: EventStore;
  let server: ReturnType<typeof startReceiver>;
  let url: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "lacp-"));
    store = new EventStore(join(dir, "events.db"));
    server = startReceiver({ secret: SECRET, store, port: 0 });
    const addr = server.address() as AddressInfo;
    url = `http://127.0.0.1:${addr.port}/webhook`;
  });

  after(() => {
    server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function post(body: string, sig = sign(body)) {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "linear-signature": sig },
      body,
    });
  }

  test("accepts a signed delivery and queues it", async () => {
    const res = await post(payload("http-1"));
    assert.equal(res.status, 200);
    assert.equal(store.count("queued"), 1);
  });

  test("rejects an unsigned delivery with 401 and queues nothing", async () => {
    const before = store.count();
    const res = await post(payload("http-2"), "deadbeef");
    assert.equal(res.status, 401);
    assert.equal(store.count(), before);
  });

  test("duplicate delivery answers 200 but dispatches once", async () => {
    const body = payload("http-dupe");
    const before = store.count();
    const first = await post(body);
    const second = await post(body);

    assert.equal(first.status, 200);
    // A duplicate is a SUCCESSFUL delivery from Linear's side. Anything but 200
    // earns three more retries at 1m / 1h / 6h.
    assert.equal(second.status, 200);
    assert.equal(store.count(), before + 1, "exactly one row for two deliveries");
  });

  test("p99 of the handler stays far inside Linear's 5s budget", async () => {
    const N = 200;
    const timings: number[] = [];
    for (let i = 0; i < N; i++) {
      const body = payload(`perf-${i}`);
      const t0 = performance.now();
      const res = await post(body);
      timings.push(performance.now() - t0);
      assert.equal(res.status, 200);
    }
    timings.sort((a, b) => a - b);
    const p99 = timings[Math.floor(N * 0.99)]!;
    assert.ok(p99 < 5_000, `p99 ${p99.toFixed(1)}ms must be < 5000ms`);
    // Report it so the number is visible, not just asserted.
    console.log(`      p99=${p99.toFixed(1)}ms  median=${timings[N >> 1]!.toFixed(1)}ms`);
  });
});

describe("durability — the case in-memory dedupe silently fails", () => {
  let dir: string;

  before(() => { dir = mkdtempSync(join(tmpdir(), "lacp-dur-")); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test("dedupe survives a process restart, because retries arrive up to 6h later", () => {
    const path = join(dir, "events.db");
    const key = "sess-9:created:1700000000000";

    const first = new EventStore(path);
    assert.equal(first.claim(key, "{}").claimed, true);
    first.close();

    // Linear's retry schedule is 1 minute, 1 hour, 6 hours. A deploy happens in
    // between. An in-process Set or LRU passes every fast test and then dispatches
    // a second agent at the same work package after the restart.
    const afterRestart = new EventStore(path);
    const second = afterRestart.claim(key, "{}");
    assert.equal(second.claimed, false, "redelivery after restart must not re-dispatch");
    assert.equal(afterRestart.count(), 1);
    afterRestart.close();
  });

  test("a consumer killed mid-run recovers instead of stranding the session", () => {
    const store = new EventStore(join(dir, "recover.db"));
    store.claim("sess-10:created:1700000000001", "{}", 1000);

    const taken = store.nextQueued();
    assert.ok(taken);
    assert.equal(store.count("running"), 1);

    // Process dies here. Nothing settles the row.
    const requeued = store.requeueStale(60_000, 1000 + 120_000);
    assert.equal(requeued, 1);
    assert.equal(store.count("queued"), 1, "stale running work returns to the queue");
    store.close();
  });
});
