/**
 * Workflow dispatch toggle — answers `should this trigger use the workflow
 * path or the legacy dispatcher?` with two layers:
 *
 *   1. Per-trigger env var (`WORKFLOW_DISPATCH_API` etc., U4 in env.ts)
 *   2. Per-tenant override (`tenants.workflow_dispatch_overrides` JSONB,
 *      U1 schema migration)
 *
 * Tenant override wins. Empty JSONB → follow global. Per-trigger missing
 * key → follow global.
 *
 * Plan reference: U4 in docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md
 *
 * Glass-break override: when `LEGACY_DISPATCH_GLASS_BREAK=on`, force
 * legacy path for ALL triggers regardless of toggle / override. U10a's
 * one-deploy revert lever for long-tail workflow regressions; removed
 * ~2 weeks post-U10a.
 *
 * Process-level cache: per-tenant overrides cached for 60 seconds.
 * Short enough that emergency disable propagates within a minute across
 * function instances; long enough that the JSONB lookup isn't a per-
 * request DB round-trip on hot paths. The 60s ceiling was chosen
 * deliberately — operators flipping the override expect "near-instant"
 * propagation (no slower than a normal Vercel deploy), and 60s is
 * tolerable as the upper bound.
 */
import { queryOne } from "@/db";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { z } from "zod";
import type { TenantId, RunTriggeredBy } from "@/lib/types";

export type DispatchToggleTrigger =
  | RunTriggeredBy
  | "cleanup"
  | "admin";

const ENV_KEY_BY_TRIGGER: Record<DispatchToggleTrigger, keyof ReturnType<typeof getEnv>> = {
  api: "WORKFLOW_DISPATCH_API",
  schedule: "WORKFLOW_DISPATCH_SCHEDULE",
  webhook: "WORKFLOW_DISPATCH_WEBHOOK",
  a2a: "WORKFLOW_DISPATCH_A2A",
  cleanup: "WORKFLOW_DISPATCH_CLEANUP",
  admin: "WORKFLOW_DISPATCH_ADMIN",
  // Legacy RunTriggeredBy values that are admin-shaped — fold them into
  // the admin toggle so we don't need separate env vars per UI surface.
  playground: "WORKFLOW_DISPATCH_ADMIN",
  chat: "WORKFLOW_DISPATCH_ADMIN",
};

// JSONB shape for tenants.workflow_dispatch_overrides. Empty object = follow
// global. Per-trigger boolean: explicit-true forces on (canary cohort),
// explicit-false forces off (emergency disable for one tenant).
const OverridesSchema = z.record(z.string(), z.boolean()).default({});
type Overrides = z.infer<typeof OverridesSchema>;

interface CacheEntry {
  overrides: Overrides;
  expiresAtMs: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

async function getTenantOverrides(tenantId: TenantId): Promise<Overrides> {
  const cached = cache.get(tenantId);
  if (cached && cached.expiresAtMs > Date.now()) return cached.overrides;

  try {
    const row = await queryOne(
      z.object({ workflow_dispatch_overrides: z.unknown() }),
      "SELECT workflow_dispatch_overrides FROM tenants WHERE id = $1",
      [tenantId],
    );
    const parsed = OverridesSchema.safeParse(row?.workflow_dispatch_overrides ?? {});
    const overrides = parsed.success ? parsed.data : {};
    if (!parsed.success) {
      logger.warn(
        "shouldUseWorkflow: malformed workflow_dispatch_overrides JSONB; falling back to empty",
        {
          tenant_id: tenantId,
          error: parsed.error.message,
        },
      );
    }
    cache.set(tenantId, {
      overrides,
      expiresAtMs: Date.now() + CACHE_TTL_MS,
    });
    return overrides;
  } catch (err) {
    // DB hiccup — fail-safe to empty overrides (caller falls back to
    // global env). Don't throw; the route should not 500 on a toggle
    // lookup failure.
    logger.warn("shouldUseWorkflow: tenant lookup failed; falling back to global", {
      tenant_id: tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

/**
 * Decide whether a given trigger should use the workflow path for this
 * tenant. Reads global env then per-tenant override; tenant override
 * wins. Glass-break (`LEGACY_DISPATCH_GLASS_BREAK=on`) forces legacy.
 */
export async function shouldUseWorkflow(
  trigger: DispatchToggleTrigger,
  tenantId: TenantId,
): Promise<boolean> {
  const env = getEnv();
  if (env.LEGACY_DISPATCH_GLASS_BREAK === "on") return false;

  const overrides = await getTenantOverrides(tenantId);
  // Use the canonical key (api/schedule/webhook/a2a/cleanup/admin) when
  // looking up tenant overrides — playground/chat collapse into "admin".
  const overrideKey =
    trigger === "playground" || trigger === "chat" ? "admin" : trigger;
  if (Object.prototype.hasOwnProperty.call(overrides, overrideKey)) {
    return overrides[overrideKey] === true;
  }

  const envKey = ENV_KEY_BY_TRIGGER[trigger];
  return env[envKey] === "on";
}

/**
 * Drop all cache entries. Called from tests; production callers don't
 * need this — the 60s TTL handles propagation.
 */
export function __resetWorkflowToggleCache(): void {
  cache.clear();
}
