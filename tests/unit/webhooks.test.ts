import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db", () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
  withTenantTransaction: vi.fn(),
}));

vi.mock("@/lib/crypto", async () => {
  const actual = await vi.importActual<typeof import("@/lib/crypto")>("@/lib/crypto");
  return {
    ...actual,
    encrypt: vi.fn(async (plaintext: string) => ({
      version: 1,
      iv: "00".repeat(12),
      ciphertext: Buffer.from(plaintext).toString("hex"),
    })),
    decrypt: vi.fn(async (data: { ciphertext: string }) =>
      Buffer.from(data.ciphertext, "hex").toString(),
    ),
  };
});

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    ENCRYPTION_KEY: "a".repeat(64),
    ENCRYPTION_KEY_PREVIOUS: undefined,
  }),
}));

import {
  buildPromptFromTemplate,
  verifyAndPrepare,
  PAYLOAD_TRUNCATION_MARKER,
} from "@/lib/webhooks";
import { signPayload } from "@/lib/webhook-signing";
import type { WebhookSourceRow } from "@/lib/webhooks";

function fakeSource(overrides: Partial<WebhookSourceRow> = {}): WebhookSourceRow {
  const plainSecret = "whsec_current";
  return {
    id: "11111111-1111-1111-1111-111111111111",
    tenant_id: "22222222-2222-2222-2222-222222222222",
    agent_id: "33333333-3333-3333-3333-333333333333",
    name: "test source",
    enabled: true,
    signature_header: "X-AgentPlane-Signature",
    signature_format: "sha256_hex",
    secret_enc: JSON.stringify({
      version: 1,
      iv: "00".repeat(12),
      ciphertext: Buffer.from(plainSecret).toString("hex"),
    }),
    previous_secret_enc: null,
    previous_secret_expires_at: null,
    prompt_template: "Event from {{source.name}}: {{payload}}",
    last_triggered_at: null,
    filter_rules: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildPromptFromTemplate", () => {
  it("substitutes {{source.name}} and {{payload}}", () => {
    const out = buildPromptFromTemplate(
      "From {{source.name}}: {{payload}}",
      { hello: "world" },
      { name: "github" },
    );
    expect(out).toContain("From github:");
    expect(out).toContain('"hello": "world"');
  });

  it("tolerates whitespace in placeholders", () => {
    const out = buildPromptFromTemplate(
      "{{ source.name }} -> {{   payload   }}",
      { x: 1 },
      { name: "src" },
    );
    expect(out).toContain("src ->");
    expect(out).toContain('"x": 1');
  });

  it("truncates payloads larger than 256KB and appends marker", () => {
    const big = { data: "a".repeat(300_000) };
    const out = buildPromptFromTemplate("{{payload}}", big, { name: "src" });
    expect(out.endsWith(PAYLOAD_TRUNCATION_MARKER)).toBe(true);
    expect(out.length).toBeLessThan(300_000);
  });

  it("leaves unknown placeholders alone", () => {
    const out = buildPromptFromTemplate("hello {{unknown}}", {}, { name: "x" });
    expect(out).toBe("hello {{unknown}}");
  });
});

describe("verifyAndPrepare", () => {
  const source = fakeSource();
  const ts = () => String(Math.floor(Date.now() / 1000));

  it("returns missing_signature when signature header is null", async () => {
    const result = await verifyAndPrepare(source, null, ts(), "{}");
    expect(result).toEqual({ ok: false, error: "missing_signature" });
  });

  it("returns missing_timestamp when timestamp header is null", async () => {
    const result = await verifyAndPrepare(source, "sha256=abc", null, "{}");
    expect(result).toEqual({ ok: false, error: "missing_timestamp" });
  });

  it("verifies a payload signed with the current secret", async () => {
    const body = '{"event":"created"}';
    const t = ts();
    const sig = await signPayload("whsec_current", t, body);
    const result = await verifyAndPrepare(source, sig, t, body);
    expect(result).toEqual({ ok: true, usedPrevious: false });
  });

  it("rejects a signature signed with a different secret when no previous is set", async () => {
    const body = "x";
    const t = ts();
    const sig = await signPayload("whsec_wrong", t, body);
    const result = await verifyAndPrepare(source, sig, t, body);
    expect(result).toEqual({ ok: false, error: "signature_mismatch" });
  });

  it("falls back to previous secret within rotation window", async () => {
    const future = new Date(Date.now() + 60_000);
    const sourceWithPrev = fakeSource({
      previous_secret_enc: JSON.stringify({
        version: 1,
        iv: "00".repeat(12),
        ciphertext: Buffer.from("whsec_previous").toString("hex"),
      }),
      previous_secret_expires_at: future,
    });
    const body = "y";
    const t = ts();
    const sig = await signPayload("whsec_previous", t, body);
    const result = await verifyAndPrepare(sourceWithPrev, sig, t, body);
    expect(result).toEqual({ ok: true, usedPrevious: true });
  });

  it("rejects previous-secret signature once the rotation window has expired", async () => {
    const past = new Date(Date.now() - 60_000);
    const sourceWithExpiredPrev = fakeSource({
      previous_secret_enc: JSON.stringify({
        version: 1,
        iv: "00".repeat(12),
        ciphertext: Buffer.from("whsec_previous").toString("hex"),
      }),
      previous_secret_expires_at: past,
    });
    const body = "z";
    const t = ts();
    const sig = await signPayload("whsec_previous", t, body);
    const result = await verifyAndPrepare(sourceWithExpiredPrev, sig, t, body);
    expect(result).toEqual({ ok: false, error: "signature_mismatch" });
  });

  it("classifies stale timestamps as stale_timestamp", async () => {
    const oldTs = String(Math.floor(Date.now() / 1000) - 600);
    const body = "x";
    const sig = await signPayload("whsec_current", oldTs, body);
    const result = await verifyAndPrepare(source, sig, oldTs, body);
    expect(result).toEqual({ ok: false, error: "stale_timestamp" });
  });

  it("classifies malformed signatures as signature_malformed", async () => {
    const result = await verifyAndPrepare(source, "no_prefix", ts(), "x");
    expect(result).toEqual({ ok: false, error: "signature_malformed" });
  });
});
