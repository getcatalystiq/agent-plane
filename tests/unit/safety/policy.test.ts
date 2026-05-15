import { describe, it, expect } from "vitest";
import { applyInjectionPolicy } from "@/lib/safety/policy";
import type { ScanResult } from "@/lib/safety/injection-scanner";
import type { RunTriggeredBy } from "@/lib/types";

const EXTERNAL: RunTriggeredBy[] = ["api", "webhook", "a2a", "chat", "playground"];
const ALL_TRIGGERS: RunTriggeredBy[] = [...EXTERNAL, "schedule"];

function scan(detected: boolean, confidence: ScanResult["confidence"] = "low"): ScanResult {
  return {
    detected,
    confidence,
    patterns: detected ? ["instruction_override"] : [],
  };
}

describe("applyInjectionPolicy", () => {
  describe("clean prompt (no detection)", () => {
    it("returns log_and_pass for every trigger × every mode", () => {
      const clean = scan(false);
      for (const trigger of ALL_TRIGGERS) {
        for (const mode of ["log_only", "enforce"] as const) {
          expect(applyInjectionPolicy(clean, trigger, mode)).toBe(
            "log_and_pass",
          );
        }
      }
    });
  });

  describe("log_only mode (v1 default)", () => {
    it("returns log_and_pass for every trigger at every confidence", () => {
      for (const conf of ["high", "medium", "low"] as const) {
        const detected = scan(true, conf);
        for (const trigger of ALL_TRIGGERS) {
          expect(applyInjectionPolicy(detected, trigger, "log_only")).toBe(
            "log_and_pass",
          );
        }
      }
    });
  });

  describe("enforce mode", () => {
    it("blocks high-confidence detections on every external trigger", () => {
      const high = scan(true, "high");
      for (const trigger of EXTERNAL) {
        expect(applyInjectionPolicy(high, trigger, "enforce")).toBe("block");
      }
    });

    it("does NOT block schedule even on high confidence (compromised-operator threat is closed at write-time)", () => {
      const high = scan(true, "high");
      expect(applyInjectionPolicy(high, "schedule", "enforce")).toBe(
        "log_and_pass",
      );
    });

    it("does NOT block medium or low on any trigger", () => {
      for (const conf of ["medium", "low"] as const) {
        const detected = scan(true, conf);
        for (const trigger of ALL_TRIGGERS) {
          expect(applyInjectionPolicy(detected, trigger, "enforce")).toBe(
            "log_and_pass",
          );
        }
      }
    });
  });
});
