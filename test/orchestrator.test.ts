import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { DependencyGraph, CycleError, UnknownDependencyError } from "../src/graph.js";
import { ReviewGate } from "../src/gate.js";
import { Orchestrator, ReplayRunner } from "../src/orchestrator.js";
import type { WorkPackage } from "../src/types.js";

/** A -> B -> D, A -> C -> D. D must wait for both branches. */
const diamond: WorkPackage[] = [
  { id: "A", title: "schema", dependsOn: [] },
  { id: "B", title: "api", dependsOn: ["A"] },
  { id: "C", title: "worker", dependsOn: ["A"] },
  { id: "D", title: "ui", dependsOn: ["B", "C"] },
];

const humans = [
  { id: "rev1", role: "reviewer" as const },
  { id: "rev2", role: "reviewer" as const },
  { id: "lead", role: "lead" as const },
  { id: "founder", role: "founder" as const },
];

function rig(packages = diamond, fixtures = {}) {
  const graph = new DependencyGraph(packages);
  const gate = new ReviewGate(graph, { slaMs: 60_000, humans });
  const orch = new Orchestrator(graph, gate, new ReplayRunner(fixtures), {
    maxConcurrent: 10,
    maxTurnsPerPackage: 20,
    spendCeilingUsd: 5,
  });
  return { graph, gate, orch };
}

describe("dependency graph", () => {
  test("only root packages are ready initially", () => {
    const { graph } = rig();
    assert.deepEqual(graph.ready().map((r) => r.pkg.id), ["A"]);
  });

  test("a package is not dispatched until every dependency has merged", () => {
    const { graph, gate } = rig();
    graph.dispatch("A"); gate.open("A"); gate.approve("A");

    assert.deepEqual(graph.ready().map((r) => r.pkg.id).sort(), ["B", "C"]);
    assert.equal(graph.get("D").state, "blocked", "D waits for both B and C");

    graph.dispatch("B"); gate.open("B"); gate.approve("B");
    assert.equal(graph.get("D").state, "blocked", "one of two merged is not enough");

    graph.dispatch("C"); gate.open("C"); gate.approve("C");
    assert.equal(graph.get("D").state, "ready");
  });

  test("a failed package leaves its dependents blocked forever", () => {
    const { graph } = rig();
    graph.dispatch("A");
    graph.fail("A");
    assert.equal(graph.get("B").state, "blocked");
    assert.equal(graph.ready().length, 0);
    assert.ok(graph.isQuiescent(), "no further progress is possible");
  });

  test("rejects a dependency cycle at construction", () => {
    assert.throws(
      () => new DependencyGraph([
        { id: "X", title: "x", dependsOn: ["Z"] },
        { id: "Y", title: "y", dependsOn: ["X"] },
        { id: "Z", title: "z", dependsOn: ["Y"] },
      ]),
      CycleError,
    );
  });

  test("rejects a dependency on an unknown package", () => {
    assert.throws(
      () => new DependencyGraph([{ id: "X", title: "x", dependsOn: ["nope"] }]),
      UnknownDependencyError,
    );
  });

  test("a deep chain does not blow the stack", () => {
    const chain: WorkPackage[] = Array.from({ length: 5000 }, (_, i) => ({
      id: `p${i}`, title: `p${i}`, dependsOn: i === 0 ? [] : [`p${i - 1}`],
    }));
    assert.doesNotThrow(() => new DependencyGraph(chain));
  });

  test("illegal transitions are refused rather than silently ignored", () => {
    const { graph } = rig();
    assert.throws(() => graph.merge("A"), /cannot merge/);
    assert.throws(() => graph.dispatch("B"), /cannot dispatch/);
  });
});

describe("dispatch", () => {
  test("one package is never dispatched twice", () => {
    const { graph, orch } = rig();
    const first = orch.tick();
    const second = orch.tick();   // a second poller racing the first
    assert.equal(first.length, 1);
    assert.equal(second.length, 0, "the claim happens before any await");
    assert.equal(graph.get("A").state, "dispatched");
  });

  test("concurrency cap is honoured", async () => {
    const wide: WorkPackage[] = Array.from({ length: 8 }, (_, i) => ({
      id: `w${i}`, title: `w${i}`, dependsOn: [],
    }));
    const graph = new DependencyGraph(wide);
    const gate = new ReviewGate(graph, { slaMs: 1000, humans });
    const orch = new Orchestrator(graph, gate, new ReplayRunner({}), {
      maxConcurrent: 3, maxTurnsPerPackage: 20, spendCeilingUsd: 5,
    });

    const started = orch.tick();
    assert.equal(started.length, 3, "never more than maxConcurrent at once");
    await Promise.allSettled(started);
  });

  test("completed work opens a gate — it does not merge itself", async () => {
    const { graph, orch } = rig();
    await Promise.allSettled(orch.tick());
    assert.equal(graph.get("A").state, "awaitingGate");
    assert.equal(graph.get("B").state, "blocked", "nothing unblocks without review");
  });

  test("exceeding the per-package turn cap fails the package", async () => {
    const { graph, orch } = rig(diamond, { A: { outcome: "completed", turns: 999 } });
    await Promise.allSettled(orch.tick());
    assert.equal(graph.get("A").state, "failed");
  });

  test("the whole diamond drains in dependency order", async () => {
    const { graph, orch } = rig();
    await orch.drain(() => true);
    for (const id of ["A", "B", "C", "D"]) {
      assert.equal(graph.get(id).state, "merged", `${id} merged`);
    }
  });

  test("replay mode spends nothing", async () => {
    const { orch } = rig();
    await orch.drain(() => true);
    assert.equal(orch.spent, 0, "no tokens, no network, no cost");
  });

  test("spend ceiling halts dispatch", async () => {
    const wide: WorkPackage[] = Array.from({ length: 6 }, (_, i) => ({
      id: `w${i}`, title: `w${i}`, dependsOn: [],
    }));
    const graph = new DependencyGraph(wide);
    const gate = new ReviewGate(graph, { slaMs: 1000, humans });
    const costly = { async run(packageId: string) {
      return { packageId, outcome: "completed" as const, costUsd: 1.0, turns: 1 };
    } };
    const orch = new Orchestrator(graph, gate, costly, {
      maxConcurrent: 2, maxTurnsPerPackage: 20, spendCeilingUsd: 2,
    });

    await orch.drain(() => true);
    assert.ok(orch.isHalted, "halted at the ceiling");
    assert.ok(orch.spent >= 2, `spent ${orch.spent}`);
    assert.ok(graph.byState("blocked").length + graph.byState("ready").length > 0,
      "work remains undispatched rather than running past the ceiling");
  });
});

describe("review gate", () => {
  test("opening a gate notifies reviewers only, not the founder", () => {
    const { graph, gate } = rig();
    graph.dispatch("A");
    const sent = gate.open("A");

    assert.deepEqual(sent.map((n) => n.to).sort(), ["rev1", "rev2"]);
    assert.equal(gate.countFor("founder"), 0, "the founder is not paged per gate");
    assert.equal(gate.countFor("lead"), 0);
  });

  test("SLA breach escalates to lead and founder", () => {
    const { graph, gate } = rig();
    graph.dispatch("A", 0);
    gate.open("A", 0);

    assert.equal(gate.sweep(30_000).length, 0, "inside the SLA, nothing fires");

    const escalated = gate.sweep(61_000);
    assert.deepEqual(escalated.map((n) => n.to).sort(), ["founder", "lead"]);
  });

  test("escalation fires exactly once no matter how often we sweep", () => {
    const { graph, gate } = rig();
    graph.dispatch("A", 0);
    gate.open("A", 0);

    assert.equal(gate.sweep(61_000).length, 2);
    assert.equal(gate.sweep(62_000).length, 0, "latched");
    assert.equal(gate.sweep(999_000).length, 0);
    assert.equal(gate.countFor("founder"), 1, "four humans stay un-drowned");
  });

  test("an approved gate stops escalating", () => {
    const { graph, gate } = rig();
    graph.dispatch("A", 0);
    gate.open("A", 0);
    gate.approve("A");
    assert.equal(gate.sweep(999_000).length, 0);
  });

  test("a rejected review fails the package and keeps dependents blocked", () => {
    const { graph, gate } = rig();
    graph.dispatch("A");
    gate.open("A");
    gate.reject("A");
    assert.equal(graph.get("A").state, "failed");
    assert.equal(graph.get("B").state, "blocked");
  });

  test("a gate with no reviewer is refused at construction", () => {
    const graph = new DependencyGraph(diamond);
    assert.throws(
      () => new ReviewGate(graph, { slaMs: 1, humans: [{ id: "f", role: "founder" }] }),
      /at least one reviewer/,
    );
  });
});
