import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EventStore } from "./store.js";
import { TokenStore } from "./tokens.js";
import { createReceiver } from "./receiver.js";
import { buildAuthorizeUrl, exchangeCode, type OAuthConfig, type FetchLike } from "./oauth.js";

export interface AppOptions {
  webhookSecret: string;
  events: EventStore;
  tokens: TokenStore;
  oauth: OAuthConfig;
  now?: () => number;
  doFetch?: FetchLike;
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(
    `<!doctype html><meta charset="utf-8"><title>Agent Control Plane</title>` +
      `<body style="font:16px/1.5 system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">${body}</body>`,
  );
}

export function createApp(opts: AppOptions) {
  const now = opts.now ?? (() => Date.now());
  const handleWebhook = createReceiver({
    secret: opts.webhookSecret,
    store: opts.events,
    now,
  });

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/webhook") return handleWebhook(req, res);

    if (url.pathname === "/healthz" && req.method === "GET") {
      const installed = opts.tokens.getToken() !== undefined;
      res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, installed }));
      return;
    }

    // A missing client secret disables installation but must NOT take webhook
    // ingress down with it. Degrade the feature that cannot work, keep serving
    // the one that can.
    if (url.pathname.startsWith("/oauth/") && !opts.oauth.clientSecret) {
      return html(res, 503,
        "<h1>Not configured</h1><p>Set <code>LINEAR_CLIENT_SECRET</code> and restart to enable installation.</p>");
    }

    // Kicks off installation. Visited by a human in a browser, once.
    if (url.pathname === "/oauth/authorize" && req.method === "GET") {
      opts.tokens.purgeExpiredStates(now());
      const state = opts.tokens.issueState(now());
      res.writeHead(302, { location: buildAuthorizeUrl(opts.oauth, state) }).end();
      return;
    }

    if (url.pathname === "/oauth/callback" && req.method === "GET") {
      const error = url.searchParams.get("error");
      if (error) {
        // The user declined, or Linear rejected the request.
        return html(res, 400, `<h1>Authorization declined</h1><p>Linear returned <code>${
          error.replace(/[<>&]/g, "")
        }</code>.</p>`);
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) return html(res, 400, "<h1>Missing code or state</h1>");

      // CSRF check before spending the code. A forged callback must not reach
      // the token endpoint at all.
      if (!opts.tokens.consumeState(state, now())) {
        return html(res, 400,
          "<h1>Invalid or expired state</h1><p>Start again from <code>/oauth/authorize</code>.</p>");
      }

      try {
        const token = await exchangeCode(opts.oauth, code, now(), opts.doFetch);
        opts.tokens.saveToken(token, now());
        return html(res, 200,
          `<h1>Installed</h1><p>Agent Control Plane is now an app user in this workspace.</p>
           <p>Scopes: <code>${token.scope.replace(/[<>&]/g, "")}</code></p>
           <p>Assign an issue to it, or @-mention it, to open an agent session.</p>`);
      } catch (err) {
        // Never render the error body — it can contain the client secret if the
        // request was malformed.
        console.error("token exchange failed:", err);
        return html(res, 502, "<h1>Token exchange failed</h1><p>See server logs.</p>");
      }
    }

    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  };
}

export function startApp(opts: AppOptions & { port?: number }) {
  const server = createServer((req, res) => {
    void createApp(opts)(req, res);
  });
  server.listen(opts.port ?? 3000);
  return server;
}
