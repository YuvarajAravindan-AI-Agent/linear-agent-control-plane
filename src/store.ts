import { DatabaseSync } from "node:sqlite";

export type EventState = "queued" | "running" | "done" | "failed";

export interface ClaimResult {
  /** false when this delivery is a duplicate of one already accepted. */
  claimed: boolean;
  state: EventState;
}

/**
 * Durable dedupe + work queue for inbound AgentSessionEvent deliveries.
 *
 * Why durable rather than an in-process Set or LRU: Linear retries a failed
 * delivery after 1 minute, 1 hour and 6 hours. An in-memory dedupe passes every
 * fast-redelivery test and then dispatches a second agent against the same work
 * package six hours later, after a deploy has cycled the process. The retry
 * schedule is the reason this is on disk.
 */
export class EventStore {
  private db: DatabaseSync;

  constructor(path: string = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id           TEXT PRIMARY KEY,
        received_at  INTEGER NOT NULL,
        state        TEXT NOT NULL,
        payload      TEXT NOT NULL,
        attempts     INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS events_state_idx ON events (state, received_at)",
    );
  }

  /**
   * Atomically record a delivery. Returns claimed:false if the id was already
   * present — the caller must still answer 200, because a duplicate delivery is
   * a successful delivery from Linear's point of view.
   */
  claim(eventId: string, payload: string, now: number = Date.now()): ClaimResult {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO events (id, received_at, state, payload)
       VALUES (?, ?, 'queued', ?)`,
    );
    const result = insert.run(eventId, now, payload);

    if (result.changes === 1) return { claimed: true, state: "queued" };

    const row = this.db
      .prepare("SELECT state FROM events WHERE id = ?")
      .get(eventId) as { state: EventState } | undefined;

    return { claimed: false, state: row?.state ?? "queued" };
  }

  /** Oldest queued event, moved to `running` in the same transaction. */
  nextQueued(): { id: string; payload: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT id, payload FROM events WHERE state = 'queued' ORDER BY received_at LIMIT 1",
      )
      .get() as { id: string; payload: string } | undefined;
    if (!row) return undefined;

    this.db
      .prepare(
        "UPDATE events SET state = 'running', attempts = attempts + 1 WHERE id = ?",
      )
      .run(row.id);
    return row;
  }

  settle(eventId: string, state: Extract<EventState, "done" | "failed">): void {
    this.db.prepare("UPDATE events SET state = ? WHERE id = ?").run(state, eventId);
  }

  /**
   * Return `running` rows older than `staleAfterMs` to `queued`.
   *
   * Without this, a consumer killed mid-run leaves its event stranded in
   * `running` forever and the Linear session ages into `stale` with no
   * explanation. Recovery is a startup concern, not a background nicety.
   */
  requeueStale(staleAfterMs: number, now: number = Date.now()): number {
    const res = this.db
      .prepare(
        "UPDATE events SET state = 'queued' WHERE state = 'running' AND received_at < ?",
      )
      .run(now - staleAfterMs);
    return Number(res.changes);
  }

  count(state?: EventState): number {
    const row = state
      ? (this.db
          .prepare("SELECT COUNT(*) AS n FROM events WHERE state = ?")
          .get(state) as { n: number })
      : (this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number });
    return Number(row.n);
  }

  close(): void {
    this.db.close();
  }
}
