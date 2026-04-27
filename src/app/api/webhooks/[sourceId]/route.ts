import { NextRequest, NextResponse, after } from "next/server";
import { execute } from "@/db";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { createRun, transitionRunStatus } from "@/lib/runs";
import { executeRunInBackground } from "@/lib/run-executor";
import { getCallbackBaseUrl } from "@/lib/mcp-connections";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { NotFoundError, ConcurrencyLimitError, BudgetExceededError } from "@/lib/errors";
import {
  UpdateWebhookSourceSchema,
  attachDeliveryRun,
  buildPromptFromTemplate,
  deleteWebhookSource,
  findRecentDeliveryByDedupeKey,
  getWebhookSource,
  loadWebhookSource,
  markDeliverySuppressed,
  recordDelivery,
  touchSourceLastTriggered,
  updateWebhookSource,
  verifyAndPrepare,
  type DeliveryError,
} from "@/lib/webhooks";
import { computeDedupeKey } from "@/lib/webhook-dedupe";
import type {
  AgentId,
  RunId,
  TenantId,
  WebhookSourceId,
} from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BODY_BYTES = 512 * 1024;
const RATE_WINDOW_MS = 60_000;
const PER_SOURCE_LIMIT = 60;
const PER_TENANT_LIMIT = 600;

const HEADER_TIMESTAMP = "webhook-timestamp";
const HEADER_DELIVERY_ID = "webhook-delivery-id";

// Common provider-specific headers carrying a per-delivery unique id. Tried in
// order when the canonical `webhook-delivery-id` header is missing.
const DELIVERY_ID_HEADER_FALLBACKS = [
  "x-github-delivery",        // GitHub
  "linear-delivery",          // Linear (sometimes)
  "x-vercel-id",              // Vercel
  "x-shopify-webhook-id",     // Shopify
  "webhook-id",               // Svix-style (Stripe via Svix, etc.)
  "x-render-event-id",        // Render
];

// Body field names commonly carrying the delivery id when no header does.
const DELIVERY_ID_BODY_FIELDS = ["delivery", "delivery_id", "event_id"];

/**
 * Resolve a per-delivery unique id from headers, body, or a deterministic
 * fallback hash. Lets webhooks from providers that don't send our canonical
 * `webhook-delivery-id` header still be deduped.
 */
async function resolveDeliveryId(
  request: NextRequest,
  body: string,
): Promise<string> {
  const canonical = request.headers.get(HEADER_DELIVERY_ID);
  if (canonical) return canonical;

  for (const name of DELIVERY_ID_HEADER_FALLBACKS) {
    const v = request.headers.get(name);
    if (v) return v;
  }

  if (body) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;

      // Linear-style: `webhookId` (source-level UUID) + `webhookTimestamp`
      // (per-delivery millis). Combination is unique per delivery and stable
      // across retries (Linear retries with the same payload).
      const wid = parsed.webhookId;
      const wts = parsed.webhookTimestamp;
      if (typeof wid === "string" && (typeof wts === "string" || typeof wts === "number")) {
        return `linear_${wid}_${wts}`;
      }

      // Generic body fields (Stripe, GitHub-as-body, etc.).
      for (const field of DELIVERY_ID_BODY_FIELDS) {
        const v = parsed[field];
        if (typeof v === "string" && v.length > 0) return v;
      }

      // Last body-based attempt: top-level `id` IF the payload also has an
      // event identifier hint (rules out using a primary entity's id like
      // an issue.id which would be the same across update events).
      const id = parsed.id;
      const hasEventHint = typeof parsed.type === "string" || typeof parsed.action === "string" || typeof parsed.event === "string";
      if (typeof id === "string" && id.length > 0 && hasEventHint) {
        return id;
      }
    } catch {
      // Body isn't JSON — fall through.
    }
  }

  // Deterministic fallback: hash of the body alone. Same body bytes on retry
  // dedupe; distinct events naturally have distinct bodies. Intentionally
  // does NOT include the request timestamp header (it varies across retries).
  return "synthetic_" + (await sha256Hex(body)).slice(0, 32);
}

function genericUnauthorized(): NextResponse {
  return NextResponse.json(
    { error: { code: "unauthorized", message: "Unauthorized" } },
    { status: 401 },
  );
}

async function readLimitedBody(req: NextRequest, maxBytes: number): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared) {
    const n = Number.parseInt(declared, 10);
    if (Number.isFinite(n) && n > maxBytes) return null;
  }

  const reader = req.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return null;
    }
    chunks.push(value);
  }

  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input).buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function markDeliveryError(deliveryRowId: string, error: DeliveryError): Promise<void> {
  await execute(
    `UPDATE webhook_deliveries SET valid = false, error = $1 WHERE id = $2`,
    [error, deliveryRowId],
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sourceId: string }> },
): Promise<NextResponse> {
  const { sourceId } = await context.params;

  const sourceLimit = checkRateLimit(`webhook:source:${sourceId}`, PER_SOURCE_LIMIT, RATE_WINDOW_MS);
  if (!sourceLimit.allowed) {
    return NextResponse.json(
      { error: { code: "rate_limited", message: "Too many requests" } },
      { status: 429, headers: { "Retry-After": String(Math.ceil(sourceLimit.retryAfterMs / 1000)) } },
    );
  }

  const source = await loadWebhookSource(sourceId as WebhookSourceId);
  if (!source || !source.enabled) {
    return genericUnauthorized();
  }

  const tenantLimit = checkRateLimit(
    `webhook:tenant:${source.tenant_id}`,
    PER_TENANT_LIMIT,
    RATE_WINDOW_MS,
  );
  if (!tenantLimit.allowed) {
    return NextResponse.json(
      { error: { code: "rate_limited", message: "Too many requests" } },
      { status: 429, headers: { "Retry-After": String(Math.ceil(tenantLimit.retryAfterMs / 1000)) } },
    );
  }

  const sigHeaderName = source.signature_header.toLowerCase();
  const signature = request.headers.get(sigHeaderName);
  const timestamp = request.headers.get(HEADER_TIMESTAMP);

  const rawBody = await readLimitedBody(request, MAX_BODY_BYTES);
  if (rawBody === null) {
    return NextResponse.json(
      { error: { code: "payload_too_large", message: "Body exceeds 512KB" } },
      { status: 413 },
    );
  }

  // Resolve delivery id from canonical header → provider-specific header →
  // body field → synthetic hash. Providers like Linear put the delivery UUID
  // in the JSON body rather than a header.
  const deliveryId = await resolveDeliveryId(request, rawBody);

  const payloadHash = await sha256Hex(rawBody);

  const verifyResult = await verifyAndPrepare(source, signature, timestamp, rawBody);
  if (!verifyResult.ok) {
    await recordDelivery({
      tenantId: source.tenant_id as TenantId,
      sourceId: source.id as WebhookSourceId,
      deliveryId,
      payloadHash,
      valid: false,
      error: verifyResult.error,
      runId: null,
    });
    return genericUnauthorized();
  }

  let payload: unknown;
  try {
    payload = rawBody.length === 0 ? {} : JSON.parse(rawBody);
  } catch {
    await recordDelivery({
      tenantId: source.tenant_id as TenantId,
      sourceId: source.id as WebhookSourceId,
      deliveryId,
      payloadHash,
      valid: false,
      error: "invalid_json",
      runId: null,
    });
    return NextResponse.json(
      { error: { code: "invalid_json", message: "Body is not valid JSON" } },
      { status: 400 },
    );
  }

  // Content-based dedupe layer (failure-open). Resolves the rule for this
  // tenant + provider, extracts the configured key from the payload, and
  // persists it on the delivery row so a window-based lookup can suppress
  // logical duplicates whose `delivery_id` differs.
  let dedupeContext: Awaited<ReturnType<typeof computeDedupeKey>> = {
    key: null,
    rule: null,
    provider: "custom",
  };
  try {
    dedupeContext = await computeDedupeKey(
      source.tenant_id,
      source.signature_header,
      payload,
    );
  } catch (err) {
    logger.warn("webhook_dedupe_compute_failed", {
      source_id: source.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const initialDelivery = await recordDelivery({
    tenantId: source.tenant_id as TenantId,
    sourceId: source.id as WebhookSourceId,
    deliveryId,
    payloadHash,
    valid: true,
    error: null,
    runId: null,
    dedupeKey: dedupeContext.key,
  });

  if (initialDelivery.kind === "duplicate") {
    return NextResponse.json(
      {
        run_id: initialDelivery.existingRunId,
        duplicate: true,
        status_url: initialDelivery.existingRunId ? `/api/runs/${initialDelivery.existingRunId}` : null,
      },
      { status: 200 },
    );
  }

  // Content-dedupe window lookup. Runs only when a rule resolved AND the key
  // extracted cleanly. Failure-open: any throw here lets the run proceed.
  if (dedupeContext.key && dedupeContext.rule) {
    try {
      const match = await findRecentDeliveryByDedupeKey(
        source.id as WebhookSourceId,
        dedupeContext.key,
        dedupeContext.rule.windowSeconds,
        initialDelivery.deliveryRowId,
      );
      if (match) {
        await markDeliverySuppressed(
          initialDelivery.deliveryRowId,
          match.runId,
        ).catch(() => {});
        logger.info("webhook_dedupe_suppressed", {
          source_id: source.id,
          provider: dedupeContext.provider,
          dedupe_key: dedupeContext.key.slice(0, 80),
          matched_run_id: match.runId,
          window_seconds: dedupeContext.rule.windowSeconds,
        });
        return NextResponse.json(
          {
            run_id: match.runId,
            duplicate: true,
            status_url: match.runId ? `/api/runs/${match.runId}` : null,
          },
          { status: 200 },
        );
      }
    } catch (err) {
      logger.warn("webhook_dedupe_lookup_failed", {
        source_id: source.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const prompt = buildPromptFromTemplate(source.prompt_template, payload, { name: source.name });

  // Respond 202 immediately, then create the run in the background. Linear
  // (and most webhook senders) retry if we don't 2xx within ~5 seconds.
  // createRun touches the DB, runs concurrency + budget checks, and starts
  // sandbox prep — too slow for the inline path. Idempotency is preserved by
  // the recordDelivery row above: a retry with the same delivery_id hits the
  // duplicate branch and returns the original response shape.
  after(async () => {
    let runId: RunId | null = null;
    try {
      const created = await createRun(
        source.tenant_id as TenantId,
        source.agent_id as AgentId,
        prompt,
        {
          triggeredBy: "webhook",
          webhookSourceId: source.id as WebhookSourceId,
        },
      );
      runId = created.run.id as RunId;
      await Promise.all([
        attachDeliveryRun(initialDelivery.deliveryRowId, runId),
        touchSourceLastTriggered(source.id as WebhookSourceId),
      ]).catch((err) => {
        logger.warn("webhook post-create attach failed", {
          source_id: source.id,
          run_id: runId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      // createRun only inserts the row in `pending` state. Without an executor
      // the run sits there forever and the cleanup cron eventually marks it
      // `timed_out` / `orphaned_sandbox`. Execute inline so the agent actually
      // runs against the webhook payload.
      const effectiveBudget = Math.min(created.agent.max_budget_usd, created.remainingBudget);
      await executeRunInBackground({
        agent: created.agent,
        tenantId: source.tenant_id as TenantId,
        runId,
        prompt,
        platformApiUrl: getCallbackBaseUrl(),
        effectiveBudget,
        effectiveMaxTurns: created.agent.max_turns,
        maxRuntimeSeconds: created.agent.max_runtime_seconds,
      });
    } catch (err) {
      let code: DeliveryError = "internal_error";
      if (err instanceof ConcurrencyLimitError) code = "rate_limited";
      else if (err instanceof BudgetExceededError) code = "internal_error";
      await markDeliveryError(initialDelivery.deliveryRowId, code).catch(() => {});
      // If the run was created but execution threw, transition it to failed
      // so it doesn't sit in `pending` until the cleanup cron times it out.
      if (runId) {
        await transitionRunStatus(runId, source.tenant_id as TenantId, "pending", "failed", {
          completed_at: new Date().toISOString(),
          result_summary: "Webhook execution failed",
        }).catch(() => {});
      }
      logger.warn("webhook run creation failed (background)", {
        source_id: source.id,
        delivery_id: deliveryId,
        run_id: runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return NextResponse.json(
    {
      delivery_id: deliveryId,
      accepted: true,
      source_name: source.name,
    },
    { status: 202 },
  );
}

// ─── Tenant CRUD (auth required) ──────────────────────────────────────────────
//
// Co-located with the public ingress POST above. The `sourceId` URL segment is
// the same identifier in both flows; auth is enforced per-method.

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { sourceId } = await context!.params;
  const source = await getWebhookSource(auth.tenantId, sourceId as WebhookSourceId);
  if (!source) throw new NotFoundError("Webhook source not found");
  return jsonResponse(source);
});

export const PATCH = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { sourceId } = await context!.params;
  const body = await request.json();
  const patch = UpdateWebhookSourceSchema.parse(body);
  const source = await updateWebhookSource(auth.tenantId, sourceId as WebhookSourceId, patch);
  if (!source) throw new NotFoundError("Webhook source not found");
  return jsonResponse(source);
});

export const DELETE = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { sourceId } = await context!.params;
  const removed = await deleteWebhookSource(auth.tenantId, sourceId as WebhookSourceId);
  if (!removed) throw new NotFoundError("Webhook source not found");
  return jsonResponse({ deleted: true });
});
