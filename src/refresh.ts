import type { TokenStore } from "./tokens.js";
import {
  refreshAccessToken,
  isUnrecoverableRefreshError,
  type OAuthConfig,
  type FetchLike,
} from "./oauth.js";

export type RefreshOutcome =
  /** No credentials, no install, or the token is still good — nothing to do. */
  | "skipped"
  /** A refresh was already running, or we are inside a backoff window. */
  | "deferred"
  | "refreshed"
  /** Transient failure; the token is left in place and we will try again. */
  | "failed"
  /** Linear rejected the grant. The stored token has been dropped. */
  | "uninstalled";

export interface RefresherOptions {
  tokens: TokenStore;
  oauth: OAuthConfig;
  doFetch?: FetchLike;
  log?: Pick<Console, "log" | "warn" | "error">;
  /** Exposed for tests; production uses the defaults. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Keeps the stored access token alive.
 *
 * The design constraint is that the token is consumed through a *synchronous*
 * getter — `() => tokens.getToken()?.accessToken` is handed to LinearClient and
 * LinearEmitter at construction. Refreshing is a network call and cannot happen
 * inside that getter, so it happens ahead of time instead: this refresher is ticked
 * by the service loop and keeps the stored row valid, leaving every consumer
 * untouched. Making the getter async would have rippled through both clients, their
 * constructors and their tests to buy nothing.
 *
 * `TokenStore.isExpired` already applies a 60s skew, so a tick refreshes slightly
 * before the real expiry rather than after the first 401.
 */
export class TokenRefresher {
  private inFlight = false;
  private consecutiveFailures = 0;
  private nextAttemptAt = 0;

  private readonly tokens: TokenStore;
  private readonly oauth: OAuthConfig;
  private readonly doFetch?: FetchLike;
  private readonly log: Pick<Console, "log" | "warn" | "error">;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(opts: RefresherOptions) {
    this.tokens = opts.tokens;
    this.oauth = opts.oauth;
    this.doFetch = opts.doFetch;
    this.log = opts.log ?? console;
    this.baseBackoffMs = opts.baseBackoffMs ?? 60_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 15 * 60_000;
  }

  /**
   * One refresh check. Safe to call on a short interval — it returns immediately
   * unless a refresh is actually due.
   */
  async tick(now: number = Date.now()): Promise<RefreshOutcome> {
    // Without credentials there is nothing to refresh with. This is the supported
    // local-run configuration, not an error, so it must stay quiet.
    if (!this.oauth.clientId || !this.oauth.clientSecret) return "skipped";

    const current = this.tokens.getToken();
    if (!current) return "skipped";
    if (!this.tokens.isExpired(now)) return "skipped";

    // Two overlapping refreshes would race to write the same single row, and the
    // loser could persist a token that the winner has already superseded.
    if (this.inFlight) return "deferred";
    if (now < this.nextAttemptAt) return "deferred";

    this.inFlight = true;
    try {
      const next = await refreshAccessToken(this.oauth, current, now, this.doFetch);
      this.tokens.saveToken(next, now);
      this.consecutiveFailures = 0;
      this.nextAttemptAt = 0;
      this.log.log("access token refreshed");
      return "refreshed";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (isUnrecoverableRefreshError(err)) {
        // Linear has rejected the grant itself. Retrying cannot fix that, and
        // leaving the row would make /healthz claim an install that no longer
        // works — so drop it and say so loudly enough to be actionable.
        this.tokens.clearToken();
        this.consecutiveFailures = 0;
        this.nextAttemptAt = 0;
        this.log.error(
          `token refresh rejected (${message}) — install cleared, visit /oauth/authorize to reinstall`,
        );
        return "uninstalled";
      }

      this.consecutiveFailures += 1;
      const backoff = Math.min(
        this.baseBackoffMs * 2 ** (this.consecutiveFailures - 1),
        this.maxBackoffMs,
      );
      this.nextAttemptAt = now + backoff;
      this.log.warn(
        `token refresh failed (${message}); retrying in ${Math.round(backoff / 1000)}s ` +
        `(attempt ${this.consecutiveFailures})`,
      );
      return "failed";
    } finally {
      this.inFlight = false;
    }
  }
}
