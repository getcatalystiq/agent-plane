/**
 * Shared HMAC-SHA256 state token utilities for OAuth CSRF protection.
 *
 * Used by both Composio OAuth (oauth-state.ts) and MCP OAuth (mcp-oauth-state.ts)
 * to sign/verify URL-safe state parameters.
 */

import { getEnv } from "./env";

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function getHmacKey(): Promise<CryptoKey> {
  const env = getEnv();
  const hex = env.ENCRYPTION_KEY;
  const keyBytes = new Uint8Array(hex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/**
 * Sign an arbitrary payload as a URL-safe HMAC token: base64url(payload).base64url(signature)
 */
export async function signState(payload: Record<string, unknown>): Promise<string> {
  const data = JSON.stringify({ ...payload, exp: Date.now() + STATE_TTL_MS });
  const encoded = new TextEncoder().encode(data);
  const key = await getHmacKey();
  const sig = await crypto.subtle.sign("HMAC", key, encoded.buffer as ArrayBuffer);
  return `${base64UrlEncode(encoded)}.${base64UrlEncode(sig)}`;
}

/**
 * Verify a signed state token. Returns the raw parsed payload if valid, null otherwise.
 */
export async function verifyState(state: string): Promise<Record<string, unknown> | null> {
  try {
    const [payloadB64, sigB64] = state.split(".");
    if (!payloadB64 || !sigB64) return null;

    const payloadBytes = base64UrlDecode(payloadB64);
    const sigBytes = base64UrlDecode(sigB64);

    const key = await getHmacKey();
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes.buffer as ArrayBuffer,
      payloadBytes.buffer as ArrayBuffer,
    );
    if (!valid) return null;

    const data = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (typeof data.exp !== "number" || Date.now() > data.exp) return null;

    return data;
  } catch {
    return null;
  }
}
