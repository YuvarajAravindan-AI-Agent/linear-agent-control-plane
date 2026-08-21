import { DatabaseSync } from "node:sqlite";
import { randomBytes, timingSafeEqual } from "node:crypto";

export interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. Linear access tokens last 24h. */
  expiresAt?: number;
  scope: string;
}

/**
 * OAuth state and token persistence.
 *
 * State lives on disk rather than in memory for the same reason the webhook dedupe
 * does: the callback can arrive after a restart, and an in-memory state map turns
 * that into a spurious CSRF rejection.
 */
export class TokenStore {
  private db: DatabaseSync;

  constructor(path: string = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_states (
        state      TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        access_token  TEXT NOT NULL,
        refresh_token TEXT,
        expires_at    INTEGER,
        scope         TEXT NOT NULL,
        updated_at    INTEGER NOT NULL
      )
    `);
  }

  /** 64 hex chars from a CSPRNG — not Math.random, which is trivially predictable. */
  issueState(now: number = Date.now()): string {
    const state = randomBytes(32).toString("hex");
    this.db
      .prepare("INSERT INTO oauth_states (state, created_at) VALUES (?, ?)")
      .run(state, now);
    return state;
  }

  /**
   * Validate and burn a state value.
   *
   * Single-use and time-boxed: a replayed callback must fail even if the value was
   * genuine, and a state left over from an abandoned attempt must not stay valid
   * indefinitely. Compared with timingSafeEqual against the stored row.
   */
  consumeState(candidate: string, now: number = Date.now(), ttlMs = 10 * 60_000): boolean {
    const row = this.db
      .prepare("SELECT state, created_at FROM oauth_states WHERE state = ?")
      .get(candidate) as { state: string; created_at: number } | undefined;

    if (!row) return false;

    // Burn it regardless of the outcome below — a state that has been presented
    // once is spent, valid or not.
    this.db.prepare("DELETE FROM oauth_states WHERE state = ?").run(candidate);

    if (now - row.created_at > ttlMs) return false;

    const a = Buffer.from(row.state, "utf8");
    const b = Buffer.from(candidate, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  purgeExpiredStates(now: number = Date.now(), ttlMs = 10 * 60_000): number {
    const res = this.db
      .prepare("DELETE FROM oauth_states WHERE created_at < ?")
      .run(now - ttlMs);
    return Number(res.changes);
  }

  /** Single-row table: installing again replaces the previous token. */
  saveToken(token: StoredToken, now: number = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, scope, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           scope = excluded.scope,
           updated_at = excluded.updated_at`,
      )
      .run(
        token.accessToken,
        token.refreshToken ?? null,
        token.expiresAt ?? null,
        token.scope,
        now,
      );
  }

  getToken(): StoredToken | undefined {
    const row = this.db
      .prepare("SELECT access_token, refresh_token, expires_at, scope FROM oauth_tokens WHERE id = 1")
      .get() as
      | { access_token: string; refresh_token: string | null; expires_at: number | null; scope: string }
      | undefined;
    if (!row) return undefined;
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token ?? undefined,
      expiresAt: row.expires_at ?? undefined,
      scope: row.scope,
    };
  }

  /** Treat a token as expired slightly early, so a call cannot start on a live token
   *  and land on a dead one. */
  isExpired(now: number = Date.now(), skewMs = 60_000): boolean {
    const t = this.getToken();
    if (!t) return true;
    if (t.expiresAt === undefined) return false;
    return now >= t.expiresAt - skewMs;
  }

  close(): void {
    this.db.close();
  }
}
