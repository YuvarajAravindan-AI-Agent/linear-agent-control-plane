import type { StoredToken } from "./tokens.js";

export const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
export const TOKEN_URL = "https://api.linear.app/oauth/token";

/**
 * `app:assignable` is what lets a human drag an issue onto the agent, and
 * `app:mentionable` is what lets them @-mention it. Without both, the app installs
 * fine and then never receives a single AgentSessionEvent — the failure is silent,
 * which is why they are pinned here rather than left to configuration.
 */
export const AGENT_SCOPES = ["read", "write", "app:assignable", "app:mentionable"] as const;

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function buildAuthorizeUrl(cfg: OAuthConfig, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", AGENT_SCOPES.join(","));
  url.searchParams.set("state", state);
  // The whole point: install as an app user, so actions come from the app rather
  // than from whoever happened to click authorize.
  url.searchParams.set("actor", "app");
  return url.toString();
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string | string[];
  token_type?: string;
}

export class TokenExchangeError extends Error {
  constructor(public readonly status: number, body: string) {
    // Deliberately truncated: the body can echo request parameters, and this
    // string ends up in logs.
    super(`token exchange failed (${status}): ${body.slice(0, 200)}`);
    this.name = "TokenExchangeError";
  }
}

/** `fetch` is injectable so the exchange is testable without network. */
export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export async function exchangeCode(
  cfg: OAuthConfig,
  code: string,
  now: number = Date.now(),
  doFetch: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<StoredToken> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    // Linear requires redirect_uri again at exchange, and it must match the
    // authorize call byte for byte or the exchange 400s.
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  }).toString();

  const res = await doFetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();
  if (!res.ok) throw new TokenExchangeError(res.status, text);

  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TokenExchangeError(res.status, `non-JSON response: ${text}`);
  }

  if (!parsed.access_token) {
    throw new TokenExchangeError(res.status, "response contained no access_token");
  }

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: parsed.expires_in ? now + parsed.expires_in * 1000 : undefined,
    scope: Array.isArray(parsed.scope) ? parsed.scope.join(",") : (parsed.scope ?? ""),
  };
}

/**
 * Trade a refresh token for a fresh access token.
 *
 * Linear's access tokens last 24h, which means an install left alone overnight is
 * dead by morning — the failure mode this exists to remove is a demo that opens by
 * re-running the install flow in front of whoever is watching.
 *
 * `previous` is required rather than optional because of the trap below: the
 * response is not guaranteed to carry a new refresh token, and treating an absent
 * one as `undefined` silently discards the only credential that can refresh again.
 * That converts a recoverable 24h expiry into a permanent uninstall, one day later,
 * with nothing in the logs connecting the two.
 */
export async function refreshAccessToken(
  cfg: OAuthConfig,
  previous: StoredToken,
  now: number = Date.now(),
  doFetch: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<StoredToken> {
  if (!previous.refreshToken) {
    throw new TokenExchangeError(0, "stored token has no refresh_token — reinstall required");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: previous.refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  }).toString();

  const res = await doFetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();
  if (!res.ok) throw new TokenExchangeError(res.status, text);

  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TokenExchangeError(res.status, `non-JSON response: ${text}`);
  }

  if (!parsed.access_token) {
    throw new TokenExchangeError(res.status, "response contained no access_token");
  }

  return {
    accessToken: parsed.access_token,
    // Carry the old refresh token forward when the response omits one.
    refreshToken: parsed.refresh_token ?? previous.refreshToken,
    expiresAt: parsed.expires_in ? now + parsed.expires_in * 1000 : undefined,
    // Same reasoning for scope: an omitted scope means unchanged, not empty.
    scope: Array.isArray(parsed.scope)
      ? parsed.scope.join(",")
      : (parsed.scope ?? previous.scope),
  };
}

/**
 * A refresh failure is not automatically fatal — a 500 or a dropped connection is
 * worth retrying, while a 400/401 means Linear has rejected the grant itself and no
 * amount of retrying will help. Only the latter should surface as "not installed".
 */
export function isUnrecoverableRefreshError(err: unknown): boolean {
  if (!(err instanceof TokenExchangeError)) return false;
  // status 0 is the local "no refresh token stored" case above.
  return err.status === 0 || err.status === 400 || err.status === 401;
}
