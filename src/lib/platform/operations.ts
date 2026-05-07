/**
 * Platform Bot Configs — encrypted CRUD + token pre-validation + attestation
 * gate.
 *
 * Plan reference: U2 in
 * docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
 *
 * Surface:
 *   - upsertBotConfig: pre-validate token + run R19 attestation gate +
 *     encrypt + INSERT...ON CONFLICT DO UPDATE bumping credentials_version.
 *   - getBotConfig / listBotConfigs: tenant-scoped reads returning the public
 *     shape (no credentials_enc, secrets masked to last4).
 *   - getDecryptedCredentials: server-side only, used by ingress routes /
 *     bot registry rebuild. Returns null when enabled=false.
 *   - rotateBotCredentials: re-validate + re-encrypt; preserves prior config
 *     on validation failure.
 *   - disableBotConfig: flips enabled=false (audit-preserving).
 *   - markBotEvent: stamp last_event_at + clear last_error.
 *   - markBotError: stamp last_error verbatim from platform.
 *   - validateCredentials: probe Discord /users/@me or Slack auth.test with
 *     redirect:'error', 5s timeout, server-side debounce.
 *   - enforceAttestationGate: requires attestations.private_workspace=true
 *     AND probeWorkspaceSize <= tenants.max_trusted_members.
 *
 * RLS: every read/write goes through withTenantTransaction so the
 * `app.current_tenant_id` setting enforces isolation. RLS-bypass is reserved
 * for refreshBots() in U3 and is NOT exposed here.
 */

import { z } from "zod";
import { withTenantTransaction, type TxClient } from "@/db";
import { encrypt, decrypt, hashApiKey } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { ConflictError } from "@/lib/errors";
import type { TenantId, AgentId } from "@/lib/types";
import { probeWorkspaceSize, type WorkspaceProbeResult } from "@/lib/platform/workspace-probe";

// The probed: true branch of WorkspaceProbeResult — used as the return type
// of enforceAttestationGate so callers can read memberCount/label without
// re-narrowing.
type ProbeOk = Extract<WorkspaceProbeResult, { probed: true }>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ChatPlatform = "discord" | "slack";

export type DiscordCredentials = {
  platform: "discord";
  botToken: string;
  publicKey: string;
  applicationId: string;
};

export type SlackCredentials = {
  platform: "slack";
  botToken: string;
  signingSecret: string;
  appId?: string;
  teamId?: string;
};

export type PlatformCredentials = DiscordCredentials | SlackCredentials;

export interface AttestationsInput {
  private_workspace: boolean;
}

export interface PlatformBotConfigPublic {
  id: string;
  tenant_id: TenantId;
  agent_id: AgentId;
  platform: ChatPlatform;
  /** Masked secret summary — last4 of the bot token. Never returns plaintext. */
  last4: string;
  credentials_version: number;
  platform_identity: Record<string, unknown>;
  attestations: { private_workspace: boolean; attested_at: string | null };
  enabled: boolean;
  last_event_at: string | null;
  last_error: string | null;
  last_connected_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ValidationResult =
  | { ok: true; identity: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string; retryAfterSeconds?: number } };

export interface UpsertBotConfigInput {
  tenantId: TenantId;
  agentId: AgentId;
  credentials: PlatformCredentials;
  attestations: AttestationsInput;
}

export class AttestationGateError extends Error {
  constructor(public reason: "missing_attestation" | "workspace_too_large" | "probe_failed", message: string) {
    super(message);
    this.name = "AttestationGateError";
  }
}

export class CredentialValidationError extends Error {
  constructor(public result: Extract<ValidationResult, { ok: false }>) {
    super(result.error.message);
    this.name = "CredentialValidationError";
  }
}

// ---------------------------------------------------------------------------
// Internal row schema (DB shape; UI surfaces use PlatformBotConfigPublic)
// ---------------------------------------------------------------------------

const PlatformBotConfigRow = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  platform: z.enum(["discord", "slack"]),
  credentials_enc: z.string(),
  credentials_version: z.number().int(),
  platform_identity: z.unknown().transform((v) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {})),
  attestations: z.unknown().transform((v) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {})),
  enabled: z.boolean(),
  last_event_at: z.coerce.date().nullable(),
  last_error: z.string().nullable(),
  last_connected_at: z.coerce.date().nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

type PlatformBotConfigRow = z.infer<typeof PlatformBotConfigRow>;

// ---------------------------------------------------------------------------
// Encryption helpers (mirrors src/lib/webhooks.ts shape)
// ---------------------------------------------------------------------------

async function encryptCredentials(credentials: PlatformCredentials): Promise<string> {
  const env = getEnv();
  return JSON.stringify(await encrypt(JSON.stringify(credentials), env.ENCRYPTION_KEY));
}

async function decryptCredentials(serialized: string): Promise<PlatformCredentials> {
  const env = getEnv();
  const plaintext = await decrypt(JSON.parse(serialized), env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_PREVIOUS);
  return JSON.parse(plaintext) as PlatformCredentials;
}

// ---------------------------------------------------------------------------
// Public-shape projection
// ---------------------------------------------------------------------------

function last4(token: string): string {
  const s = token.trim();
  return s.length <= 4 ? "*".repeat(s.length) : `***${s.slice(-4)}`;
}

async function rowToPublic(row: PlatformBotConfigRow): Promise<PlatformBotConfigPublic> {
  // Decryption is only needed for the last4 mask; getBotConfig and
  // listBotConfigs go through this path. Mask never returns full plaintext.
  let mask = "****";
  try {
    const creds = await decryptCredentials(row.credentials_enc);
    mask = last4(creds.botToken);
  } catch {
    // Decryption failures (e.g., stale ENCRYPTION_KEY) leave the mask blank;
    // the surface layer can still display the config and flag for rotation.
    mask = "****";
  }
  const attestations = row.attestations as { private_workspace?: boolean; attested_at?: string };
  return {
    id: row.id,
    tenant_id: row.tenant_id as TenantId,
    agent_id: row.agent_id as AgentId,
    platform: row.platform,
    last4: mask,
    credentials_version: row.credentials_version,
    platform_identity: row.platform_identity,
    attestations: {
      private_workspace: attestations.private_workspace === true,
      attested_at: attestations.attested_at ?? null,
    },
    enabled: row.enabled,
    last_event_at: row.last_event_at?.toISOString() ?? null,
    last_error: row.last_error,
    last_connected_at: row.last_connected_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Token pre-validation
// ---------------------------------------------------------------------------

const VALIDATION_TIMEOUT_MS = 5_000;

// Server-side debounce: blocks duplicate validation within this window for
// the same (tenant, platform, tokenHash). Absorbs users who triple-click
// submit, preventing spurious Discord/Slack auth.test rate-limit hits.
//
// Cross-instance via Redis SETNX (P2 #24 fix). Earlier rev used an
// in-process Map which was per-instance and didn't actually dedupe
// concurrent validations across multi-instance Vercel deploys.
const VALIDATION_DEBOUNCE_MS = 5_000;

async function debounceKey(tenantId: TenantId, platform: ChatPlatform, token: string): Promise<string> {
  return `${tenantId}:${platform}:${await hashApiKey(token)}`;
}

// Fallback in-memory store for tests / Redis-unavailable contexts. Same
// behavior as before, just gated behind a Redis-not-available branch.
const inMemoryDebounce = new Map<string, number>();

function inMemoryCheckDebounce(key: string): boolean {
  const now = Date.now();
  const expiresAt = inMemoryDebounce.get(key);
  if (expiresAt && expiresAt > now) return false;
  inMemoryDebounce.set(key, now + VALIDATION_DEBOUNCE_MS);
  if (inMemoryDebounce.size > 5_000) {
    for (const [k, exp] of inMemoryDebounce) {
      if (exp <= now) inMemoryDebounce.delete(k);
    }
  }
  return true;
}

async function checkDebounce(key: string): Promise<boolean> {
  // Use Redis when configured (production path); fall back to in-memory
  // when not (test environments, Redis-unavailable bootstraps).
  const env = getEnv();
  if (env.UPSTASH_REDIS_URL) {
    const { tryAcquireDebounce } = await import("@/lib/platform/redis-bucket");
    return tryAcquireDebounce(key, VALIDATION_DEBOUNCE_MS);
  }
  return inMemoryCheckDebounce(key);
}

export async function validateCredentials(
  tenantId: TenantId,
  credentials: PlatformCredentials,
): Promise<ValidationResult> {
  const dedupe = await debounceKey(tenantId, credentials.platform, credentials.botToken);
  if (!(await checkDebounce(dedupe))) {
    return { ok: false, error: { code: "debounced", message: "Validation already in progress; wait a few seconds before retrying." } };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
  try {
    if (credentials.platform === "discord") {
      const res = await fetch("https://discord.com/api/v10/users/@me", {
        method: "GET",
        // R10: redirect:'error' so an attacker-supplied token cannot redirect
        // the validator to an off-platform URL (would leak the bot token in
        // the Authorization header).
        redirect: "error",
        headers: { Authorization: `Bot ${credentials.botToken}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        const retryAfter = res.headers.get("retry-after");
        return {
          ok: false,
          error: {
            code: res.status === 401 ? "invalid_token" : `http_${res.status}`,
            message: `Discord rejected the bot token (HTTP ${res.status}).`,
            retryAfterSeconds: retryAfter ? Number(retryAfter) : undefined,
          },
        };
      }
      const identity = (await res.json()) as { id?: string; username?: string };
      return { ok: true, identity: { bot_user_id: identity.id ?? null, display_name: identity.username ?? null } };
    }

    // Slack
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${credentials.botToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "",
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: { code: `http_${res.status}`, message: `Slack auth.test returned HTTP ${res.status}.` } };
    }
    const body = (await res.json()) as { ok: boolean; error?: string; team_id?: string; user_id?: string; bot_id?: string; team?: string };
    if (!body.ok) {
      const retryAfter = res.headers.get("retry-after");
      return {
        ok: false,
        error: {
          code: body.error ?? "auth_test_failed",
          message: `Slack auth.test failed: ${body.error ?? "unknown"}.`,
          retryAfterSeconds: retryAfter ? Number(retryAfter) : undefined,
        },
      };
    }
    return {
      ok: true,
      identity: {
        team_id: body.team_id ?? null,
        team_name: body.team ?? null,
        bot_user_id: body.user_id ?? null,
        bot_id: body.bot_id ?? null,
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: { code: "timeout", message: "Platform did not respond within 5 seconds — check your network and try again." } };
    }
    if (err instanceof TypeError && /redirect/.test(err.message)) {
      return { ok: false, error: { code: "redirect_blocked", message: "The platform attempted a redirect during validation; refused to follow." } };
    }
    return { ok: false, error: { code: "validation_error", message: err instanceof Error ? err.message : String(err) } };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Attestation gate (R19)
// ---------------------------------------------------------------------------

interface AttestationGateInput {
  tenantId: TenantId;
  credentials: PlatformCredentials;
  identity: Record<string, unknown>;
  attestations: AttestationsInput;
  maxTrustedMembers: number;
}

export async function enforceAttestationGate(input: AttestationGateInput): Promise<ProbeOk> {
  if (input.attestations.private_workspace !== true) {
    throw new AttestationGateError(
      "missing_attestation",
      "Connection requires the operator to attest that this is a private/trusted workspace.",
    );
  }
  const probe = await probeWorkspaceSize(input.credentials, input.identity);
  if (!probe.probed) {
    throw new AttestationGateError(
      "probe_failed",
      `Could not verify workspace size: ${probe.reason}. Retry the connect.`,
    );
  }
  if (probe.memberCount > input.maxTrustedMembers) {
    throw new AttestationGateError(
      "workspace_too_large",
      `Workspace has ${probe.memberCount} members; chat support is gated to ≤${input.maxTrustedMembers} per the threat-model boundary. Raise tenants.max_trusted_members for this tenant or use a smaller workspace.`,
    );
  }
  return probe;
}

// ---------------------------------------------------------------------------
// CRUD (tenant-scoped, RLS)
// ---------------------------------------------------------------------------

const TenantThresholdRow = z.object({ max_trusted_members: z.number().int().positive() });

async function getTenantThreshold(tx: TxClient, tenantId: TenantId): Promise<number> {
  // RLS on tenants table allows the tenant's own row.
  const row = await tx.queryOne(
    TenantThresholdRow,
    "SELECT max_trusted_members FROM tenants WHERE id = $1",
    [tenantId],
  );
  return row?.max_trusted_members ?? 100;
}

// Per-tenant per-platform enabled-bot cap. The Discord gateway listener
// holds one DB pool client for ~700s per enabled bot, so unbounded
// enablement on a single tenant can starve the shared pool (max=20).
// 10 per platform per tenant fits with comfortable headroom. Round-5
// review #3: cap is now per-tenant via tenants.bot_platform_caps JSONB
// (migration 038). The constant below is the platform default when the
// tenant has no override.
const DEFAULT_ENABLED_BOTS_PER_TENANT_PER_PLATFORM = 10;

const EnabledBotCountRow = z.object({ count: z.coerce.number().int().nonnegative() });

async function countEnabledBots(
  tx: TxClient,
  tenantId: TenantId,
  agentId: AgentId,
  platform: ChatPlatform,
): Promise<number> {
  // Count enabled rows for this tenant+platform, EXCLUDING the agent we
  // are upserting (UPSERT on the same agent should not count itself
  // against the cap).
  const row = await tx.queryOne(
    EnabledBotCountRow,
    `SELECT COUNT(*) AS count FROM platform_bot_configs
      WHERE tenant_id = $1 AND platform = $2 AND enabled = true
        AND agent_id <> $3`,
    [tenantId, platform, agentId],
  );
  return row?.count ?? 0;
}

const TenantBotCapsRow = z.object({
  bot_platform_caps: z.record(z.string(), z.number().int().positive()).nullable(),
});

// Round-6 review #D: extracted helper so the lock key string is
// constructed in one place. Two call sites (probe tx + UPSERT tx)
// must use the same key for the lock to actually serialize.
function botCapLockKey(tenantId: TenantId, platform: ChatPlatform): string {
  return `bot-cap:${tenantId}:${platform}`;
}

async function acquireBotCapLock(
  tx: TxClient,
  tenantId: TenantId,
  platform: ChatPlatform,
): Promise<void> {
  await tx.execute(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [botCapLockKey(tenantId, platform)],
  );
}

async function getTenantBotCap(
  tx: TxClient,
  tenantId: TenantId,
  platform: ChatPlatform,
): Promise<number> {
  const row = await tx.queryOne(
    TenantBotCapsRow,
    "SELECT bot_platform_caps FROM tenants WHERE id = $1",
    [tenantId],
  );
  return row?.bot_platform_caps?.[platform] ?? DEFAULT_ENABLED_BOTS_PER_TENANT_PER_PLATFORM;
}

// Round-5 review #4: extend ConflictError so withErrorHandler maps to
// 409 automatically, eliminating the hand-rolled mapping in the admin
// route. We override toJSON to surface the platform + limit fields the
// admin UI uses to render an actionable error.
export class TenantBotCapExceededError extends ConflictError {
  constructor(public readonly platform: ChatPlatform, public readonly limit: number) {
    super(
      `Tenant has reached the maximum of ${limit} enabled ${platform} bots. Disable an existing bot before connecting a new one.`,
    );
    this.code = "tenant_bot_cap_exceeded";
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        platform: this.platform,
        limit: this.limit,
      },
    };
  }
}

export async function upsertBotConfig(input: UpsertBotConfigInput): Promise<PlatformBotConfigPublic> {
  // 1. Validate credentials (cheap) + run attestation gate (probes platform).
  const validation = await validateCredentials(input.tenantId, input.credentials);
  if (!validation.ok) {
    throw new CredentialValidationError(validation);
  }

  // Round-6 review #E fix: split the cap pre-check from the probe. The
  // probe is a 5s HTTP call to Slack/Discord; if held inside a tx with
  // the advisory lock, it pins both a pool client AND the lock for that
  // duration. Under concurrent admin connects, this serialized 5s
  // probes one at a time and saturated the pool. Now: take the lock
  // briefly for the pre-check (cheap SQL only), release at COMMIT,
  // run the probe with no resources held, then re-take the lock in the
  // UPSERT transaction (which re-checks the cap to close the window).
  await withTenantTransaction(input.tenantId, async (tx) => {
    await acquireBotCapLock(tx, input.tenantId, input.credentials.platform);
    const cap = await getTenantBotCap(tx, input.tenantId, input.credentials.platform);
    const enabledCount = await countEnabledBots(
      tx,
      input.tenantId,
      input.agentId,
      input.credentials.platform,
    );
    if (enabledCount >= cap) {
      throw new TenantBotCapExceededError(input.credentials.platform, cap);
    }
  });

  // Probe runs OUTSIDE the lock now so the pool client + advisory lock
  // are released before the network call. Threshold is read in its own
  // tiny transaction.
  const threshold = await withTenantTransaction(input.tenantId, async (tx) => {
    return getTenantThreshold(tx, input.tenantId);
  });
  const probe = await enforceAttestationGate({
    tenantId: input.tenantId,
    credentials: input.credentials,
    identity: validation.identity,
    attestations: input.attestations,
    maxTrustedMembers: threshold,
  });

  // 2. Encrypt credentials.
  const credentialsEnc = await encryptCredentials(input.credentials);

  // 3. Compose platform_identity (validation identity + probe result).
  const platformIdentity: Record<string, unknown> = {
    ...validation.identity,
    member_count_at_connect: probe.memberCount,
    workspace_label: probe.label ?? null,
  };

  // 4. Encode attestations with timestamp.
  const attestations = {
    private_workspace: true,
    attested_at: new Date().toISOString(),
    attested_by_admin: true,
  };

  // 5. UPSERT — bumping credentials_version on conflict.
  // Re-acquire the advisory lock (released when the cap-check transaction
  // committed) so concurrent upserts can't slot in between cap-check and
  // INSERT. Re-check the cap inside this transaction to close the window
  // where attestation/probe completed for two concurrent connects.
  return withTenantTransaction(input.tenantId, async (tx) => {
    await acquireBotCapLock(tx, input.tenantId, input.credentials.platform);
    const cap = await getTenantBotCap(tx, input.tenantId, input.credentials.platform);
    const enabledCount = await countEnabledBots(
      tx,
      input.tenantId,
      input.agentId,
      input.credentials.platform,
    );
    if (enabledCount >= cap) {
      throw new TenantBotCapExceededError(input.credentials.platform, cap);
    }
    const row = await tx.queryOne(
      PlatformBotConfigRow,
      `INSERT INTO platform_bot_configs
         (tenant_id, agent_id, platform, credentials_enc, credentials_version,
          platform_identity, attestations, enabled, last_connected_at)
       VALUES ($1, $2, $3, $4, 1, $5, $6, true, NULL)
       ON CONFLICT (tenant_id, agent_id, platform) DO UPDATE SET
         credentials_enc = EXCLUDED.credentials_enc,
         credentials_version = platform_bot_configs.credentials_version + 1,
         platform_identity = EXCLUDED.platform_identity,
         attestations = EXCLUDED.attestations,
         enabled = true,
         last_error = NULL,
         updated_at = now()
       RETURNING *`,
      [
        input.tenantId,
        input.agentId,
        input.credentials.platform,
        credentialsEnc,
        JSON.stringify(platformIdentity),
        JSON.stringify(attestations),
      ],
    );
    if (!row) throw new Error("upsertBotConfig returned no row");
    logger.info("Bot config upserted", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      platform: input.credentials.platform,
      credentials_version: row.credentials_version,
      member_count_at_connect: probe.memberCount,
    });
    return rowToPublic(row);
  });
}

export async function getBotConfig(
  tenantId: TenantId,
  agentId: AgentId,
  platform: ChatPlatform,
): Promise<PlatformBotConfigPublic | null> {
  return withTenantTransaction(tenantId, async (tx) => {
    const row = await tx.queryOne(
      PlatformBotConfigRow,
      `SELECT * FROM platform_bot_configs
       WHERE tenant_id = $1 AND agent_id = $2 AND platform = $3`,
      [tenantId, agentId, platform],
    );
    return row ? rowToPublic(row) : null;
  });
}

export async function listBotConfigs(
  tenantId: TenantId,
  agentId?: AgentId,
): Promise<PlatformBotConfigPublic[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const rows = agentId
      ? await tx.query(
          PlatformBotConfigRow,
          "SELECT * FROM platform_bot_configs WHERE tenant_id = $1 AND agent_id = $2 ORDER BY created_at ASC",
          [tenantId, agentId],
        )
      : await tx.query(
          PlatformBotConfigRow,
          "SELECT * FROM platform_bot_configs WHERE tenant_id = $1 ORDER BY created_at ASC",
          [tenantId],
        );
    return Promise.all(rows.map(rowToPublic));
  });
}

/**
 * Server-side only — returns plaintext credentials. Used by the bot registry
 * (U3) on cache rebuild and by ingress webhooks for signature verification.
 * Returns null when enabled=false so the caller short-circuits without
 * decrypting a disabled config.
 */
export async function getDecryptedCredentials(
  tenantId: TenantId,
  agentId: AgentId,
  platform: ChatPlatform,
): Promise<PlatformCredentials | null> {
  return withTenantTransaction(tenantId, async (tx) => {
    const row = await tx.queryOne(
      PlatformBotConfigRow,
      `SELECT * FROM platform_bot_configs
       WHERE tenant_id = $1 AND agent_id = $2 AND platform = $3 AND enabled = true`,
      [tenantId, agentId, platform],
    );
    if (!row) return null;
    return decryptCredentials(row.credentials_enc);
  });
}

export async function disableBotConfig(
  tenantId: TenantId,
  agentId: AgentId,
  platform: ChatPlatform,
): Promise<PlatformBotConfigPublic | null> {
  return withTenantTransaction(tenantId, async (tx) => {
    const row = await tx.queryOne(
      PlatformBotConfigRow,
      `UPDATE platform_bot_configs SET enabled = false, updated_at = now()
       WHERE tenant_id = $1 AND agent_id = $2 AND platform = $3
       RETURNING *`,
      [tenantId, agentId, platform],
    );
    return row ? rowToPublic(row) : null;
  });
}

/**
 * Stamp last_event_at and clear last_error. Called by ingress routes (U4/U5)
 * after a verified inbound event reaches the bridge.
 */
export async function markBotEvent(
  tenantId: TenantId,
  agentId: AgentId,
  platform: ChatPlatform,
): Promise<void> {
  await withTenantTransaction(tenantId, async (tx) => {
    await tx.execute(
      `UPDATE platform_bot_configs
       SET last_event_at = now(), last_error = NULL, last_connected_at = COALESCE(last_connected_at, now()),
           updated_at = now()
       WHERE tenant_id = $1 AND agent_id = $2 AND platform = $3`,
      [tenantId, agentId, platform],
    );
  });
}

/**
 * Stamp last_error verbatim from platform. Called by ingress routes (U4/U5)
 * on signature failure attributable to a specific bot, and by the chat
 * workflow (U6) on dispatch failure or platform 401.
 */
export async function markBotError(
  tenantId: TenantId,
  agentId: AgentId,
  platform: ChatPlatform,
  errorMessage: string,
): Promise<void> {
  await withTenantTransaction(tenantId, async (tx) => {
    await tx.execute(
      `UPDATE platform_bot_configs
       SET last_error = $4, updated_at = now()
       WHERE tenant_id = $1 AND agent_id = $2 AND platform = $3`,
      [tenantId, agentId, platform, errorMessage.slice(0, 1024)],
    );
  });
}

// Test-only export — reset the in-memory debounce map between cases.
// (Tests don't hit the Redis path because UPSTASH_REDIS_URL is unset
// in the test env mock.)
export function _resetValidationDebounceForTests(): void {
  inMemoryDebounce.clear();
}
