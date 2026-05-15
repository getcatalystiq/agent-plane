import { z } from "zod";
import { queryOne } from "@/db";
import { logger } from "@/lib/logger";
import type { ScanResult } from "@/lib/safety/injection-scanner";
import type { RunTriggeredBy, TenantId } from "@/lib/types";

export type InjectionEnforceMode = "log_only" | "enforce";

export type InjectionPolicyDecision = "block" | "log_and_pass";

const TenantModeRow = z.object({
  injection_enforce_mode: z.string().nullable(),
});

const TENANT_MODE_TTL_MS = 60_000;
const tenantModeCache = new Map<string, { mode: InjectionEnforceMode; expiresAt: number }>();

const EXTERNAL_TRIGGERS: ReadonlySet<RunTriggeredBy> = new Set<RunTriggeredBy>([
  "api",
  "webhook",
  "a2a",
  "chat",
  "playground",
]);

/**
 * Look up the tenant's `injection_enforce_mode`. Falls back to `log_only` if
 * the row is missing or the column is unset (defensive; the column is NOT
 * NULL with a default, so the only way to land here is a missing row, which
 * would already break upstream auth — but log_only is the safe fail).
 *
 * Cached per-tenant in-memory for 60s. The flip is operator-driven and rare;
 * 60s of staleness is acceptable in exchange for skipping a DB hit on every
 * dispatch.
 */
export async function getTenantInjectionEnforceMode(
  tenantId: TenantId,
): Promise<InjectionEnforceMode> {
  const now = Date.now();
  const cached = tenantModeCache.get(tenantId);
  if (cached && cached.expiresAt > now) {
    return cached.mode;
  }

  let mode: InjectionEnforceMode = "log_only";
  try {
    const row = await queryOne(
      TenantModeRow,
      `SELECT injection_enforce_mode FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const raw = row?.injection_enforce_mode;
    if (raw === "enforce" || raw === "log_only") {
      mode = raw;
    }
  } catch (err) {
    logger.warn("getTenantInjectionEnforceMode lookup failed; defaulting to log_only", {
      tenant_id: tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  tenantModeCache.set(tenantId, { mode, expiresAt: now + TENANT_MODE_TTL_MS });
  return mode;
}

/**
 * Test-only helper to clear the per-process cache between tests.
 */
export function _clearTenantModeCacheForTesting(): void {
  tenantModeCache.clear();
}

/**
 * Apply the per-trigger policy matrix.
 *
 * - `enforce_mode = 'log_only'`: every detection logs and passes. The matrix
 *   below is bypassed.
 * - `enforce_mode = 'enforce'`: external triggers (api/webhook/a2a/chat/
 *   playground) reject on `high` confidence. `schedule` always logs and
 *   passes (compromised-operator threat is closed at the write-time gate,
 *   not at dispatch). `medium`/`low` always log and pass.
 */
export function applyInjectionPolicy(
  scan: ScanResult,
  triggeredBy: RunTriggeredBy,
  enforceMode: InjectionEnforceMode,
): InjectionPolicyDecision {
  if (!scan.detected) return "log_and_pass";
  if (enforceMode === "log_only") return "log_and_pass";
  if (scan.confidence !== "high") return "log_and_pass";
  if (!EXTERNAL_TRIGGERS.has(triggeredBy)) return "log_and_pass";
  return "block";
}
