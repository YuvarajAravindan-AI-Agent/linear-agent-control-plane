import type { SessionEvent, Worker } from "./consumer.js";
import type { LinearClient } from "./linear.js";
import { DependencyGraph } from "./graph.js";
import { parseWorkPackages, defaultWorkPackages } from "./decompose.js";
import type { WorkPackage } from "./types.js";

/**
 * Replay worker. **Calls no model and spends nothing.**
 *
 * Two behaviours, chosen by whether the delegated issue has a parent:
 *
 *  - **Epic** (no parent): decompose into work packages, create them as real
 *    sub-issues, mirror the dependency edges as Linear `blocks` relations, then
 *    open the review gate on the plan. Nothing is dispatched until a human
 *    approves the decomposition — that is the "understanding review".
 *
 *  - **Leaf** (has a parent): it *is* a work package. Report what a live run would
 *    do and gate on the result.
 *
 * The dependency graph is built and validated in code (cycles, unknown ids) BEFORE
 * anything is written to Linear. A cycle should fail as a parse error, not as four
 * orphaned sub-issues someone has to clean up by hand.
 */
export function replayWorker(client: LinearClient): Worker {
  return async (event: SessionEvent) => {
    const issueId = event.agentSession?.issue?.id;
    if (!issueId) {
      return { body: "No issue was attached to this session, so there is nothing to plan.", needsReview: true };
    }

    const issue = await client.issue(issueId);

    if (issue.parentId) return leaf(issue);
    return epic(client, issue);
  };
}

interface Issue {
  id: string; identifier: string; title: string;
  description?: string; teamId: string; parentId?: string;
}

function leaf(issue: Issue) {
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

async function epic(client: LinearClient, issue: Issue) {
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
      description: `Work package \`${pkg.id}\` of ${issue.identifier}.` +
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
