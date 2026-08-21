import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Linear signs the RAW request body with HMAC-SHA256 and sends the hex digest in
 * the `Linear-Signature` header.
 *
 * The raw bytes matter: verifying against `JSON.stringify(JSON.parse(body))` will
 * fail for any payload whose key order or number formatting differs after a
 * round-trip. The receiver therefore never parses before it verifies.
 */
export function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

  // timingSafeEqual throws on length mismatch, which would itself leak a bit of
  // information via the exception path — compare lengths first, in constant order.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader, "utf8");
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

export const TIMESTAMP_TOLERANCE_MS = 60_000;

/**
 * Replay guard. Linear puts `webhookTimestamp` (Unix ms) in the payload and asks
 * that it be within a minute of local time.
 *
 * Deliberately two-sided: a timestamp far in the FUTURE is just as suspect as an
 * old one, and a one-sided `now - ts < tolerance` check accepts it silently.
 */
export function verifyTimestamp(
  webhookTimestamp: number | undefined,
  now: number = Date.now(),
  toleranceMs: number = TIMESTAMP_TOLERANCE_MS,
): boolean {
  if (typeof webhookTimestamp !== "number" || !Number.isFinite(webhookTimestamp)) {
    return false;
  }
  return Math.abs(now - webhookTimestamp) <= toleranceMs;
}
