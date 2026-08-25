import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DependencyGraph } from "../src/graph.js";
import { defaultWorkPackages } from "../src/decompose.js";
import { GraphStore, loadGraph } from "../src/graphstore.js";

describe("GraphStore", () => {
  let dir: string;
  let n = 0;
  before(() => { dir = mkdtempSync(join(tmpdir(), "lacp-graphstore-")); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });
  const store = () => new GraphStore(join(dir, `g${n++}.db`));

  const refs = {
    A: { id: "issue-a", identifier: "YUV-10" },
    B: { id: "issue-b", identifier: "YUV-11" },
    C: { id: "issue-c", identifier: "YUV-12" },
    D: { id: "issue-d", identifier: "YUV-13" },
  };

  test("round-trips a freshly-built graph unchanged", () => {
    const s = store();
    const graph = new DependencyGraph(defaultWorkPackages());
    s.save("YUV-6", "epic-issue-id", graph, refs);

    const loaded = loadGraph(s, "YUV-6")!;
    assert.equal(loaded.record.epicIssueId, "epic-issue-id");
    assert.deepEqual(loaded.record.issueRefs, refs);
    assert.deepEqual(loaded.graph.ready().map((r) => r.pkg.id), ["A"]);
    assert.equal(loaded.graph.get("D").state, "blocked");
    s.close();
  });

  test("an unknown epic identifier loads nothing", () => {
    const s = store();
    assert.equal(loadGraph(s, "NOPE-1"), undefined);
    s.close();
  });

  // The whole point of this store: state survives past the call that produced it.
  test("persists state mutated after the initial save", () => {
    const s = store();
    const graph = new DependencyGraph(defaultWorkPackages());
    s.save("YUV-6", "epic-issue-id", graph, refs);

    const { graph: g1 } = loadGraph(s, "YUV-6")!;
    g1.dispatch("A");
    g1.openGate("A");
    g1.merge("A");
    s.save("YUV-6", "epic-issue-id", g1, refs);

    const { graph: g2 } = loadGraph(s, "YUV-6")!;
    assert.equal(g2.get("A").state, "merged");
    // merging A must have unblocked B and C, and that must survive the round trip.
    assert.deepEqual(g2.ready().map((r) => r.pkg.id).sort(), ["B", "C"]);
    s.close();
  });

  test("a second save overwrites rather than duplicating the row", () => {
    const s = store();
    const graph = new DependencyGraph(defaultWorkPackages());
    s.save("YUV-6", "epic-issue-id", graph, refs);
    s.save("YUV-6", "epic-issue-id", graph, refs);
    assert.deepEqual(s.listEpicIdentifiers(), ["YUV-6"]);
    s.close();
  });

  test("survives being reopened against the same file", () => {
    const path = join(dir, "reopen.db");
    const s1 = new GraphStore(path);
    const graph = new DependencyGraph(defaultWorkPackages());
    graph.dispatch("A");
    s1.save("YUV-9", "epic-9", graph, refs);
    s1.close();

    const s2 = new GraphStore(path);
    const { graph: reloaded } = loadGraph(s2, "YUV-9")!;
    assert.equal(reloaded.get("A").state, "dispatched");
    s2.close();
  });

  test("lists every tracked epic, for a future sweep to iterate", () => {
    const s = store();
    const graph = new DependencyGraph(defaultWorkPackages());
    s.save("YUV-1", "e1", graph, refs);
    s.save("YUV-2", "e2", graph, refs);
    assert.deepEqual(s.listEpicIdentifiers().sort(), ["YUV-1", "YUV-2"]);
    s.close();
  });
});
