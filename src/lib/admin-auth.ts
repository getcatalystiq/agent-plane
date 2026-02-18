import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "admin_session";

// --- HMAC-based session tokens ---
// Instead of storing the raw ADMIN_API_KEY in the cookie, we issue a
// signed session token containing an expiry. Verification re-derives the
// HMAC and checks the signature + expiry. No server-side state needed.

function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getSessionKey(): Promise<CryptoKey> {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) throw new Error("ADMIN_API_KEY not set");
  // Derive a fixed-length key from ADMIN_API_KEY via SHA-256
  const encoded = new TextEncoder().encode(adminKey);
  const hash = await crypto.subtle.digest("SHA-256", encoded.buffer as ArrayBuffer);
  return crypto.subtle.importKey(
    "raw",
    hash,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createAdminSession(): Promise<string> {
  const payload = JSON.stringify({
    jti: crypto.randomUUID(),
    iat: Date.now(),
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
  });
  const encoded = new TextEncoder().encode(payload);
  const key = await getSessionKey();
  const sig = await crypto.subtle.sign("HMAC", key, encoded.buffer as ArrayBuffer);
  return `${base64UrlEncode(encoded)}.${base64UrlEncode(sig)}`;
}

async function verifyAdminSession(token: string): Promise<boolean> {
  try {
    const [payloadB64, sigB64] = token.split(".");
    if (!payloadB64 || !sigB64) return false;

    const payloadBytes = base64UrlDecode(payloadB64);
    const sigBytes = base64UrlDecode(sigB64);

    const key = await getSessionKey();
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes.buffer as ArrayBuffer,
      payloadBytes.buffer as ArrayBuffer,
    );
    if (!valid) return false;

    const data = JSON.parse(new TextDecoder().decode(payloadBytes));
    return typeof data.exp === "number" && Date.now() <= data.exp;
  } catch {
    return false;
  }
}

export async function authenticateAdminFromCookie(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) return false;
  return verifyAdminSession(token);
}

export function setAdminCookie(response: NextResponse, sessionToken: string): void {
  response.cookies.set(COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  });
}

export function clearAdminCookie(response: NextResponse): void {
  response.cookies.delete(COOKIE_NAME);
}
