import { v4 as uuidv4 } from "uuid";

// --- API Key Generation ---

const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62Encode(byteCount: number): string {
  let result = "";
  while (result.length < byteCount) {
    const bytes = new Uint8Array(byteCount - result.length);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      // Rejection sampling: discard bytes >= 248 (= 62 * 4) to avoid modular bias
      if (byte < 248 && result.length < byteCount) {
        result += BASE62_CHARS[byte % 62];
      }
    }
  }
  return result;
}

export function generateApiKey(): { raw: string; prefix: string } {
  const encoded = base62Encode(32);
  const raw = `ap_live_${encoded}`;
  const prefix = `ap_live_${encoded.slice(0, 4)}`;
  return { raw, prefix };
}

export async function hashApiKey(raw: string): Promise<string> {
  const encoded = new TextEncoder().encode(raw);
  const hash = await crypto.subtle.digest("SHA-256", encoded.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --- AES-256-GCM Encryption ---

interface EncryptedData {
  version: number;
  iv: string;
  ciphertext: string;
}

function hexToBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes.buffer as ArrayBuffer;
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function importKey(hexKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    hexToBuffer(hexKey),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encrypt(
  plaintext: string,
  encryptionKey: string,
  version = 1,
): Promise<EncryptedData> {
  const key = await importKey(encryptionKey);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
    key,
    encoded.buffer as ArrayBuffer,
  );

  return {
    version,
    iv: bufferToHex(iv.buffer as ArrayBuffer),
    ciphertext: bufferToHex(encrypted),
  };
}

export async function decrypt(
  data: EncryptedData,
  encryptionKey: string,
  previousKey?: string,
): Promise<string> {
  const keysToTry = [encryptionKey];
  if (previousKey) keysToTry.push(previousKey);

  for (const keyHex of keysToTry) {
    try {
      const key = await importKey(keyHex);
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: hexToBuffer(data.iv) },
        key,
        hexToBuffer(data.ciphertext),
      );
      return new TextDecoder().decode(decrypted);
    } catch {
      continue;
    }
  }

  throw new Error("Failed to decrypt: no valid key");
}

// --- UUID generation ---

export function generateId(): string {
  return uuidv4();
}

// --- Timing-safe comparison ---
// Pads both strings to equal length to prevent length leakage via timing.

export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  const maxLen = Math.max(bufA.length, bufB.length);
  // XOR lengths — non-zero if they differ (checked in constant time below)
  let result = bufA.length ^ bufB.length;
  for (let i = 0; i < maxLen; i++) {
    result |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
  }
  return result === 0;
}
