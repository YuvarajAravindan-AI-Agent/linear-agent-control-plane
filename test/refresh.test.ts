import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TokenStore, type StoredToken } from "../src/tokens.js";
import { TokenRefresher } from "../src/refresh.js";
import {
  refreshAccessToken, isUnrecoverableRefreshError, TokenExchangeError, type FetchLike,
} from "../src/oauth.js";

const cfg = {
  clientId: "cid",
  clientSecret: "csecret",
  redirectUri: "https://example.com/oauth/callback",
};

/** A fetch stub that records what it was called with. */
function stubFetch(status: number, body: string) {
  const calls: Array<{ url: string; body: string }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return Object.assign(fn, { calls });
}

const silent = { log() {}, warn() {}, error() {} };

const existing: StoredToken = {
  accessToken: "old-access",
  refreshToken: "the-refresh-token",
  expiresAt: 1_000,
  scope: "read,write,app:assignable,app:mentionable",
};

describe("refresh grant", () => {
  test("sends grant_type=refresh_token with the stored refresh token", async () => {
    const f = stubFetch(200, JSON.stringify({ access_token: "new-access", expires_in: 86400 }));
    await refreshAccessToken(cfg, existing, 5_000, f);

    const sent = new URLSearchParams(f.calls[0].body);
    assert.equal(f.calls[0].url, "https://api.linear.app/oauth/token");
    assert.equal(sent.get("grant_type"), "refresh_token");
    assert.equal(sent.get("refresh_token"), "the-refresh-token");
    assert.equal(sent.get("client_id"), "cid");
    assert.equal(sent.get("client_secret"), "csecret");
  });

  test("computes the new expiry from expires_in", async () => {
    const f = stubFetch(200, JSON.stringify({ access_token: "new-access", expires_in: 86400 }));
    const next = await refreshAccessToken(cfg, existing, 5_000, f);
    assert.equal(next.accessToken, "new-access");
    assert.equal(next.expiresAt, 5_000 + 86_400_000);
  });

  // The trap this whole function exists to avoid: dropping the refresh token turns a
  // recoverable 24h expiry into a permanent uninstall one day later.
  test("carries the old refresh token forward when the response omits one", async () => {
    const f = stubFetch(200, JSON.stringify({ access_token: "new-access", expires_in: 86400 }));
    const next = await refreshAccessToken(cfg, existing, 5_000, f);
    assert.equal(next.refreshToken, "the-refresh-token");
  });

  test("prefers a rotated refresh token when one is returned", async () => {
    const f = stubFetch(200, JSON.stringify({
      access_token: "new-access", refresh_token: "rotated", expires_in: 86400,
    }));
    const next = await refreshAccessToken(cfg, existing, 5_000, f);
    assert.equal(next.refreshToken, "rotated");
  });

  test("keeps the previous scope when the response omits it", async () => {
    const f = stubFetch(200, JSON.stringify({ access_token: "new-access", expires_in: 86400 }));
    const next = await refreshAccessToken(cfg, existing, 5_000, f);
    assert.equal(next.scope, existing.scope);
  });

  test("refuses when there is no refresh token to spend", async () => {
    const f = stubFetch(200, "{}");
    await assert.rejects(
      () => refreshAccessToken(cfg, { ...existing, refreshToken: undefined }, 0, f),
      TokenExchangeError,
    );
    assert.equal(f.calls.length, 0, "must not call the network without a refresh token");
  });

  test("throws on a non-2xx response", async () => {
    const f = stubFetch(400, '{"error":"invalid_grant"}');
    await assert.rejects(() => refreshAccessToken(cfg, existing, 0, f), TokenExchangeError);
  });
});

describe("refresh error classification", () => {
  test("400 and 401 are unrecoverable — the grant itself was rejected", () => {
    assert.equal(isUnrecoverableRefreshError(new TokenExchangeError(400, "")), true);
    assert.equal(isUnrecoverableRefreshError(new TokenExchangeError(401, "")), true);
  });

  test("5xx is recoverable — Linear being down is not an uninstall", () => {
    assert.equal(isUnrecoverableRefreshError(new TokenExchangeError(500, "")), false);
    assert.equal(isUnrecoverableRefreshError(new TokenExchangeError(503, "")), false);
  });

  test("a non-TokenExchangeError (eg a dropped socket) is recoverable", () => {
    assert.equal(isUnrecoverableRefreshError(new Error("ECONNRESET")), false);
  });
});

describe("TokenRefresher", () => {
  let dir: string;
  let n = 0;
  before(() => { dir = mkdtempSync(join(tmpdir(), "lacp-refresh-")); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  const store = () => new TokenStore(join(dir, `r${n++}.db`));

  test("does nothing without OAuth credentials — the supported local-run case", async () => {
    const s = store();
    s.saveToken(existing);
    const f = stubFetch(200, "{}");
    const r = new TokenRefresher({
      tokens: s, oauth: { ...cfg, clientId: "", clientSecret: "" }, doFetch: f, log: silent,
    });
    assert.equal(await r.tick(10_000_000), "skipped");
    assert.equal(f.calls.length, 0);
    s.close();
  });

  test("does nothing when nothing is installed", async () => {
    const s = store();
    const f = stubFetch(200, "{}");
    const r = new TokenRefresher({ tokens: s, oauth: cfg, doFetch: f, log: silent });
    assert.equal(await r.tick(), "skipped");
    assert.equal(f.calls.length, 0);
    s.close();
  });

  test("does nothing while the token is still good", async () => {
    const s = store();
    s.saveToken({ ...existing, expiresAt: 10_000_000 });
    const f = stubFetch(200, "{}");
    const r = new TokenRefresher({ tokens: s, oauth: cfg, doFetch: f, log: silent });
    assert.equal(await r.tick(1_000), "skipped");
    assert.equal(f.calls.length, 0);
    s.close();
  });

  // isExpired applies a 60s skew, so a token with 30s left must already refresh.
  test("refreshes inside the skew window, before the token is actually dead", async () => {
    const s = store();
    const now = 1_000_000;
    s.saveToken({ ...existing, expiresAt: now + 30_000 });
    const f = stubFetch(200, JSON.stringify({ access_token: "fresh", expires_in: 86400 }));
    const r = new TokenRefresher({ tokens: s, oauth: cfg, doFetch: f, log: silent });

    assert.equal(await r.tick(now), "refreshed");
    assert.equal(s.getToken()!.accessToken, "fresh");
    s.close();
  });

  test("persists the refreshed token, keeping the refresh credential", async () => {
    const s = store();
    s.saveToken({ ...existing, expiresAt: 1_000 });
    const f = stubFetch(200, JSON.stringify({ access_token: "fresh", expires_in: 86400 }));
    const r = new TokenRefresher({ tokens: s, oauth: cfg, doFetch: f, log: silent });

    await r.tick(2_000);
    const saved = s.getToken()!;
    assert.equal(saved.accessToken, "fresh");
    assert.equal(saved.refreshToken, "the-refresh-token");
    assert.equal(saved.expiresAt, 2_000 + 86_400_000);
    s.close();
  });

  test("a rejected grant clears the install so /healthz cannot report a false yes", async () => {
    const s = store();
    s.saveToken({ ...existing, expiresAt: 1_000 });
    const f = stubFetch(400, '{"error":"invalid_grant"}');
    const r = new TokenRefresher({ tokens: s, oauth: cfg, doFetch: f, log: silent });

    assert.equal(await r.tick(2_000), "uninstalled");
    assert.equal(s.getToken(), undefined);
    s.close();
  });

  test("a transient failure leaves the token in place for the next attempt", async () => {
    const s = store();
    s.saveToken({ ...existing, expiresAt: 1_000 });
    const f = stubFetch(503, "upstream unavailable");
    const r = new TokenRefresher({ tokens: s, oauth: cfg, doFetch: f, log: silent });

    assert.equal(await r.tick(2_000), "failed");
    assert.equal(s.getToken()!.accessToken, "old-access", "must not discard a usable token");
    s.close();
  });

  test("backs off after a failure instead of hammering on every tick", async () => {
    const s = store();
    s.saveToken({ ...existing, expiresAt: 1_000 });
    const f = stubFetch(503, "nope");
    const r = new TokenRefresher({
      tokens: s, oauth: cfg, doFetch: f, log: silent, baseBackoffMs: 1_000, maxBackoffMs: 10_000,
    });

    assert.equal(await r.tick(2_000), "failed");
    assert.equal(await r.tick(2_500), "deferred", "still inside the backoff window");
    assert.equal(f.calls.length, 1, "no second network call during backoff");

    assert.equal(await r.tick(3_100), "failed", "window elapsed, tries again");
    assert.equal(f.calls.length, 2);
    s.close();
  });

  test("backoff grows and is capped", async () => {
    const s = store();
    s.saveToken({ ...existing, expiresAt: 1_000 });
    const f = stubFetch(503, "nope");
    const r = new TokenRefresher({
      tokens: s, oauth: cfg, doFetch: f, log: silent, baseBackoffMs: 1_000, maxBackoffMs: 3_000,
    });

    let t = 2_000;
    await r.tick(t);            // fail 1 -> 1s
    t += 1_100; await r.tick(t); // fail 2 -> 2s
    t += 2_100; await r.tick(t); // fail 3 -> capped at 3s
    t += 2_000;
    assert.equal(await r.tick(t), "deferred", "cap must still be honoured");
    t += 1_100;
    assert.equal(await r.tick(t), "failed");
    s.close();
  });

  test("a success after failures clears the backoff", async () => {
    const s = store();
    s.saveToken({ ...existing, expiresAt: 1_000 });
    let status = 503;
    let body = "nope";
    const f = (async () => ({
      ok: status >= 200 && status < 300, status, text: async () => body,
    })) as FetchLike;
    const r = new TokenRefresher({
      tokens: s, oauth: cfg, doFetch: f, log: silent, baseBackoffMs: 1_000,
    });

    assert.equal(await r.tick(2_000), "failed");
    status = 200;
    body = JSON.stringify({ access_token: "fresh", expires_in: 86400 });
    assert.equal(await r.tick(3_100), "refreshed");

    // Expire it again immediately: a lingering backoff would defer this.
    s.saveToken({ ...existing, accessToken: "fresh", expiresAt: 3_200 });
    assert.equal(await r.tick(3_200), "refreshed", "backoff must have been reset");
    s.close();
  });

  test("concurrent ticks do not both hit the network", async () => {
    const s = store();
    s.saveToken({ ...existing, expiresAt: 1_000 });
    let calls = 0;
    const f = (async () => {
      calls += 1;
      await new Promise((res) => setTimeout(res, 20));
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ access_token: "fresh", expires_in: 86400 }),
      };
    }) as FetchLike;
    const r = new TokenRefresher({ tokens: s, oauth: cfg, doFetch: f, log: silent });

    const [a, b] = await Promise.all([r.tick(2_000), r.tick(2_000)]);
    assert.equal(calls, 1, "the single-row token must not be written by two racers");
    assert.deepEqual([a, b].sort(), ["deferred", "refreshed"]);
    s.close();
  });
});
