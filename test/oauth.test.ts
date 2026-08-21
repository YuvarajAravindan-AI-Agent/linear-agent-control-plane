import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { TokenStore } from "../src/tokens.js";
import { EventStore } from "../src/store.js";
import { startApp } from "../src/app.js";
import {
  buildAuthorizeUrl, exchangeCode, AGENT_SCOPES, TokenExchangeError, type FetchLike,
} from "../src/oauth.js";

const cfg = {
  clientId: "cid",
  clientSecret: "csecret",
  redirectUri: "https://example.com/oauth/callback",
};

describe("authorize url", () => {
  const url = new URL(buildAuthorizeUrl(cfg, "st4te"));

  test("targets Linear's authorize endpoint", () => {
    assert.equal(url.origin + url.pathname, "https://linear.app/oauth/authorize");
  });

  test("carries actor=app — without it the token acts as the user, not the app", () => {
    assert.equal(url.searchParams.get("actor"), "app");
  });

  test("requests the scopes an assignable, mentionable agent needs", () => {
    const scopes = url.searchParams.get("scope")!.split(",");
    for (const s of AGENT_SCOPES) assert.ok(scopes.includes(s), `missing scope ${s}`);
  });

  test("passes state and the exact redirect uri", () => {
    assert.equal(url.searchParams.get("state"), "st4te");
    assert.equal(url.searchParams.get("redirect_uri"), cfg.redirectUri);
    assert.equal(url.searchParams.get("response_type"), "code");
  });
});

describe("state handling", () => {
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), "lacp-oauth-")); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test("states are 64 hex chars and unique", () => {
    const s = new TokenStore(join(dir, "a.db"));
    const a = s.issueState(), b = s.issueState();
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, b);
    s.close();
  });

  test("a state is single-use", () => {
    const s = new TokenStore(join(dir, "b.db"));
    const st = s.issueState(1000);
    assert.equal(s.consumeState(st, 1000), true);
    assert.equal(s.consumeState(st, 1000), false, "replay must fail");
    s.close();
  });

  test("an unknown state is rejected", () => {
    const s = new TokenStore(join(dir, "c.db"));
    assert.equal(s.consumeState("f".repeat(64), 1000), false);
    s.close();
  });

  test("a stale state is rejected and burned", () => {
    const s = new TokenStore(join(dir, "d.db"));
    const st = s.issueState(0);
    assert.equal(s.consumeState(st, 11 * 60_000), false, "past the 10 minute ttl");
    s.close();
  });

  test("state survives a restart — the callback can outlive the process", () => {
    const path = join(dir, "e.db");
    const first = new TokenStore(path);
    const st = first.issueState(1000);
    first.close();

    const second = new TokenStore(path);
    assert.equal(second.consumeState(st, 2000), true,
      "an in-memory state map would reject this as CSRF");
    second.close();
  });
});

describe("token exchange", () => {
  const okFetch: FetchLike = async (_url, init) => {
    const params = new URLSearchParams(init.body);
    assert.equal(params.get("grant_type"), "authorization_code");
    assert.equal(params.get("redirect_uri"), cfg.redirectUri, "must match authorize exactly");
    assert.equal(params.get("client_secret"), cfg.clientSecret);
    assert.equal(init.headers["content-type"], "application/x-www-form-urlencoded");
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        access_token: "tok_123", refresh_token: "ref_456",
        expires_in: 86400, scope: "read,write,app:assignable,app:mentionable",
      }),
    };
  };

  test("posts form-encoded and returns a token with an absolute expiry", async () => {
    const t = await exchangeCode(cfg, "the-code", 1_000_000, okFetch);
    assert.equal(t.accessToken, "tok_123");
    assert.equal(t.refreshToken, "ref_456");
    assert.equal(t.expiresAt, 1_000_000 + 86_400_000, "24h, stored absolute not relative");
  });

  test("a non-2xx response throws rather than returning a broken token", async () => {
    const bad: FetchLike = async () => ({ ok: false, status: 400, text: async () => "invalid_grant" });
    await assert.rejects(() => exchangeCode(cfg, "c", 0, bad), TokenExchangeError);
  });

  test("a 200 with no access_token still throws", async () => {
    const weird: FetchLike = async () => ({ ok: true, status: 200, text: async () => "{}" });
    await assert.rejects(() => exchangeCode(cfg, "c", 0, weird), /no access_token/);
  });

  test("expiry is treated as due slightly early", () => {
    const s = new TokenStore(":memory:");
    s.saveToken({ accessToken: "t", scope: "read", expiresAt: 100_000 }, 0);
    assert.equal(s.isExpired(30_000), false);
    assert.equal(s.isExpired(50_000), true, "60s skew — do not start a call on a dying token");
    s.close();
  });
});

describe("install flow over HTTP", () => {
  let dir: string, events: EventStore, tokens: TokenStore;
  let server: ReturnType<typeof startApp>, base: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "lacp-app-"));
    const db = join(dir, "app.db");
    events = new EventStore(db);
    tokens = new TokenStore(db);
    server = startApp({
      webhookSecret: "whsec", events, tokens, port: 0,
      oauth: cfg,
      doFetch: async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({
          access_token: "tok_live", expires_in: 86400, scope: "read,write",
        }),
      }),
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => { server.close(); events.close(); tokens.close(); rmSync(dir, { recursive: true, force: true }); });

  test("/healthz reports not-installed before the flow runs", async () => {
    const res = await fetch(`${base}/healthz`);
    assert.deepEqual(await res.json(), { ok: true, installed: false });
  });

  test("/oauth/authorize redirects to Linear with actor=app", async () => {
    const res = await fetch(`${base}/oauth/authorize`, { redirect: "manual" });
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get("location")!);
    assert.equal(loc.origin, "https://linear.app");
    assert.equal(loc.searchParams.get("actor"), "app");
  });

  test("a callback with a forged state is refused before any token exchange", async () => {
    const res = await fetch(`${base}/oauth/callback?code=x&state=${"a".repeat(64)}`);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Invalid or expired state/);
    assert.equal(tokens.getToken(), undefined, "nothing stored");
  });

  test("a declined authorization renders the reason, not a crash", async () => {
    const res = await fetch(`${base}/oauth/callback?error=access_denied`);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /access_denied/);
  });

  test("the happy path stores a token and flips /healthz to installed", async () => {
    const authorize = await fetch(`${base}/oauth/authorize`, { redirect: "manual" });
    const state = new URL(authorize.headers.get("location")!).searchParams.get("state")!;

    const cb = await fetch(`${base}/oauth/callback?code=real-code&state=${state}`);
    assert.equal(cb.status, 200);
    assert.match(await cb.text(), /Installed/);

    assert.equal(tokens.getToken()?.accessToken, "tok_live");
    assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true, installed: true });
  });

  test("replaying that same callback fails — the state was burned", async () => {
    const authorize = await fetch(`${base}/oauth/authorize`, { redirect: "manual" });
    const state = new URL(authorize.headers.get("location")!).searchParams.get("state")!;
    await fetch(`${base}/oauth/callback?code=c&state=${state}`);

    const replay = await fetch(`${base}/oauth/callback?code=c&state=${state}`);
    assert.equal(replay.status, 400);
  });

  test("the webhook route still works alongside the OAuth routes", async () => {
    const res = await fetch(`${base}/webhook`, { method: "POST", body: "{}" });
    assert.equal(res.status, 401, "unsigned is still rejected");
  });

  test("unknown paths 404", async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});

describe("degraded mode — no client secret", () => {
  let dir: string, events: EventStore, tokens: TokenStore;
  let server: ReturnType<typeof startApp>, base: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "lacp-degraded-"));
    const db = join(dir, "d.db");
    events = new EventStore(db);
    tokens = new TokenStore(db);
    server = startApp({
      webhookSecret: "whsec", events, tokens, port: 0,
      oauth: { ...cfg, clientSecret: "" },
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => { server.close(); events.close(); tokens.close(); rmSync(dir, { recursive: true, force: true }); });

  test("webhook ingress stays up — the important half keeps working", async () => {
    const res = await fetch(`${base}/webhook`, { method: "POST", body: "{}" });
    assert.equal(res.status, 401, "still verifying signatures, still serving");
  });

  test("/oauth/* explains itself with 503 instead of redirecting into a dead end", async () => {
    const res = await fetch(`${base}/oauth/authorize`, { redirect: "manual" });
    assert.equal(res.status, 503);
    assert.match(await res.text(), /LINEAR_CLIENT_SECRET/);
  });
});
