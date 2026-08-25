import { DatabaseSync } from "node:sqlite";
import { DependencyGraph } from "./graph.js";
import type { PackageRecord } from "./types.js";

export interface IssueRef {
  id: string;
  identifier: string;
}

export interface EpicRecord {
  epicIssueId: string;
  epicIdentifier: string;
  packages: PackageRecord[];
  /** pkgId -> the sub-issue Linear created for it. */
  issueRefs: Record<string, IssueRef>;
}

/**
 * Persists the dependency graph produced by decomposing an epic.
 *
 * This is the piece that was missing: `epic()` in worker.ts used to build a
 * DependencyGraph, create sub-issues from it, and then let both fall out of
 * scope when the function returned. The next webhook delivery — a human
 * assigning a work package, or responding to a review — arrived as a brand
 * new event with no memory of any of that, so "approve" could never reach a
 * `merge()` call and nothing was ever unblocked.
 *
 * Keyed by the epic's human-readable identifier (e.g. "YUV-6") rather than its
 * UUID: that identifier is the only thing embedded in a sub-issue's
 * description (see decompose.ts's WORK_PACKAGE_REF_LINE), so it is what a
 * later delivery actually has to look the graph up with.
 */
export class GraphStore {
  private db: DatabaseSync;

  constructor(path: string = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS epic_graphs (
        epic_identifier TEXT PRIMARY KEY,
        epic_issue_id   TEXT NOT NULL,
        data            TEXT NOT NULL,
        updated_at      INTEGER NOT NULL
      )
    `);
  }

  save(
    epicIdentifier: string,
    epicIssueId: string,
    graph: DependencyGraph,
    issueRefs: Record<string, IssueRef>,
    now: number = Date.now(),
  ): void {
    const data = JSON.stringify({ packages: graph.all(), issueRefs });
    this.db
      .prepare(
        `INSERT INTO epic_graphs (epic_identifier, epic_issue_id, data, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(epic_identifier) DO UPDATE SET
           epic_issue_id = excluded.epic_issue_id,
           data = excluded.data,
           updated_at = excluded.updated_at`,
      )
      .run(epicIdentifier, epicIssueId, data, now);
  }

  load(epicIdentifier: string): EpicRecord | undefined {
    const row = this.db
      .prepare("SELECT epic_issue_id, data FROM epic_graphs WHERE epic_identifier = ?")
      .get(epicIdentifier) as { epic_issue_id: string; data: string } | undefined;
    if (!row) return undefined;

    const parsed = JSON.parse(row.data) as {
      packages: PackageRecord[];
      issueRefs: Record<string, IssueRef>;
    };
    return {
      epicIssueId: row.epic_issue_id,
      epicIdentifier,
      packages: parsed.packages,
      issueRefs: parsed.issueRefs,
    };
  }

  /** All tracked epics, for a future escalation sweep to iterate over. */
  listEpicIdentifiers(): string[] {
    const rows = this.db.prepare("SELECT epic_identifier FROM epic_graphs").all() as Array<{
      epic_identifier: string;
    }>;
    return rows.map((r) => r.epic_identifier);
  }

  close(): void {
    this.db.close();
  }
}

/** Convenience: load a record and rehydrate it into a live graph in one step. */
export function loadGraph(
  store: GraphStore,
  epicIdentifier: string,
): { record: EpicRecord; graph: DependencyGraph } | undefined {
  const record = store.load(epicIdentifier);
  if (!record) return undefined;
  return { record, graph: DependencyGraph.rehydrate(record.packages) };
}
