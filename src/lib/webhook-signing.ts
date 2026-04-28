import { timingSafeEqual } from "./crypto";

const DEFAULT_TOLERANCE_SECONDS = 300;
const SIGNATURE_PREFIX = "sha256=";

export interface VerifyResult {
  valid: boolean;
  reason?: "malformed" | "mismatch" | "stale";
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret).buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await importHmacKey(secret);
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message).buffer as ArrayBuffer,
  );
  return bufferToHex(signed);
}

/** Sign in our canonical `sha256=<hex>` format using `${timestamp}.${body}`. */
export async function signPayload(
  secret: string,
  timestamp: string,
  rawBody: string,
): Promise<string> {
  return `${SIGNATURE_PREFIX}${await hmacHex(secret, `${timestamp}.${rawBody}`)}`;
}

/**
 * Verify a webhook signature, auto-detecting format from the signature shape:
 *
 *   `sha256=<hex>`  → our canonical "prefixed" format. Body+timestamp.
 *                     Stale check enforced (5min tolerance).
 *   `t=<ts>,v1=<hex>` → Stripe-style. Body+timestamp embedded in the sig.
 *                       Stale check enforced.
 *   `<hex>` (64 chars) → Raw HMAC. Body only, no timestamp.
 *                        Used by Linear, Vercel, Sentry, GitHub-old.
 *                        No stale check (signers don't include a timestamp).
 *
 * The `timestamp` arg is the `webhook-timestamp` header value; only used by
 * the prefixed format. Stripe parses its own timestamp from the signature.
 */
export async function verifySignature(
  secret: string,
  signature: string,
  timestamp: string,
  rawBody: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): Promise<VerifyResult> {
  if (!signature) return { valid: false, reason: "malformed" };

  // Stripe-style: `t=<ts>,v1=<hex>` (and possibly other v* schemes).
  if (signature.startsWith("t=")) {
    const parts = Object.fromEntries(
      signature.split(",").map((kv) => {
        const idx = kv.indexOf("=");
        return idx === -1 ? [kv, ""] : [kv.slice(0, idx), kv.slice(idx + 1)];
      }),
    );
    const ts = parts.t;
    const sig = parts.v1;
    if (!ts || !sig) return { valid: false, reason: "malformed" };
    const tsNum = Number.parseInt(ts, 10);
    if (!Number.isFinite(tsNum) || tsNum <= 0) return { valid: false, reason: "malformed" };
    if (Math.abs(Math.floor(Date.now() / 1000) - tsNum) > toleranceSeconds) {
      return { valid: false, reason: "stale" };
    }
    const expected = await hmacHex(secret, `${ts}.${rawBody}`);
    return timingSafeEqual(expected, sig) ? { valid: true } : { valid: false, reason: "mismatch" };
  }

  // Canonical prefixed: `sha256=<hex>` over `${timestamp}.${body}`.
  if (signature.startsWith(SIGNATURE_PREFIX)) {
    const tsNum = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(tsNum) || tsNum <= 0) return { valid: false, reason: "malformed" };
    if (Math.abs(Math.floor(Date.now() / 1000) - tsNum) > toleranceSeconds) {
      return { valid: false, reason: "stale" };
    }
    const expected = await signPayload(secret, timestamp, rawBody);
    return timingSafeEqual(expected, signature) ? { valid: true } : { valid: false, reason: "mismatch" };
  }

  // Raw hex HMAC of body only. No timestamp → no staleness check available.
  if (/^[a-f0-9]{64}$/i.test(signature)) {
    const expected = await hmacHex(secret, rawBody);
    return timingSafeEqual(expected.toLowerCase(), signature.toLowerCase())
      ? { valid: true }
      : { valid: false, reason: "mismatch" };
  }

  return { valid: false, reason: "malformed" };
}

export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `whsec_${hex}`;
}
