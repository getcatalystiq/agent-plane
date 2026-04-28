import { describe, it, expect } from "vitest";
import {
  PROVIDER_OPTIONS,
  PROVIDER_PRESETS,
  KNOWN_PROVIDER_KEYS,
  detectProvider,
} from "@/lib/webhook-providers";

describe("webhook-providers", () => {
  describe("detectProvider", () => {
    it("maps Linear-Signature to linear", () => {
      expect(detectProvider("Linear-Signature")).toBe("linear");
    });

    it("maps X-Hub-Signature-256 to github", () => {
      expect(detectProvider("X-Hub-Signature-256")).toBe("github");
    });

    it("maps Stripe-Signature to stripe", () => {
      expect(detectProvider("Stripe-Signature")).toBe("stripe");
    });

    it("maps sentry-hook-signature to sentry", () => {
      expect(detectProvider("sentry-hook-signature")).toBe("sentry");
    });

    it("maps X-CC-Webhook-Signature to coinbase", () => {
      expect(detectProvider("X-CC-Webhook-Signature")).toBe("coinbase");
    });

    it("returns custom for an unknown header", () => {
      expect(detectProvider("X-AgentPlane-Signature")).toBe("custom");
    });

    it("returns custom for empty input", () => {
      expect(detectProvider("")).toBe("custom");
    });

    it("is case-sensitive (matches the existing client behavior)", () => {
      // X-Hub-Signature is intercom; lowercase variant should not match
      expect(detectProvider("x-hub-signature")).toBe("custom");
    });
  });

  describe("PROVIDER_PRESETS / PROVIDER_OPTIONS", () => {
    it("every preset key appears in PROVIDER_OPTIONS", () => {
      const optionValues = new Set(PROVIDER_OPTIONS.map((o) => o.value));
      for (const key of Object.keys(PROVIDER_PRESETS)) {
        expect(optionValues.has(key)).toBe(true);
      }
    });

    it("PROVIDER_OPTIONS includes the custom fallback", () => {
      expect(PROVIDER_OPTIONS.find((o) => o.value === "custom")).toBeTruthy();
    });

    it("KNOWN_PROVIDER_KEYS covers every preset plus custom", () => {
      for (const key of Object.keys(PROVIDER_PRESETS)) {
        expect(KNOWN_PROVIDER_KEYS).toContain(key);
      }
      expect(KNOWN_PROVIDER_KEYS).toContain("custom");
    });
  });
});
