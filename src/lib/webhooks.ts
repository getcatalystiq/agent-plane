import { z } from "zod";
import { execute, query, queryOne, withTenantTransaction } from "@/db";
import { encrypt, decrypt } from "./crypto";
import { generateWebhookSecret, verifySignature, type VerifyResult } from "./webhook-signing";
import { getEnv } from "./env";
import type {
  AgentId,
  RunId,
  TenantId,
  WebhookSourceId,
} from "./types";

export const PAYLOAD_TRUNCATE_BYTES = 256 * 1024;
export const PAYLOAD_TRUNCATION_MARKER = "\n[payload truncated]";
export const ROTATION_OVERLAP_DAYS = 7;

export const CreateWebhookSourceSchema = z.object({
  agent_id: z.string().uuid(),
  name: z.string().min(1).max(100),
  prompt_template: z.string().min(1).max(10_000),
  signature_header: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9-]+$/, "signature_header must be a valid HTTP header name")
    .optional(),
  // Optional caller-supplied signing secret. When omitted, the backend
  // generates one and reveals it in the response. When supplied, the secret
  // is used as-is (still encrypted at rest) and the response does NOT echo it.
  secret: z.string().min(8).max(200).optional(),
  enabled: z.boolean().optional(),
});
export type CreateWebhookSourceInput = z.infer<typeof CreateWebhookSourceSchema>;

export const UpdateWebhookSourceSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  prompt_template: z.string().min(1).max(10_000).optional(),
  signature_header: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9-]+$/, "signature_header must be a valid HTTP header name")
    .optional(),
  enabled: z.boolean().optional(),
});
export type UpdateWebhookSourceInput = z.infer<typeof UpdateWebhookSourceSchema>;

export const WebhookSourceRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  agent_id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  signature_header: z.string(),
  signature_format: z.string(),
  secret_enc: z.string(),
  previous_secret_enc: z.string().nullable(),
  previous_secret_expires_at: z.coerce.date().nullable(),
  prompt_template: z.string(),
  last_triggered_at: z.coerce.date().nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type WebhookSourceRow = z.infer<typeof WebhookSourceRow>;

const PUBLIC_SOURCE_COLUMNS =
  "id, tenant_id, agent_id, name, enabled, signature_header, signature_format, " +
  "prompt_template, last_triggered_at, created_at, updated_at";

export const PublicWebhookSourceRow = WebhookSourceRow.omit({
  secret_enc: true,
  previous_secret_enc: true,
  previous_secret_expires_at: true,
});
export type PublicWebhookSourceRow = z.infer<typeof PublicWebhookSourceRow>;

export const WebhookDeliveryRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  source_id: z.string(),
  delivery_id: z.string(),
  payload_hash: z.string(),
  valid: z.boolean(),
  error: z.string().nullable(),
  run_id: z.string().nullable(),
  dedupe_key: z.string().nullable(),
  suppressed_by_run_id: z.string().nullable(),
  created_at: z.coerce.date(),
});
export type WebhookDeliveryRow = z.infer<typeof WebhookDeliveryRow>;

export type DeliveryError =
  | "source_disabled"
  | "missing_signature"
  | "missing_timestamp"
  | "signature_malformed"
  | "signature_mismatch"
  | "stale_timestamp"
  | "invalid_json"
  | "payload_too_large"
  | "rate_limited"
  | "internal_error";

export interface VerifyAndPrepareSuccess {
  ok: true;
  usedPrevious: boolean;
}
export interface VerifyAndPrepareFailure {
  ok: false;
  error: DeliveryError;
}
export type VerifyAndPrepareResult = VerifyAndPrepareSuccess | VerifyAndPrepareFailure;

export async function loadWebhookSource(
  sourceId: WebhookSourceId,
): Promise<WebhookSourceRow | null> {
  return queryOne(
    WebhookSourceRow,
    `SELECT id, tenant_id, agent_id, name, enabled, signature_header, signature_format,
            secret_enc, previous_secret_enc, previous_secret_expires_at,
            prompt_template, last_triggered_at, created_at, updated_at
     FROM webhook_sources
     WHERE id = $1`,
    [sourceId],
  );
}

async function decryptSecret(serialized: string): Promise<string> {
  const env = getEnv();
  return decrypt(JSON.parse(serialized), env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_PREVIOUS);
}

async function encryptSecret(plaintext: string): Promise<string> {
  const env = getEnv();
  return JSON.stringify(await encrypt(plaintext, env.ENCRYPTION_KEY));
}

export async function verifyAndPrepare(
  source: WebhookSourceRow,
  signature: string | null,
  timestamp: string | null,
  rawBody: string,
  now: Date = new Date(),
): Promise<VerifyAndPrepareResult> {
  if (!signature) return { ok: false, error: "missing_signature" };

  // Timestamp is required for prefixed (`sha256=...`) and Stripe-style
  // (`t=...,v1=...`) formats. Raw HMAC (Linear, Vercel, Sentry) carries no
  // timestamp at all — verifySignature handles that path without one.
  const requiresTimestamp =
    signature.startsWith("sha256=") || signature.startsWith("t=");
  if (requiresTimestamp && !timestamp) {
    return { ok: false, error: "missing_timestamp" };
  }
  const ts = timestamp ?? "";

  const currentSecret = await decryptSecret(source.secret_enc);
  const currentResult = await verifySignature(currentSecret, signature, ts, rawBody);
  if (currentResult.valid) return { ok: true, usedPrevious: false };

  const previousActive =
    source.previous_secret_enc !== null &&
    source.previous_secret_expires_at !== null &&
    source.previous_secret_expires_at.getTime() > now.getTime();

  if (previousActive && source.previous_secret_enc) {
    const previousSecret = await decryptSecret(source.previous_secret_enc);
    const previousResult = await verifySignature(
      previousSecret,
      signature,
      ts,
      rawBody,
    );
    if (previousResult.valid) return { ok: true, usedPrevious: true };
    return { ok: false, error: deliveryErrorFromVerify(previousResult) };
  }

  return { ok: false, error: deliveryErrorFromVerify(currentResult) };
}

function deliveryErrorFromVerify(result: VerifyResult): DeliveryError {
  if (result.reason === "stale") return "stale_timestamp";
  if (result.reason === "malformed") return "signature_malformed";
  return "signature_mismatch";
}

export interface RecordDeliveryParams {
  tenantId: TenantId;
  sourceId: WebhookSourceId;
  deliveryId: string;
  payloadHash: string;
  valid: boolean;
  error: DeliveryError | null;
  runId: RunId | null;
  /** Content-projection key for window-based dedupe. Null when no rule applies. */
  dedupeKey?: string | null;
}

export type RecordDeliveryResult =
  | { kind: "inserted"; deliveryRowId: string }
  | { kind: "duplicate"; existingRunId: RunId | null };

export async function recordDelivery(
  params: RecordDeliveryParams,
): Promise<RecordDeliveryResult> {
  const inserted = await query(
    z.object({ id: z.string() }),
    `INSERT INTO webhook_deliveries
       (tenant_id, source_id, delivery_id, payload_hash, valid, error, run_id, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (source_id, delivery_id) DO NOTHING
     RETURNING id`,
    [
      params.tenantId,
      params.sourceId,
      params.deliveryId,
      params.payloadHash,
      params.valid,
      params.error,
      params.runId,
      params.dedupeKey ?? null,
    ],
  );

  if (inserted.length > 0) {
    return { kind: "inserted", deliveryRowId: inserted[0].id };
  }

  const existing = await queryOne(
    z.object({ run_id: z.string().nullable() }),
    `SELECT run_id
     FROM webhook_deliveries
     WHERE source_id = $1 AND delivery_id = $2`,
    [params.sourceId, params.deliveryId],
  );
  return {
    kind: "duplicate",
    existingRunId: (existing?.run_id ?? null) as RunId | null,
  };
}

/**
 * Look up the most recent prior delivery for the same `source_id` whose
 * `dedupe_key` matches and whose `created_at` is within the sliding window.
 * Excludes a specific `excludeDeliveryRowId` so the just-inserted delivery
 * doesn't match itself.
 *
 * Only deliveries with `valid = true` and a non-null `run_id` count as a
 * suppression target — we don't want to point a sender at an invalid prior
 * delivery, and we want to point them at the run that absorbed the work.
 */
export async function findRecentDeliveryByDedupeKey(
  sourceId: WebhookSourceId,
  dedupeKey: string,
  windowSeconds: number,
  excludeDeliveryRowId: string,
): Promise<{ id: string; runId: RunId | null } | null> {
  const row = await queryOne(
    z.object({
      id: z.string(),
      run_id: z.string().nullable(),
    }),
    `SELECT id, run_id
     FROM webhook_deliveries
     WHERE source_id = $1
       AND dedupe_key = $2
       AND id <> $3
       AND valid = true
       AND created_at >= now() - ($4::int * interval '1 second')
     ORDER BY created_at DESC
     LIMIT 1`,
    [sourceId, dedupeKey, excludeDeliveryRowId, windowSeconds],
  );
  if (!row) return null;
  return { id: row.id, runId: (row.run_id ?? null) as RunId | null };
}

export async function markDeliverySuppressed(
  deliveryRowId: string,
  suppressedByRunId: RunId | null,
): Promise<void> {
  await execute(
    `UPDATE webhook_deliveries
     SET suppressed_by_run_id = $1
     WHERE id = $2`,
    [suppressedByRunId, deliveryRowId],
  );
}

export async function attachDeliveryRun(
  deliveryRowId: string,
  runId: RunId,
): Promise<void> {
  await execute(
    `UPDATE webhook_deliveries SET run_id = $1 WHERE id = $2`,
    [runId, deliveryRowId],
  );
}

export async function touchSourceLastTriggered(
  sourceId: WebhookSourceId,
): Promise<void> {
  await execute(
    `UPDATE webhook_sources SET last_triggered_at = now() WHERE id = $1`,
    [sourceId],
  );
}

export function buildPromptFromTemplate(
  template: string,
  payload: unknown,
  source: { name: string },
): string {
  let payloadText = JSON.stringify(payload, null, 2);
  if (payloadText.length > PAYLOAD_TRUNCATE_BYTES) {
    payloadText =
      payloadText.slice(0, PAYLOAD_TRUNCATE_BYTES) + PAYLOAD_TRUNCATION_MARKER;
  }
  return template
    .replace(/\{\{\s*source\.name\s*\}\}/g, source.name)
    .replace(/\{\{\s*payload\s*\}\}/g, payloadText);
}

export interface RotateSecretParams {
  tenantId: TenantId;
  sourceId: WebhookSourceId;
  overlapDays?: number;
}

export interface RotateSecretResult {
  secret: string;
  previousExpiresAt: Date;
}

export async function rotateSecret({
  tenantId,
  sourceId,
  overlapDays = ROTATION_OVERLAP_DAYS,
}: RotateSecretParams): Promise<RotateSecretResult> {
  const newSecret = generateWebhookSecret();
  const newSecretEnc = await encryptSecret(newSecret);

  return withTenantTransaction(tenantId, async (tx) => {
    const updated = await tx.queryOne(
      z.object({
        previous_secret_expires_at: z.coerce.date(),
      }),
      `UPDATE webhook_sources
       SET previous_secret_enc = secret_enc,
           previous_secret_expires_at = now() + ($1 || ' days')::interval,
           secret_enc = $2,
           updated_at = now()
       WHERE id = $3
       RETURNING previous_secret_expires_at`,
      [String(overlapDays), newSecretEnc, sourceId],
    );

    if (!updated) {
      throw new Error("webhook_source_not_found");
    }

    return {
      secret: newSecret,
      previousExpiresAt: updated.previous_secret_expires_at,
    };
  });
}

export interface CreateWebhookSourceParams {
  tenantId: TenantId;
  agentId: AgentId;
  name: string;
  promptTemplate: string;
  signatureHeader?: string;
  /** Caller-supplied signing secret. When omitted, the backend generates one. */
  secret?: string;
  enabled?: boolean;
}

export interface CreateWebhookSourceResult {
  source: WebhookSourceRow;
  secret: string;
}

export async function listWebhookSources(
  tenantId: TenantId,
  agentId?: AgentId,
): Promise<PublicWebhookSourceRow[]> {
  if (agentId) {
    return query(
      PublicWebhookSourceRow,
      `SELECT ${PUBLIC_SOURCE_COLUMNS}
       FROM webhook_sources
       WHERE tenant_id = $1 AND agent_id = $2
       ORDER BY created_at DESC`,
      [tenantId, agentId],
    );
  }
  return query(
    PublicWebhookSourceRow,
    `SELECT ${PUBLIC_SOURCE_COLUMNS}
     FROM webhook_sources
     WHERE tenant_id = $1
     ORDER BY created_at DESC`,
    [tenantId],
  );
}

export async function getWebhookSource(
  tenantId: TenantId,
  sourceId: WebhookSourceId,
): Promise<PublicWebhookSourceRow | null> {
  return queryOne(
    PublicWebhookSourceRow,
    `SELECT ${PUBLIC_SOURCE_COLUMNS}
     FROM webhook_sources
     WHERE id = $1 AND tenant_id = $2`,
    [sourceId, tenantId],
  );
}

export async function updateWebhookSource(
  tenantId: TenantId,
  sourceId: WebhookSourceId,
  patch: UpdateWebhookSourceInput,
): Promise<PublicWebhookSourceRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [sourceId, tenantId];
  let i = params.length;
  if (patch.name !== undefined) {
    params.push(patch.name);
    sets.push(`name = $${++i}`);
  }
  if (patch.prompt_template !== undefined) {
    params.push(patch.prompt_template);
    sets.push(`prompt_template = $${++i}`);
  }
  if (patch.signature_header !== undefined) {
    params.push(patch.signature_header);
    sets.push(`signature_header = $${++i}`);
  }
  if (patch.enabled !== undefined) {
    params.push(patch.enabled);
    sets.push(`enabled = $${++i}`);
  }
  if (sets.length === 0) return getWebhookSource(tenantId, sourceId);
  return queryOne(
    PublicWebhookSourceRow,
    `UPDATE webhook_sources
     SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $1 AND tenant_id = $2
     RETURNING ${PUBLIC_SOURCE_COLUMNS}`,
    params,
  );
}

export async function deleteWebhookSource(
  tenantId: TenantId,
  sourceId: WebhookSourceId,
): Promise<boolean> {
  const result = await execute(
    `DELETE FROM webhook_sources WHERE id = $1 AND tenant_id = $2`,
    [sourceId, tenantId],
  );
  return result.rowCount > 0;
}

export async function createWebhookSource(
  params: CreateWebhookSourceParams,
): Promise<CreateWebhookSourceResult> {
  const secret = params.secret ?? generateWebhookSecret();
  const secretEnc = await encryptSecret(secret);

  return withTenantTransaction(params.tenantId, async (tx) => {
    const source = await tx.queryOne(
      WebhookSourceRow,
      `INSERT INTO webhook_sources
         (tenant_id, agent_id, name, enabled, signature_header,
          secret_enc, prompt_template)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'X-AgentPlane-Signature'), $6, $7)
       RETURNING id, tenant_id, agent_id, name, enabled, signature_header,
                 signature_format, secret_enc, previous_secret_enc,
                 previous_secret_expires_at, prompt_template, last_triggered_at,
                 created_at, updated_at`,
      [
        params.tenantId,
        params.agentId,
        params.name,
        params.enabled ?? true,
        params.signatureHeader ?? null,
        secretEnc,
        params.promptTemplate,
      ],
    );
    if (!source) throw new Error("webhook_source_insert_failed");
    return { source, secret };
  });
}
