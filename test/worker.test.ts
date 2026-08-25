import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LinearLike } from "../src/linear.js";
import { GraphStore } from "../src/graphstore.js";
import { replayWorker } from "../src/worker.js";
import type { SessionEvent } from "../src/consumer.js";
import { formatWorkPackageRef } from "../src/decompose.js";

interface FakeIssue {
  id: string; identifier: string; title: string;
  description?: string; teamId: string; parentId?: string;
}

/**
 * A fake satisfying LinearLike, not a mock of the concrete client — this is
 * what LinearLike was extracted for. Issues are addressable by id, sub-issues
 * get sequential ids/identifiers in creation order, and every relation/comment
 * call is recorded for assertions.
 */
class FakeLinear implements LinearLike {
  issues = new Map<string, FakeIssue>();
  comments: Array<{ issueId: string; body: string }> = [];
  blockedBy: Array<{ issueId: string; relatedIssueId: string }> = [];
  commentShouldThrow = false;
  private seq = 0;

  addIssue(i: FakeIssue): void { this.issues.set(i.id, i); }

  async issue(id: string) {
    const i = this.issues.get(id);
    if (!i) throw new Error(`unknown issue ${id}`);
    return i;
  }

  async createSubIssue(input: { teamId: string; parentId: string; title: string; description?: string }) {
    this.seq += 1;
    const id = `sub-${this.seq}`;
    const identifier = `YUV-${100 + this.seq}`;
    this.issues.set(id, { id, identifier, ...input });
    return { id, identifier };
  }

  async addBlockedBy(issueId: string, relatedIssueId: string) {
    this.blockedBy.push({ issueId, relatedIssueId });
  }

  async comment(issueId: string, body: string) {
    if (this.commentShouldThrow) throw new Error("comment API down");
    this.comments.push({ issueId, body });
  }
}

const gateConfig = { slaMs: 60_000, humans: [{ id: "founder", role: "reviewer" as const }] };

function created(issueId: string, sessionId = `sess-${issueId}`): SessionEvent {
  return { action: "created", agentSession: { id: sessionId, issue: { id: issueId } } };
}

function prompted(issueId: string, promptContext: string, sessionId = `sess-${issueId}`): SessionEvent {
  return { action: "prompted", agentSession: { id: sessionId, issue: { id: issueId } }, promptContext };
}

describe("replayWorker — epic decomposition persists what leaf() later needs", () => {
  let dir: string;
  let n = 0;
  before(() => { dir = mkdtempSync(join(tmpdir(), "lacp-worker-")); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  function rig() {
    const client = new FakeLinear();
    const graphs = new GraphStore(join(dir, `w${n++}.db`));
    const worker = replayWorker(client, graphs, gateConfig);
    client.addIssue({
      id: "epic-1", identifier: "YUV-6", title: "Checkout rewrite", teamId: "team-1",
      description: [
        "## Work packages",
        "- [A] Database schema",
        "- [B] API endpoints (depends: A)",
        "- [C] Background worker (depends: A)",
        "- [D] UI wiring (depends: B, C)",
      ].join("\n"),
    });
    return { client, graphs, worker };
  }

  test("decomposing writes a persisted graph a later delivery can find", async () => {
    const { worker, graphs } = rig();
    const result = await worker(created("epic-1", "sess-epic"));
    assert.equal(result.needsReview, true);
    assert.match(result.body, /Dispatchable now: `A`/);

    const record = graphs.load("YUV-6");
    assert.ok(record, "the graph must survive past the worker call that built it");
    assert.equal(record!.epicIssueId, "epic-1");
    assert.deepEqual(Object.keys(record!.issueRefs).sort(), ["A", "B", "C", "D"]);
  });

  test("each created sub-issue carries the ref line leaf() will parse back", async () => {
    const { worker, client } = rig();
    await worker(created("epic-1"));
    const subA = [...client.issues.values()].find((i) => i.parentId === "epic-1" && i.title === "Database schema")!;
    assert.equal(subA.description, formatWorkPackageRef("A", "YUV-6"));
  });

  test("dependency edges are recorded as real blocks relations", async () => {
    const { worker, client } = rig();
    await worker(created("epic-1"));
    assert.equal(client.blockedBy.length, 4, "A->none, B->A, C->A, D->B,D->C");
  });
});

describe("replayWorker — leaf dispatch and review against the real persisted graph", () => {
  let dir: string;
  let n = 0;
  before(() => { dir = mkdtempSync(join(tmpdir(), "lacp-worker-leaf-")); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  async function decomposedRig() {
    const client = new FakeLinear();
    const graphs = new GraphStore(join(dir, `l${n++}.db`));
    const worker = replayWorker(client, graphs, gateConfig);
    client.addIssue({
      id: "epic-1", identifier: "YUV-6", title: "Checkout rewrite", teamId: "team-1",
      description: [
        "## Work packages",
        "- [A] Database schema",
        "- [B] API endpoints (depends: A)",
        "- [C] Background worker (depends: A)",
        "- [D] UI wiring (depends: B, C)",
      ].join("\n"),
    });
    await worker(created("epic-1"));
    // A, B, C, D were created in that order -> sub-1..sub-4.
    return { client, graphs, worker, ids: { A: "sub-1", B: "sub-2", C: "sub-3", D: "sub-4" } };
  }

  test("assigning a ready package dispatches it and opens the review gate", async () => {
    const { worker, graphs, ids } = await decomposedRig();
    const result = await worker(created(ids.A));
    assert.equal(result.needsReview, true);
    assert.match(result.body, /Approve to merge it and unblock/);
    assert.equal(graphs.load("YUV-6")!.packages.find((p) => p.pkg.id === "A")!.state, "awaitingGate");
  });

  test("assigning a blocked package reports what it is actually waiting on", async () => {
    const { worker, ids } = await decomposedRig();
    const result = await worker(created(ids.D));
    assert.equal(result.needsReview, true);
    assert.match(result.body, /Still blocked on: B, C/);
  });

  test("approving merges the package AND unblocks its dependents for real", async () => {
    const { worker, graphs, ids } = await decomposedRig();
    await worker(created(ids.A));
    const approval = await worker(prompted(ids.A, "Looks good, approve"));

    assert.equal(approval.needsReview, false);
    assert.match(approval.body, /`A` merged/);
    assert.match(approval.body, /Dispatchable now:/);

    const state = graphs.load("YUV-6")!;
    assert.equal(state.packages.find((p) => p.pkg.id === "A")!.state, "merged");
    assert.equal(state.packages.find((p) => p.pkg.id === "B")!.state, "ready");
    assert.equal(state.packages.find((p) => p.pkg.id === "C")!.state, "ready");
  });

  // This is the behaviour the whole feature exists to prove: a human reviewing
  // the epic, not this one session's transcript, can see what unblocked.
  test("approval posts the unblocked set as a comment on the EPIC issue", async () => {
    const { worker, client, ids } = await decomposedRig();
    await worker(created(ids.A));
    await worker(prompted(ids.A, "approve"));

    const onEpic = client.comments.filter((c) => c.issueId === "epic-1");
    assert.equal(onEpic.length, 1);
    assert.match(onEpic[0]!.body, /`A` merged/);
    assert.match(onEpic[0]!.body, /YUV-101|YUV-102/, "must name the real sub-issue identifiers, not the internal pkg ids alone");
  });

  test("a bare approval defaults to approve without matching a keyword", async () => {
    const { worker, ids } = await decomposedRig();
    await worker(created(ids.A));
    const r = await worker(prompted(ids.A, "lgtm, ship it"));
    assert.match(r.body, /merged/);
  });

  test("rejecting fails the package and leaves dependents blocked", async () => {
    const { worker, graphs, ids } = await decomposedRig();
    // B depends on A — merge A first, or B never leaves "blocked" to be rejected.
    await worker(created(ids.A));
    await worker(prompted(ids.A, "approve"));
    await worker(created(ids.B));
    const r = await worker(prompted(ids.B, "reject — wrong approach, needs rework"));

    assert.equal(r.needsReview, false);
    assert.match(r.body, /rejected/);
    const state = graphs.load("YUV-6")!;
    assert.equal(state.packages.find((p) => p.pkg.id === "B")!.state, "failed");
    assert.equal(state.packages.find((p) => p.pkg.id === "D")!.state, "blocked", "D depends on B; a failure must not unblock it");
  });

  test("re-assigning an already-merged package reports its real state, not a redo", async () => {
    const { worker, ids } = await decomposedRig();
    await worker(created(ids.A));
    await worker(prompted(ids.A, "approve"));
    const r = await worker(created(ids.A));
    assert.equal(r.needsReview, false);
    assert.match(r.body, /currently \*\*merged\*\*/);
  });

  test("a review reply for a package that is not awaitingGate is reported, not acted on", async () => {
    const { worker, graphs, ids } = await decomposedRig();
    await worker(created(ids.A));
    await worker(prompted(ids.A, "approve")); // now merged
    const r = await worker(prompted(ids.A, "approve")); // stray duplicate reply
    assert.equal(r.needsReview, false);
    assert.match(r.body, /currently \*\*merged\*\*/);
    assert.equal(graphs.load("YUV-6")!.packages.find((p) => p.pkg.id === "A")!.state, "merged", "must not double-process");
  });

  test("the last package merging reports quiescence, not a phantom ready set", async () => {
    const client = new FakeLinear();
    const graphs = new GraphStore(join(dir, `solo-${n++}.db`));
    const worker = replayWorker(client, graphs, gateConfig);
    client.addIssue({
      id: "epic-solo", identifier: "YUV-50", title: "Tiny epic", teamId: "team-1",
      description: "## Work packages\n- [ONLY] the whole thing",
    });
    await worker(created("epic-solo"));
    await worker(created("sub-1"));
    const r = await worker(prompted("sub-1", "approve"));
    assert.match(r.body, /fully merged/);
    assert.equal(client.comments.length, 0, "nothing was unblocked, so nothing should be commented");
  });

  test("a failed comment does not roll back an already-persisted merge", async () => {
    const { worker, client, graphs, ids } = await decomposedRig();
    await worker(created(ids.A));
    client.commentShouldThrow = true;
    const r = await worker(prompted(ids.A, "approve"));

    assert.match(r.body, /could not post the update comment/);
    assert.equal(graphs.load("YUV-6")!.packages.find((p) => p.pkg.id === "A")!.state, "merged",
      "the merge already happened; a courtesy comment failing must not undo it");
  });

  test("a leaf with no ref line degrades to the generic reply instead of throwing", async () => {
    const client = new FakeLinear();
    const graphs = new GraphStore(join(dir, `unlinked-${n++}.db`));
    const worker = replayWorker(client, graphs, gateConfig);
    client.addIssue({ id: "manual-1", identifier: "YUV-77", title: "Hand-made subtask", teamId: "team-1", parentId: "some-epic", description: "Just do this, thanks." });

    const r = await worker(created("manual-1"));
    assert.equal(r.needsReview, true);
    assert.match(r.body, /Approve to continue/);
  });

  test("a ref pointing at an epic that was never decomposed reports missing state, not a crash", async () => {
    const client = new FakeLinear();
    const graphs = new GraphStore(join(dir, `orphan-${n++}.db`));
    const worker = replayWorker(client, graphs, gateConfig);
    client.addIssue({
      id: "orphan-1", identifier: "YUV-88", title: "Orphaned package", teamId: "team-1",
      parentId: "epic-nope", description: formatWorkPackageRef("A", "YUV-999"),
    });

    const r = await worker(created("orphan-1"));
    assert.equal(r.needsReview, true);
    assert.match(r.body, /No decomposition state is on file for YUV-999/);
  });

  test("a ref naming a package id absent from its own epic reports that, not a crash", async () => {
    const { worker, client } = await decomposedRig();
    client.addIssue({
      id: "forged-1", identifier: "YUV-200", title: "Forged package", teamId: "team-1",
      parentId: "epic-1", description: formatWorkPackageRef("Z", "YUV-6"),
    });
    const r = await worker(created("forged-1"));
    assert.equal(r.needsReview, true);
    assert.match(r.body, /not part of the tracked decomposition/);
  });
});
