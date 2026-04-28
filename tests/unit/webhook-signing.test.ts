import { describe, it, expect } from "vitest";
import {
  signPayload,
  verifySignature,
  generateWebhookSecret,
} from "@/lib/webhook-signing";

const SECRET = "whsec_unit_test_secret";

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe("signPayload", () => {
  it("returns sha256-prefixed hex signatures", async () => {
    const sig = await signPayload(SECRET, "1700000000", '{"hello":"world"}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("is deterministic for same secret + timestamp + body", async () => {
    const a = await signPayload(SECRET, "1700000000", '{"hello":"world"}');
    const b = await signPayload(SECRET, "1700000000", '{"hello":"world"}');
    expect(a).toBe(b);
  });

  it("produces different signatures for different bodies", async () => {
    const a = await signPayload(SECRET, "1700000000", "a");
    const b = await signPayload(SECRET, "1700000000", "b");
    expect(a).not.toBe(b);
  });

  it("produces different signatures for different timestamps", async () => {
    const a = await signPayload(SECRET, "1700000000", "x");
    const b = await signPayload(SECRET, "1700000001", "x");
    expect(a).not.toBe(b);
  });

  it("produces different signatures for different secrets", async () => {
    const a = await signPayload(SECRET, "1700000000", "x");
    const b = await signPayload("whsec_other", "1700000000", "x");
    expect(a).not.toBe(b);
  });
});

describe("verifySignature", () => {
  it("accepts a fresh, correctly signed payload", async () => {
    const ts = nowSeconds();
    const body = '{"event":"ping"}';
    const sig = await signPayload(SECRET, ts, body);
    const result = await verifySignature(SECRET, sig, ts, body);
    expect(result).toEqual({ valid: true });
  });

  it("rejects signature with wrong secret", async () => {
    const ts = nowSeconds();
    const body = "x";
    const sig = await signPayload("other_secret", ts, body);
    const result = await verifySignature(SECRET, sig, ts, body);
    expect(result).toEqual({ valid: false, reason: "mismatch" });
  });

  it("rejects signature for tampered body", async () => {
    const ts = nowSeconds();
    const sig = await signPayload(SECRET, ts, "original");
    const result = await verifySignature(SECRET, sig, ts, "tampered");
    expect(result).toEqual({ valid: false, reason: "mismatch" });
  });

  it("rejects timestamp older than tolerance", async () => {
    const ts = String(Math.floor(Date.now() / 1000) - 600);
    const body = "x";
    const sig = await signPayload(SECRET, ts, body);
    const result = await verifySignature(SECRET, sig, ts, body, 300);
    expect(result).toEqual({ valid: false, reason: "stale" });
  });

  it("rejects timestamp far in the future", async () => {
    const ts = String(Math.floor(Date.now() / 1000) + 600);
    const body = "x";
    const sig = await signPayload(SECRET, ts, body);
    const result = await verifySignature(SECRET, sig, ts, body, 300);
    expect(result).toEqual({ valid: false, reason: "stale" });
  });

  it("rejects signature without sha256= prefix", async () => {
    const ts = nowSeconds();
    const result = await verifySignature(SECRET, "deadbeef", ts, "x");
    expect(result).toEqual({ valid: false, reason: "malformed" });
  });

  it("rejects empty signature", async () => {
    const ts = nowSeconds();
    const result = await verifySignature(SECRET, "", ts, "x");
    expect(result).toEqual({ valid: false, reason: "malformed" });
  });

  it("rejects non-numeric timestamp", async () => {
    const result = await verifySignature(
      SECRET,
      "sha256=" + "a".repeat(64),
      "not-a-number",
      "x",
    );
    expect(result).toEqual({ valid: false, reason: "malformed" });
  });

  it("rejects signature with right prefix but wrong content", async () => {
    const ts = nowSeconds();
    const fake = "sha256=" + "0".repeat(64);
    const result = await verifySignature(SECRET, fake, ts, "x");
    expect(result).toEqual({ valid: false, reason: "mismatch" });
  });
});

describe("generateWebhookSecret", () => {
  it("returns a whsec_-prefixed token", () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[0-9a-f]{64}$/);
  });

  it("returns unique secrets across calls", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).not.toBe(b);
  });
});
