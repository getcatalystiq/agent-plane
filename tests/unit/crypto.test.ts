import { describe, it, expect } from "vitest";
import {
  generateApiKey,
  hashApiKey,
  encrypt,
  decrypt,
  generateId,
  timingSafeEqual,
} from "@/lib/crypto";

describe("API Key Generation", () => {
  it("generates a key with ap_live_ prefix", () => {
    const { raw, prefix } = generateApiKey();
    expect(raw).toMatch(/^ap_live_[A-Za-z0-9]{32}$/);
    expect(prefix).toMatch(/^ap_live_[A-Za-z0-9]{4}$/);
    expect(raw.startsWith(prefix)).toBe(true);
  });

  it("generates unique keys", () => {
    const key1 = generateApiKey();
    const key2 = generateApiKey();
    expect(key1.raw).not.toBe(key2.raw);
  });
});

describe("API Key Hashing", () => {
  it("produces consistent SHA-256 hash", async () => {
    const { raw } = generateApiKey();
    const hash1 = await hashApiKey(raw);
    const hash2 = await hashApiKey(raw);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces different hashes for different keys", async () => {
    const key1 = generateApiKey();
    const key2 = generateApiKey();
    const hash1 = await hashApiKey(key1.raw);
    const hash2 = await hashApiKey(key2.raw);
    expect(hash1).not.toBe(hash2);
  });
});

describe("AES-256-GCM Encryption", () => {
  const testKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  it("encrypts and decrypts correctly", async () => {
    const plaintext = "my-secret-api-key";
    const encrypted = await encrypt(plaintext, testKey);
    expect(encrypted.version).toBe(1);
    expect(encrypted.iv).toMatch(/^[a-f0-9]{24}$/);
    expect(encrypted.ciphertext.length).toBeGreaterThan(0);

    const decrypted = await decrypt(encrypted, testKey);
    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertext for same plaintext", async () => {
    const plaintext = "same-input";
    const e1 = await encrypt(plaintext, testKey);
    const e2 = await encrypt(plaintext, testKey);
    expect(e1.ciphertext).not.toBe(e2.ciphertext);
  });

  it("supports key rotation via previous key", async () => {
    const oldKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const newKey = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    const encrypted = await encrypt("secret", oldKey);

    // Decrypt with new key + old key as fallback
    const decrypted = await decrypt(encrypted, newKey, oldKey);
    expect(decrypted).toBe("secret");
  });

  it("fails when no valid key is provided", async () => {
    const encrypted = await encrypt("secret", testKey);
    const wrongKey = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    await expect(decrypt(encrypted, wrongKey)).rejects.toThrow("Failed to decrypt");
  });
});

describe("UUID Generation", () => {
  it("generates valid UUIDs", () => {
    const id = generateId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe("Timing-Safe Comparison", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
  });

  it("returns false for different strings", () => {
    expect(timingSafeEqual("abc", "abd")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});
