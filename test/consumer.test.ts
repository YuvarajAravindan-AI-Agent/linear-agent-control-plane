import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { EventStore } from "../src/store.js";
import { ReplayEmitter } from "../src/activity.js";
import { Consumer, FIRST_ACTIVITY_BUDGET_MS, type SessionEvent } from "../src/consumer.js";

function queued(store: EventStore, sessionId: string, action: "created" | "prompted" = "created") {
  store.claim(`${sessionId}:${action}:1`, JSON.stringify({
    action, agentSession: { id: sessionId }, promptContext: "Do the thing",
  }));
}

function rig(worker = async () => ({ body: "done", needsReview: true })) {
  const store = new EventStore(":memory:");
  const emitter = new ReplayEmitter();
  const consumer = new Consumer({ store, emitter, worker });
  return { store, emitter, consumer };
}

describe("consumer", () => {
  test("returns false on an empty queue rather than spinning", async () => {
    const { consumer } = rig();
    assert.equal(await consumer.step(), false);
  });

  test("emits a holding thought BEFORE the worker runs", async () => {
    const order: string[] = [];
    const store = new EventStore(":memory:");
    const emitter = new ReplayEmitter();
    const consumer = new Consumer({
      store, emitter,
      worker: async () => { order.push("worker"); return { body: "ok", needsReview: false }; },
    });

    // Record emission order by wrapping the emitter.
    const inner = emitter.emit.bind(emitter);
    emitter.emit = async (a) => { order.push(`emit:${a.type}`); return inner(a); };

    queued(store, "s1");
    await consumer.step();

    assert.deepEqual(order, ["emit:thought", "worker", "emit:response"],
      "the thought must precede the work, or the 10s budget is blown every time");
  });

  test("the first activity lands inside Linear's 10s budget even when work is slow", async () => {
    let clock = 0;
    const store = new EventStore(":memory:");
    const emitter = new ReplayEmitter(() => clock);
    const consumer = new Consumer({
      store, emitter, now: () => clock,
      // A realistic coding agent: minutes.
      worker: async () => { clock += 240_000; return { body: "ok", needsReview: true }; },
    });

    queued(store, "slow");
    const startedAt = clock;
    await consumer.step();

    const first = emitter.first("slow")!;
    assert.equal(first.type, "thought");
    assert.ok(consumer.withinBudget(startedAt, first.at),
      `first activity at +${first.at - startedAt}ms must be <= ${FIRST_ACTIVITY_BUDGET_MS}ms`);
  });

  test("the holding thought is ephemeral so it does not litter the transcript", async () => {
    const { store, emitter, consumer } = rig();
    queued(store, "s2");
    await consumer.step();
    assert.equal(emitter.first("s2")!.ephemeral, true);
  });

  test("work needing review emits elicitation, not response", async () => {
    const { store, emitter, consumer } = rig(async () => ({ body: "PR open", needsReview: true }));
    queued(store, "s3");
    await consumer.step();

    const types = emitter.forSession("s3").map((a) => a.type);
    assert.deepEqual(types, ["thought", "elicitation"],
      "elicitation drives awaitingInput — a response would mark it complete and skip the gate");
  });

  test("work not needing review completes the session", async () => {
    const { store, emitter, consumer } = rig(async () => ({ body: "trivial", needsReview: false }));
    queued(store, "s4");
    await consumer.step();
    assert.deepEqual(emitter.forSession("s4").map((a) => a.type), ["thought", "response"]);
  });

  test("a thrown worker emits an error activity and settles the row", async () => {
    const { store, emitter, consumer } = rig(async () => { throw new Error("compile failed"); });
    queued(store, "s5");
    await consumer.step();

    const last = emitter.forSession("s5").at(-1)!;
    assert.equal(last.type, "error");
    assert.match(last.body, /compile failed/);
    assert.equal(store.count("failed"), 1);
    assert.equal(store.count("running"), 0, "must not strand the row in running");
  });

  test("an unparseable payload settles instead of spinning forever", async () => {
    const store = new EventStore(":memory:");
    const emitter = new ReplayEmitter();
    const consumer = new Consumer({ store, emitter, worker: async () => ({ body: "", needsReview: false }) });

    store.claim("bad:created:1", "{not json");
    assert.equal(await consumer.step(), true);
    assert.equal(store.count("failed"), 1);
    assert.equal(await consumer.step(), false, "queue is drained, not re-serving the bad row");
  });

  test("an event with no session id fails rather than emitting to undefined", async () => {
    const store = new EventStore(":memory:");
    const emitter = new ReplayEmitter();
    const consumer = new Consumer({ store, emitter, worker: async () => ({ body: "", needsReview: false }) });

    store.claim("nosess:created:1", JSON.stringify({ action: "created" }));
    await consumer.step();
    assert.equal(emitter.emitted.length, 0, "nothing emitted");
    assert.equal(store.count("failed"), 1);
  });

  test("drain processes every queued event once", async () => {
    const { store, emitter, consumer } = rig();
    for (const id of ["a", "b", "c"]) queued(store, id);

    assert.equal(await consumer.drain(), 3);
    assert.equal(store.count("done"), 3);
    assert.equal(new Set(emitter.emitted.map((e) => e.sessionId)).size, 3);
    assert.equal(await consumer.drain(), 0, "nothing left");
  });

  test("a prompted follow-up is handled like any other event", async () => {
    const seen: SessionEvent[] = [];
    const store = new EventStore(":memory:");
    const emitter = new ReplayEmitter();
    const consumer = new Consumer({
      store, emitter,
      worker: async (e) => { seen.push(e); return { body: "ok", needsReview: false }; },
    });

    queued(store, "s6", "prompted");
    await consumer.step();
    assert.equal(seen[0]!.action, "prompted");
  });
});

describe("emitter failure must not strand the row", () => {
  test("a throwing holding-emit settles as failed instead of leaving it running", async () => {
    const store = new EventStore(":memory:");
    const emitter = {
      async emit() { throw new Error("401 from Linear"); },
    };
    const consumer = new Consumer({
      store, emitter,
      worker: async () => ({ body: "unreachable", needsReview: false }),
    });

    queued(store, "boom");
    await assert.rejects(() => consumer.step(), /401 from Linear/);

    assert.equal(store.count("running"), 0,
      "a stranded row is only freed by requeueStale — the session sits at Working... until then");
    assert.equal(store.count("failed"), 1);
  });
});
