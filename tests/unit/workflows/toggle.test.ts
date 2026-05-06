/**
 * shouldUseWorkflow unit tests.
 *
 * Plan reference: U4 in docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md
 *
 * Decision precedence (tested explicitly):
 *   1. LEGACY_DISPATCH_GLASS_BREAK=on → false (glass-break wins everything)
 *   2. Tenant override explicit → that value
 *   3. Global env toggle ('on'|'off')
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TenantId } from "@/lib/types";

vi.mock("@/db", () => ({
  queryOne: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/env", () => ({
  getEnv: vi.fn(),
}));

import { shouldUseWorkflow, __resetWorkflowToggleCache } from "@/lib/workflows/toggle";
import { queryOne } from "@/db";
import { getEnv } from "@/lib/env";

const tenantId = "t-1" as TenantId;

function setEnv(values: Partial<ReturnType<typeof getEnv>>) {
  vi.mocked(getEnv).mockReturnValue({
    DATABASE_URL: "x",
    CRON_SECRET: "x",
    ENCRYPTION_KEY: "0".repeat(64),
    ADMIN_API_KEY: "x",
    AI_GATEWAY_API_KEY: "x",
    NODE_ENV: "test",
    WORKFLOW_DISPATCH_API: "off",
    WORKFLOW_DISPATCH_SCHEDULE: "off",
    WORKFLOW_DISPATCH_WEBHOOK: "off",
    WORKFLOW_DISPATCH_A2A: "off",
    WORKFLOW_DISPATCH_CLEANUP: "off",
    WORKFLOW_DISPATCH_ADMIN: "off",
    LEGACY_DISPATCH_GLASS_BREAK: "off",
    ...values,
  } as never);
}

function setOverrides(overrides: Record<string, boolean>) {
  vi.mocked(queryOne).mockResolvedValue({
    workflow_dispatch_overrides: overrides,
  });
}

describe("shouldUseWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetWorkflowToggleCache();
  });

  describe("global env toggle", () => {
    it("env=on, no override → true", async () => {
      setEnv({ WORKFLOW_DISPATCH_API: "on" });
      setOverrides({});
      expect(await shouldUseWorkflow("api", tenantId)).toBe(true);
    });

    it("env=off, no override → false", async () => {
      setEnv({ WORKFLOW_DISPATCH_API: "off" });
      setOverrides({});
      expect(await shouldUseWorkflow("api", tenantId)).toBe(false);
    });

    it("each trigger reads its own env var", async () => {
      setEnv({
        WORKFLOW_DISPATCH_API: "on",
        WORKFLOW_DISPATCH_SCHEDULE: "off",
        WORKFLOW_DISPATCH_WEBHOOK: "on",
        WORKFLOW_DISPATCH_A2A: "off",
        WORKFLOW_DISPATCH_CLEANUP: "on",
        WORKFLOW_DISPATCH_ADMIN: "off",
      });
      setOverrides({});

      expect(await shouldUseWorkflow("api", tenantId)).toBe(true);
      expect(await shouldUseWorkflow("schedule", tenantId)).toBe(false);
      expect(await shouldUseWorkflow("webhook", tenantId)).toBe(true);
      expect(await shouldUseWorkflow("a2a", tenantId)).toBe(false);
      expect(await shouldUseWorkflow("cleanup", tenantId)).toBe(true);
      expect(await shouldUseWorkflow("admin", tenantId)).toBe(false);
    });

    it("playground / chat triggers fold into ADMIN env var", async () => {
      setEnv({ WORKFLOW_DISPATCH_ADMIN: "on" });
      setOverrides({});
      expect(await shouldUseWorkflow("playground", tenantId)).toBe(true);
      expect(await shouldUseWorkflow("chat", tenantId)).toBe(true);
    });
  });

  describe("per-tenant override", () => {
    it("tenant override explicit-false → false (even when env=on)", async () => {
      setEnv({ WORKFLOW_DISPATCH_API: "on" });
      setOverrides({ api: false });
      expect(await shouldUseWorkflow("api", tenantId)).toBe(false);
    });

    it("tenant override explicit-true → true (canary cohort, env=off)", async () => {
      setEnv({ WORKFLOW_DISPATCH_API: "off" });
      setOverrides({ api: true });
      expect(await shouldUseWorkflow("api", tenantId)).toBe(true);
    });

    it("tenant override missing key → falls back to env", async () => {
      setEnv({ WORKFLOW_DISPATCH_API: "on" });
      setOverrides({ schedule: false }); // different key
      expect(await shouldUseWorkflow("api", tenantId)).toBe(true);
    });

    it("playground override under 'admin' key", async () => {
      setEnv({ WORKFLOW_DISPATCH_ADMIN: "on" });
      setOverrides({ admin: false });
      expect(await shouldUseWorkflow("playground", tenantId)).toBe(false);
      expect(await shouldUseWorkflow("chat", tenantId)).toBe(false);
    });
  });

  describe("LEGACY_DISPATCH_GLASS_BREAK", () => {
    it("glass-break=on forces false even when env=on AND tenant override=true", async () => {
      setEnv({
        LEGACY_DISPATCH_GLASS_BREAK: "on",
        WORKFLOW_DISPATCH_API: "on",
      });
      setOverrides({ api: true });
      expect(await shouldUseWorkflow("api", tenantId)).toBe(false);
    });
  });

  describe("malformed override JSONB", () => {
    it("non-object override → fail-safe to empty (follow global)", async () => {
      setEnv({ WORKFLOW_DISPATCH_API: "on" });
      vi.mocked(queryOne).mockResolvedValue({
        workflow_dispatch_overrides: "not an object",
      });
      expect(await shouldUseWorkflow("api", tenantId)).toBe(true);
    });

    it("null override → empty (follow global)", async () => {
      setEnv({ WORKFLOW_DISPATCH_API: "on" });
      vi.mocked(queryOne).mockResolvedValue({
        workflow_dispatch_overrides: null,
      });
      expect(await shouldUseWorkflow("api", tenantId)).toBe(true);
    });
  });

  describe("DB lookup failure", () => {
    it("queryOne throws → fail-safe to empty (follow global)", async () => {
      setEnv({ WORKFLOW_DISPATCH_API: "on" });
      vi.mocked(queryOne).mockRejectedValue(new Error("connection lost"));
      expect(await shouldUseWorkflow("api", tenantId)).toBe(true);
    });
  });

  describe("cache", () => {
    it("second lookup within TTL doesn't re-query DB", async () => {
      setEnv({ WORKFLOW_DISPATCH_API: "on" });
      setOverrides({ api: false });
      await shouldUseWorkflow("api", tenantId);
      vi.mocked(queryOne).mockClear();
      await shouldUseWorkflow("api", tenantId);
      expect(queryOne).not.toHaveBeenCalled();
    });
  });
});
