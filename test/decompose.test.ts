import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseWorkPackages, defaultWorkPackages, formatWorkPackageRef, parseWorkPackageRef,
} from "../src/decompose.js";
import { DependencyGraph, CycleError } from "../src/graph.js";
import { EventStore } from "../src/store.js";
import { renderStatus } from "../src/status.js";

describe("work package spec parsing", () => {
  const spec = `Some preamble that should be ignored.

## Work packages
- [A] Database schema
- [B] API endpoints (depends: A)
- [C] Background worker (depends: A)
- [D] UI wiring (depends: B, C)

## Notes
- [X] this must not be picked up`;

  const pkgs = parseWorkPackages(spec);

  test("reads every package under the heading", () => {
    assert.deepEqual(pkgs.map((p) => p.id), ["A", "B", "C", "D"]);
  });

  test("stops at the next heading", () => {
    assert.ok(!pkgs.some((p) => p.id === "X"), "the Notes list must not leak in");
  });

  test("parses dependencies, single and multiple", () => {
    assert.deepEqual(pkgs.find((p) => p.id === "B")!.dependsOn, ["A"]);
    assert.deepEqual(pkgs.find((p) => p.id === "D")!.dependsOn, ["B", "C"]);
    assert.deepEqual(pkgs.find((p) => p.id === "A")!.dependsOn, []);
  });

  test("keeps the title clean of the dependency clause", () => {
    assert.equal(pkgs.find((p) => p.id === "B")!.title, "API endpoints");
  });

  test("a blank line does not end the block", () => {
    const out = parseWorkPackages("## Work packages\n- [A] one\n\n- [B] two (depends: A)");
    assert.equal(out.length, 2);
  });

  test("no heading means no packages, so the caller can fall back", () => {
    assert.deepEqual(parseWorkPackages("just a description"), []);
    assert.deepEqual(parseWorkPackages(undefined), []);
  });

  test("the parsed spec forms a valid graph with the roots ready", () => {
    const g = new DependencyGraph(pkgs);
    assert.deepEqual(g.ready().map((r) => r.pkg.id), ["A"]);
  });

  test("a spec with a cycle is rejected before anything is written to Linear", () => {
    const cyclic = parseWorkPackages("## Work packages\n- [A] a (depends: B)\n- [B] b (depends: A)");
    assert.throws(() => new DependencyGraph(cyclic), CycleError);
  });

  test("the default shape is a valid diamond", () => {
    const g = new DependencyGraph(defaultWorkPackages());
    assert.deepEqual(g.ready().map((r) => r.pkg.id), ["A"]);
    assert.equal(g.get("D").state, "blocked");
  });
});

describe("status page", () => {
  function store() {
    const s = new EventStore(":memory:");
    s.claim("sess-1:created:1", JSON.stringify({
      action: "created", agentSession: { id: "sess-1", issue: { identifier: "YUV-9" } },
    }), 1000);
    return s;
  }

  test("renders counts and the human-readable issue key, not the uuid", () => {
    const html = renderStatus(store(), { installed: true, mode: "replay", now: 5000 });
    assert.match(html, /YUV-9/);
    assert.ok(!/sess-1:created/.test(html), "raw event ids are not founder-readable");
  });

  test("warns clearly when not installed", () => {
    const html = renderStatus(store(), { installed: false, mode: "replay", now: 5000 });
    assert.match(html, /Not installed/);
  });

  test("says plainly that replay mode spends nothing", () => {
    const html = renderStatus(store(), { installed: true, mode: "replay", now: 5000 });
    assert.match(html, /nothing is spent|nothing is spent\./i);
  });

  test("escapes payload-derived text rather than injecting it", () => {
    const s = new EventStore(":memory:");
    s.claim("x:created:1", JSON.stringify({
      action: "<script>alert(1)</script>",
      agentSession: { id: "x", issue: { identifier: "<img onerror=1>" } },
    }), 1000);
    const html = renderStatus(s, { installed: true, mode: "replay", now: 2000 });
    assert.ok(!/<script>/.test(html), "must not emit a raw script tag");
    assert.match(html, /&lt;script&gt;/);
  });

  test("an empty queue reads as guidance, not as an error", () => {
    const html = renderStatus(new EventStore(":memory:"), { installed: true, mode: "replay", now: 1 });
    assert.match(html, /Delegate an issue to the agent/);
  });
});

describe("work package ref — the only link back from a sub-issue to its graph", () => {
  test("format and parse round-trip", () => {
    const line = formatWorkPackageRef("B", "YUV-6");
    assert.deepEqual(parseWorkPackageRef(line), { pkgId: "B", epicIdentifier: "YUV-6" });
  });

  test("parses the ref out of a full sub-issue description, blocked-by line and all", () => {
    const description = formatWorkPackageRef("D", "YUV-6") + "\n\nBlocked by: B, C";
    assert.deepEqual(parseWorkPackageRef(description), { pkgId: "D", epicIdentifier: "YUV-6" });
  });

  test("a package id with punctuation still parses", () => {
    const line = formatWorkPackageRef("pkg-1.2_a", "ENG-42");
    assert.deepEqual(parseWorkPackageRef(line), { pkgId: "pkg-1.2_a", epicIdentifier: "ENG-42" });
  });

  test("a hand-written sub-issue with no ref line parses to undefined, not a crash", () => {
    assert.equal(parseWorkPackageRef("Just do the thing, thanks."), undefined);
    assert.equal(parseWorkPackageRef(undefined), undefined);
    assert.equal(parseWorkPackageRef(""), undefined);
  });

  test("does not match a similar-looking sentence that isn't the exact ref line", () => {
    assert.equal(parseWorkPackageRef("This work package relates to YUV-6 somehow."), undefined);
  });
});
