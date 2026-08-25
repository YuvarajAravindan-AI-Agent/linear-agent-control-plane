import type { SessionEvent, Worker } from "./consumer.js";
import type { LinearLike } from "./linear.js";
import { DependencyGraph } from "./graph.js";
import { ReviewGate, type GateConfig } from "./gate.js";
import {
  parseWorkPackages, defaultWorkPackages, formatWorkPackageRef, parseWorkPackageRef,
  type WorkPackageRef,
} from "./decompose.js";
import { GraphStore, loadGraph, type EpicRecord, type IssueRef } from "./graphstore.js";
import type { WorkPackage, PackageRecord } from "./types.js";

/**
 * Replay worker. **Calls no model and spends nothing.**
 *
 * Two behaviours, chosen by whether the delegated issue has a parent:
 *
 *  - **Epic** (no parent): decompose into work packages, create them as real
 *    sub-issues, mirror the dependency edges as Linear `blocks` relations,
 *    persist the resulting graph, then open the review gate on the plan.
 *    Nothing is dispatched until a human approves the decomposition.
 *
 *  - **Leaf** (has a parent): it *is* a work package. Assigning it dispatches
 *    the real, persisted package; responding to the review it opens approves
 *    or rejects it — which is what makes dependents actually unblock.
 *
 * The dependency graph is built and validated in code (cycles, unknown ids)
 * BEFORE anything is written to Linear. A cycle should fail as a parse error,
 * not as four orphaned sub-issues someone has to clean up by hand.
 */
export function replayWorker(client: LinearLike, graphStore: GraphStore, gateConfig: GateConfig): Worker {
  return async (event: SessionEvent) => {
    const issueId = event.agentSession?.issue?.id;
    if (!issueId) {
      return { body: "No issue was attached to this session, so there is nothing to plan.", needsReview: true };
    }

    const issue = await client.issue(issueId);

    if (issue.parentId) return leaf(client, graphStore, gateConfig, issue, event);
    return epic(client, graphStore, issue);
  };
}

interface Issue {
  id: string; identifier: string; title: string;
  description?: string; teamId: string; parentId?: string;
}

async function epic(client: LinearLike, graphStore: GraphStore, issue: Issue) {
  const parsed = parseWorkPackages(issue.description);
  const packages: WorkPackage[] = parsed.length ? parsed : defaultWorkPackages();
  const usedDefault = parsed.length === 0;

  // Validate before writing anything. Cycles and unknown dependency ids throw here.
  let graph: DependencyGraph;
  try {
    graph = new DependencyGraph(packages);
  } catch (err) {
    return {
      body: [
        "**Could not decompose this epic.**",
        "",
        `\`${err instanceof Error ? err.message : String(err)}\``,
        "",
        "Fix the `## Work packages` block and re-assign to me.",
      ].join("\n"),
      needsReview: true,
    };
  }

  // Create sub-issues first, then relations — a relation needs both ids to exist.
  const created = new Map<string, { id: string; identifier: string }>();
  for (const pkg of packages) {
    created.set(pkg.id, await client.createSubIssue({
      teamId: issue.teamId,
      parentId: issue.id,
      title: pkg.title,
      description: formatWorkPackageRef(pkg.id, issue.identifier) +
        (pkg.dependsOn.length ? `\n\nBlocked by: ${pkg.dependsOn.join(", ")}` : ""),
    }));
  }

  let edges = 0;
  for (const pkg of packages) {
    for (const dep of pkg.dependsOn) {
      await client.addBlockedBy(created.get(pkg.id)!.id, created.get(dep)!.id);
      edges++;
    }
  }

  // The step that used to be missing: without this, `graph` and the pkgId ->
  // sub-issue mapping in `created` both vanish when this function returns, and
  // the next webhook delivery — someone assigning a ready package — has no way
  // to find either one again.
  const issueRefs: Record<string, IssueRef> = {};
  for (const [pkgId, ref] of created) issueRefs[pkgId] = ref;
  graphStore.save(issue.identifier, issue.id, graph, issueRefs);

  const ready = graph.ready().map((r) => r.pkg.id);
  const lines = packages.map((p) => {
    const ref = created.get(p.id)!.identifier;
    const blocked = p.dependsOn.length ? ` — blocked by ${p.dependsOn.join(", ")}` : " — **ready now**";
    return `- \`${p.id}\` ${ref} · ${p.title}${blocked}`;
  });

  return {
    body: [
      `**Decomposed ${issue.identifier} into ${packages.length} work packages.**`,
      usedDefault
        ? "_No `## Work packages` block found, so a default shape was used to demonstrate ordering._"
        : "_Parsed from the `## Work packages` block in the description._",
      "",
      ...lines,
      "",
      `${edges} dependency edge(s) recorded as Linear \`blocks\` relations.`,
      `Dispatchable now: ${ready.length ? ready.map((r) => `\`${r}\``).join(", ") : "none"}.`,
      "",
      "Replay mode — no model was called and nothing was spent.",
      "",
      "**Nothing is dispatched until you approve this plan.** Assign a ready package to me to start it.",
    ].join("\n"),
    needsReview: true,
  };
}

async function leaf(
  client: LinearLike,
  graphStore: GraphStore,
  gateConfig: GateConfig,
  issue: Issue,
  event: SessionEvent,
) {
  const ref = parseWorkPackageRef(issue.description);
  if (!ref) {
    // A sub-issue created by hand, or one that predates this feature — there is
    // no tracked graph to act against. Degrade to a useful generic reply rather
    // than throwing on a shape the rest of the system does not control.
    return unlinkedLeaf(issue);
  }

  const loaded = loadGraph(graphStore, ref.epicIdentifier);
  if (!loaded) {
    return {
      body: [
        `**Work package \`${ref.pkgId}\` of ${ref.epicIdentifier}.**`,
        "",
        `No decomposition state is on file for ${ref.epicIdentifier} — it may predate this ` +
        "feature, or the data volume was reset. Re-decompose the epic to restore tracking.",
      ].join("\n"),
      needsReview: true,
    };
  }

  const { record, graph } = loaded;
  let rec: PackageRecord;
  try {
    rec = graph.get(ref.pkgId);
  } catch {
    return {
      body: `Work package \`${ref.pkgId}\` is not part of the tracked decomposition of ${ref.epicIdentifier}.`,
      needsReview: true,
    };
  }

  const gate = new ReviewGate(graph, gateConfig);

  // "prompted" is a human replying to the elicitation this same worker opened
  // below — i.e. it is the review response. Everything else ("created") is the
  // package being assigned for the first time.
  if (event.action === "prompted") {
    return handleReview(client, graphStore, record, graph, gate, ref, rec, event);
  }
  return handleDispatch(graphStore, record, graph, gate, ref, rec);
}

function handleDispatch(
  graphStore: GraphStore,
  record: EpicRecord,
  graph: DependencyGraph,
  gate: ReviewGate,
  ref: WorkPackageRef,
  rec: PackageRecord,
) {
  if (rec.state === "blocked") {
    const waiting = rec.pkg.dependsOn.filter((d) => graph.get(d).state !== "merged");
    return {
      body: [
        `**Work package \`${ref.pkgId}\` — ${rec.pkg.title}**`,
        "",
        `Still blocked on: ${waiting.join(", ")}. Assign it again once ${
          waiting.length > 1 ? "those are" : "that is"
        } merged.`,
      ].join("\n"),
      needsReview: true,
    };
  }

  if (rec.state !== "ready") {
    // dispatched / awaitingGate / merged / failed — assigning it again must not
    // silently redo anything; report the real state instead.
    return { body: statusBody(ref, rec), needsReview: rec.state === "awaitingGate" };
  }

  graph.dispatch(ref.pkgId);
  // Replay mode never actually runs anything, so there is no failure path here —
  // the "run" always reaches the human review gate rather than either failing or
  // merging itself. A live worker (Gap 3) would call graph.fail() on error.
  gate.open(ref.pkgId);
  graphStore.save(ref.epicIdentifier, record.epicIssueId, graph, record.issueRefs);

  return {
    body: [
      `**Work package \`${ref.pkgId}\` — ${rec.pkg.title}**`,
      "",
      "Replay mode: no model was called and nothing was spent.",
      "",
      "A live run would open a branch, implement this package, run the suite, and open a PR,",
      "then hold here for review before anything merges.",
      "",
      "Approve to merge it and unblock anything waiting on it, or reply with corrections.",
    ].join("\n"),
    needsReview: true,
  };
}

async function handleReview(
  client: LinearLike,
  graphStore: GraphStore,
  record: EpicRecord,
  graph: DependencyGraph,
  gate: ReviewGate,
  ref: WorkPackageRef,
  rec: PackageRecord,
  event: SessionEvent,
) {
  if (rec.state !== "awaitingGate") {
    // A reply arrived for a package that is not (or no longer) under review —
    // e.g. a duplicate response, or one that crossed with someone else's. Report
    // reality; do not guess at intent.
    return { body: statusBody(ref, rec), needsReview: false };
  }

  const reply = (event.promptContext ?? "").trim().toLowerCase();
  const rejected = /\b(reject|no|fail|deny|declin)/.test(reply);

  if (rejected) {
    gate.reject(ref.pkgId);
    graphStore.save(ref.epicIdentifier, record.epicIssueId, graph, record.issueRefs);
    return {
      body: `**\`${ref.pkgId}\` rejected.** Dependents remain blocked. Reply with corrections to retry.`,
      needsReview: false,
    };
  }

  // Anything that is not a recognised rejection defaults to approval — the
  // review gate's whole purpose is to hold for a human, and a bare "looks
  // good"/"lgtm" must not need to match a keyword list to count.
  gate.approve(ref.pkgId);
  graphStore.save(ref.epicIdentifier, record.epicIssueId, graph, record.issueRefs);

  const ready = graph.ready().map((r) => r.pkg.id);
  const lines = [
    `**\`${ref.pkgId}\` merged.**`,
    "",
    ready.length
      ? `Dispatchable now: ${ready.map((id) => refLabel(id, record)).join(", ")}.`
      : graph.isQuiescent()
        ? "That was the last package — the epic is fully merged."
        : "Nothing else is unblocked yet.",
  ];

  // This is the step that makes "approving a gate unblocks dependents" an
  // observable fact rather than a row nobody sees: without it, the only place
  // the newly-ready set is visible is the reply on this one session's own
  // transcript, which a founder reviewing from the epic would never open.
  if (ready.length) {
    try {
      await client.comment(
        record.epicIssueId,
        `\`${ref.pkgId}\` merged. Dispatchable now: ${
          ready.map((id) => refLabel(id, record)).join(", ")
        }.`,
      );
    } catch {
      // The merge already happened and is the source of truth; a failed
      // courtesy comment must not make the review itself look like it failed.
      lines.push("", "(could not post the update comment on the epic — check logs)");
    }
  }

  return { body: lines.join("\n"), needsReview: false };
}

function refLabel(pkgId: string, record: EpicRecord): string {
  const ref = record.issueRefs[pkgId];
  return ref ? ref.identifier : `\`${pkgId}\``;
}

function statusBody(ref: WorkPackageRef, rec: PackageRecord): string {
  return `**\`${ref.pkgId}\` — ${rec.pkg.title}** is currently **${rec.state}**.`;
}

/** The original generic reply, for a leaf with no recoverable graph reference. */
function unlinkedLeaf(issue: Issue) {
  return {
    body: [
      `**Work package \`${issue.identifier}\` — ${issue.title}**`,
      "",
      "Replay mode: no model was called and nothing was spent.",
      "",
      "A live run would open a branch, implement this package, run the suite, and open a PR,",
      "then hold here for review before anything merges.",
      "",
      "Approve to continue, or reply with corrections.",
    ].join("\n"),
    needsReview: true,
  };
}
