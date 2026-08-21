import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EventStore } from "./store.js";
import { verifySignature, verifyTimestamp } from "./verify.js";

/**
 * Ack-then-queue webhook receiver.
 *
 * Linear gives the handler 5 seconds to return, and expects a `thought` activity
 * within 10 seconds of a `created` event. A coding agent takes minutes. So the
 * handler does exactly four things — read raw body, verify, claim, respond — and
 * every unit of real work happens on the consumer side of the queue.
 *
 * Nothing in this file may await a model call, a Linear mutation, or anything
 * else whose latency it does not control. That restriction is the design.
 */

const MAX_BODY_BYTES = 1_000_000;

export interface ReceiverOptions {
  secret: string;
  store: EventStore;
  /** Injectable for tests. */
  now?: () => number;
}

interface LinearWebhookBody {
  webhookId?: string;
  webhookTimestamp?: number;
  action?: string;
  type?: string;
  agentSession?: { id?: string };
}

/**
 * Identity for dedupe.
 *
 * `webhookId` identifies the webhook *configuration*, not the delivery, so it is
 * not usable alone. Linear sends `Linear-Delivery` per delivery — but a retry of
 * the SAME logical event carries a NEW delivery id, which is precisely the case
 * dedupe must catch. So the key is the semantic event: session + action +
 * timestamp.
 */
export function eventKey(body: LinearWebhookBody): string | undefined {
  const session = body.agentSession?.id;
  if (!session || !body.action || typeof body.webhookTimestamp !== "number") {
    return undefined;
  }
  return `${session}:${body.action}:${body.webhookTimestamp}`;
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createReceiver(opts: ReceiverOptions) {
  const now = opts.now ?? (() => Date.now());

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    let raw: Buffer;
    try {
      raw = await readRawBody(req);
    } catch {
      res.writeHead(413).end();
      return;
    }

    if (!verifySignature(raw, req.headers["linear-signature"] as string, opts.secret)) {
      res.writeHead(401).end();
      return;
    }

    let body: LinearWebhookBody;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }

    if (!verifyTimestamp(body.webhookTimestamp, now())) {
      res.writeHead(400).end();
      return;
    }

    const key = eventKey(body);
    if (!key) {
      res.writeHead(400).end();
      return;
    }

    // A duplicate is still a delivery Linear succeeded at. Answering anything
    // other than 200 earns three more retries at 1m / 1h / 6h.
    opts.store.claim(key, raw.toString("utf8"), now());

    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  };
}

export function startReceiver(opts: ReceiverOptions & { port?: number }) {
  const server = createServer(createReceiver(opts));
  server.listen(opts.port ?? 3000);
  return server;
}
