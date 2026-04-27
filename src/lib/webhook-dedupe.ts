import { z } from "zod";
import { withTenantTransaction } from "@/db";
import { logger } from "./logger";
import { detectProvider } from "./webhook-providers";
import type { TenantId } from "./types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DedupeRule {
  /** Dot-path into the parsed payload, e.g. "data.url". */
  keyPath: string;
  /** Sliding-window length in seconds (1–3600). */
  windowSeconds: number;
  /** When false, dedupe is explicitly disabled for this provider. */
  enabled: boolean;
}

export interface EffectiveRule extends DedupeRule {
  /** Where the rule came from — useful for the admin UI badge. */
  source: "default" | "override";
}

export const TenantRuleRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  provider: z.string(),
  key_path: z.string(),
  window_seconds: z.number().int(),
  enabled: z.boolean(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type TenantRuleRow = z.infer<typeof TenantRuleRow>;

// ─── Platform defaults ────────────────────────────────────────────────────────
//
// Code-side rules shipped at build time. Tenants override these per provider in
// webhook_dedupe_rules. Adding a new entry here is a v-bump for every tenant
// without one set.

export const DEDUPE_DEFAULTS: Record<string, DedupeRule> = {
  linear: { keyPath: "data.url", windowSeconds: 60, enabled: true },
};

// ─── Tenant-rule cache (process-level, 60s TTL) ──────────────────────────────
//
// Multi-instance staleness is acceptable: dedupe is a best-effort optimization,
// not a correctness primitive. Edits invalidate the local cache immediately;
// other instances pick up the change at most one TTL later.

interface TenantRuleCacheEntry {
  rules: Record<string, DedupeRule>;
  expiresAt: number;
}

const TENANT_RULE_CACHE_TTL_MS = 60 * 1000;
const tenantRuleCache = new Map<string, TenantRuleCacheEntry>();

export function invalidateTenantRules(tenantId: string): void {
  tenantRuleCache.delete(tenantId);
}

/** Test-only / admin-only — clears every tenant's cache. */
export function clearTenantRuleCache(): void {
  tenantRuleCache.clear();
}

async function loadTenantRules(
  tenantId: string,
): Promise<Record<string, DedupeRule>> {
  const rows = await withTenantTransaction(tenantId, async (tx) =>
    tx.query(
      TenantRuleRow,
      `SELECT id, tenant_id, provider, key_path, window_seconds, enabled,
              created_at, updated_at
       FROM webhook_dedupe_rules
       WHERE tenant_id = $1`,
      [tenantId],
    ),
  );

  const result: Record<string, DedupeRule> = {};
  for (const row of rows) {
    result[row.provider] = {
      keyPath: row.key_path,
      windowSeconds: row.window_seconds,
      enabled: row.enabled,
    };
  }
  return result;
}

async function getTenantRulesCached(
  tenantId: string,
): Promise<Record<string, DedupeRule>> {
  const entry = tenantRuleCache.get(tenantId);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.rules;
  }
  const rules = await loadTenantRules(tenantId);
  tenantRuleCache.set(tenantId, {
    rules,
    expiresAt: Date.now() + TENANT_RULE_CACHE_TTL_MS,
  });
  return rules;
}

// ─── Rule resolution ─────────────────────────────────────────────────────────

/**
 * Returns the rule that should apply for a given tenant + provider, merging
 * tenant overrides on top of platform defaults.
 *
 * Resolution order:
 *   1. Tenant override exists with `enabled: true`  → use the override.
 *   2. Tenant override exists with `enabled: false` → return null (explicitly
 *      disabled — short-circuits the platform default).
 *   3. Platform default exists                       → use the default.
 *   4. Otherwise                                     → null.
 */
export async function resolveEffectiveRule(
  tenantId: string,
  provider: string,
): Promise<DedupeRule | null> {
  let tenantRules: Record<string, DedupeRule> = {};
  try {
    tenantRules = await getTenantRulesCached(tenantId);
  } catch (err) {
    // Failure-open: log and fall back to platform defaults only.
    logger.warn("webhook_dedupe_load_failed", {
      tenant_id: tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const override = tenantRules[provider];
  if (override) {
    return override.enabled ? override : null;
  }
  return DEDUPE_DEFAULTS[provider] ?? null;
}

/**
 * Returns the merged rule set for a tenant: every provider that has either
 * a default or an override, with the source labeled. Used by the Settings UI.
 */
export async function getEffectiveRulesForTenant(
  tenantId: string,
): Promise<Record<string, EffectiveRule>> {
  let tenantRules: Record<string, DedupeRule> = {};
  try {
    tenantRules = await getTenantRulesCached(tenantId);
  } catch (err) {
    logger.warn("webhook_dedupe_load_failed", {
      tenant_id: tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const result: Record<string, EffectiveRule> = {};

  // Start from platform defaults.
  for (const [provider, rule] of Object.entries(DEDUPE_DEFAULTS)) {
    result[provider] = { ...rule, source: "default" };
  }

  // Layer overrides on top.
  for (const [provider, rule] of Object.entries(tenantRules)) {
    result[provider] = { ...rule, source: "override" };
  }

  return result;
}

// ─── Key extraction ──────────────────────────────────────────────────────────

/**
 * Walk a dot-path into a payload and return the value when it's a non-empty
 * string. Returns null on any miss — wrong type, missing field, malformed
 * payload, or any throw inside the walk. Failure-open for the route caller.
 */
export function extractDedupeKey(
  rule: DedupeRule,
  payload: unknown,
): string | null {
  try {
    if (payload === null || typeof payload !== "object") return null;
    const segments = rule.keyPath.split(".");
    let cursor: unknown = payload;
    for (const seg of segments) {
      if (cursor === null || typeof cursor !== "object") return null;
      cursor = (cursor as Record<string, unknown>)[seg];
    }
    if (typeof cursor !== "string") return null;
    if (cursor.length === 0) return null;
    return cursor;
  } catch {
    return null;
  }
}

/**
 * Resolves the rule for `source` and extracts the key from `payload`.
 * Returns null when there's no applicable rule or the key can't be extracted.
 */
export async function computeDedupeKey(
  tenantId: string,
  signatureHeader: string,
  payload: unknown,
): Promise<{ key: string | null; rule: DedupeRule | null; provider: string }> {
  const provider = detectProvider(signatureHeader);
  const rule = await resolveEffectiveRule(tenantId, provider);
  if (!rule) return { key: null, rule: null, provider };
  const key = extractDedupeKey(rule, payload);
  return { key, rule, provider };
}

// ─── Tenant-rule CRUD (used by U6/U7; lives here so cache invalidation
//     is local to writes and the typing/invariants stay in one file) ──────────

export async function listTenantRules(
  tenantId: TenantId,
): Promise<TenantRuleRow[]> {
  return withTenantTransaction(tenantId, async (tx) =>
    tx.query(
      TenantRuleRow,
      `SELECT id, tenant_id, provider, key_path, window_seconds, enabled,
              created_at, updated_at
       FROM webhook_dedupe_rules
       WHERE tenant_id = $1
       ORDER BY provider ASC`,
      [tenantId],
    ),
  );
}

export interface CreateTenantRuleInput {
  provider: string;
  keyPath: string;
  windowSeconds: number;
  enabled?: boolean;
}

export async function createTenantRule(
  tenantId: TenantId,
  input: CreateTenantRuleInput,
): Promise<TenantRuleRow> {
  const row = await withTenantTransaction(tenantId, async (tx) =>
    tx.queryOne(
      TenantRuleRow,
      `INSERT INTO webhook_dedupe_rules
         (tenant_id, provider, key_path, window_seconds, enabled)
       VALUES ($1, $2, $3, $4, COALESCE($5, true))
       RETURNING id, tenant_id, provider, key_path, window_seconds, enabled,
                 created_at, updated_at`,
      [
        tenantId,
        input.provider,
        input.keyPath,
        input.windowSeconds,
        input.enabled,
      ],
    ),
  );
  if (!row) throw new Error("webhook_dedupe_rule_insert_failed");
  invalidateTenantRules(tenantId);
  return row;
}

export interface UpdateTenantRuleInput {
  keyPath?: string;
  windowSeconds?: number;
  enabled?: boolean;
}

export async function updateTenantRule(
  tenantId: TenantId,
  ruleId: string,
  patch: UpdateTenantRuleInput,
): Promise<TenantRuleRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [ruleId, tenantId];

  if (patch.keyPath !== undefined) {
    params.push(patch.keyPath);
    sets.push(`key_path = $${params.length}`);
  }
  if (patch.windowSeconds !== undefined) {
    params.push(patch.windowSeconds);
    sets.push(`window_seconds = $${params.length}`);
  }
  if (patch.enabled !== undefined) {
    params.push(patch.enabled);
    sets.push(`enabled = $${params.length}`);
  }

  if (sets.length === 0) {
    // Nothing to update — return the current row so the caller can render it.
    const current = await withTenantTransaction(tenantId, async (tx) =>
      tx.queryOne(
        TenantRuleRow,
        `SELECT id, tenant_id, provider, key_path, window_seconds, enabled,
                created_at, updated_at
         FROM webhook_dedupe_rules
         WHERE id = $1 AND tenant_id = $2`,
        [ruleId, tenantId],
      ),
    );
    return current;
  }

  const updated = await withTenantTransaction(tenantId, async (tx) =>
    tx.queryOne(
      TenantRuleRow,
      `UPDATE webhook_dedupe_rules
       SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, tenant_id, provider, key_path, window_seconds, enabled,
                 created_at, updated_at`,
      params,
    ),
  );

  if (updated) invalidateTenantRules(tenantId);
  return updated;
}

export async function deleteTenantRule(
  tenantId: TenantId,
  ruleId: string,
): Promise<boolean> {
  const result = await withTenantTransaction(tenantId, async (tx) =>
    tx.execute(
      `DELETE FROM webhook_dedupe_rules WHERE id = $1 AND tenant_id = $2`,
      [ruleId, tenantId],
    ),
  );
  if (result.rowCount > 0) invalidateTenantRules(tenantId);
  return result.rowCount > 0;
}
