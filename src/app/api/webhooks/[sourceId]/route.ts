import { NextRequest, NextResponse, after } from "next/server";
import { execute, queryOne } from "@/db";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { dispatchSessionMessage } from "@/lib/dispatcher";
import { transitionMessageStatus } from "@/lib/session-messages";
import { getCallbackBaseUrl } from "@/lib/mcp-connections";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { NotFoundError, ConcurrencyLimitError, BudgetExceededError } from "@/lib/errors";
import { AgentRowInternal } from "@/lib/validation";
import { checkTenantBudget } from "@/lib/session-messages";
import { withTenantTransaction } from "@/db";
import { MAX_CONCURRENT_SESSIONS } from "@/lib/sessions";
import { supportsClaudeRunner } from "@/lib/models";
import {
  UpdateWebhookSourceSchema,
  attachDeliveryMessage,
  buildPromptFromTemplate,
  deleteWebhookSource,
  findRecentDeliveryByDedupeKey,
  getWebhookSource,
  loadWebhookSource,
  markDeliveryFiltered,
  markDeliverySuppressed,
  recordDelivery,
  touchSourceLastTriggered,
  updateWebhookSource,
  verifyAndPrepare,
  type DeliveryError,
} from "@/lib/webhooks";
import { computeDedupeKey } from "@/lib/webhook-dedupe";
import { describeMismatchReason, evaluateFilter } from "@/lib/webhook-filter";
import type {
  AgentId,
  TenantId,
  WebhookSourceId,
} from "@/lib/types";

export const dynamic = "force-dynamic";
// 5 min cap matches sessions endpoints and /api/cron/scheduled-runs. The POST
// replies 202 in milliseconds, but `after()` consumes the dispatcher stream
// inline and is bound by this maxDuration — a lower cap kills the agent mid-run.
export const maxDuration = 300;

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
      messageId: null,
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
      messageId: null,
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
    messageId: null,
    dedupeKey: dedupeContext.key,
  });

  if (initialDelivery.kind === "duplicate") {
    // FIX #33: replace literal `_` placeholder with the real session id when
    // the original delivery has been attached to a message. If the prior
    // delivery hasn't attached a message yet (background dispatch lost or
    // still in-flight), surface message_id without a status_url instead of
    // returning a broken URL.
    let statusUrl: string | null = null;
    if (initialDelivery.existingMessageId) {
      const sessionRow = await queryOne(
        z.object({ session_id: z.string() }),
        "SELECT session_id FROM session_messages WHERE id = $1 AND tenant_id = $2",
        [initialDelivery.existingMessageId, source.tenant_id],
      ).catch(() => null);
      if (sessionRow) {
        statusUrl = `/api/sessions/${sessionRow.session_id}/messages/${initialDelivery.existingMessageId}`;
      }
    }
    return NextResponse.json(
      {
        message_id: initialDelivery.existingMessageId,
        duplicate: true,
        status_url: statusUrl,
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
          match.messageId,
        ).catch(() => {});
        logger.info("webhook_dedupe_suppressed", {
          source_id: source.id,
          provider: dedupeContext.provider,
          dedupe_key: dedupeContext.key.slice(0, 80),
          matched_message_id: match.messageId,
          window_seconds: dedupeContext.rule.windowSeconds,
        });
        // FIX #33: same fix for content-dedupe suppression path — look up
        // the real session id rather than returning `/_/`.
        let suppressedStatusUrl: string | null = null;
        if (match.messageId) {
          const sessionRow = await queryOne(
            z.object({ session_id: z.string() }),
            "SELECT session_id FROM session_messages WHERE id = $1 AND tenant_id = $2",
            [match.messageId, source.tenant_id],
          ).catch(() => null);
          if (sessionRow) {
            suppressedStatusUrl = `/api/sessions/${sessionRow.session_id}/messages/${match.messageId}`;
          }
        }
        return NextResponse.json(
          {
            message_id: match.messageId,
            duplicate: true,
            status_url: suppressedStatusUrl,
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

  // Content filter: runs after dedupe, before dispatch. The evaluator owns
  // try/catch end-to-end — it returns either {matched: true} or
  // {matched: false, failingCondition?, error?}. Mismatch (including
  // evaluator errors) marks the delivery filtered + audited and short-circuits
  // with a 200 response. No dispatch, no after().
  const filterEval = evaluateFilter(source.filter_rules, payload);
  if (!filterEval.matched) {
    const reason = describeMismatchReason(filterEval);
    await markDeliveryFiltered(initialDelivery.deliveryRowId, reason).catch(() => {});
    if (filterEval.error) {
      logger.info("webhook_filter_evaluator_error", {
        source_id: source.id,
        error: filterEval.error,
      });
    } else {
      logger.info("webhook_filter_dropped", {
        source_id: source.id,
        failing_condition: filterEval.failingCondition,
      });
    }
    return NextResponse.json(
      {
        message_id: null,
        accepted: false,
        filtered: true,
        status_url: null,
      },
      { status: 200 },
    );
  }

  // U4: pre-flight concurrency rejection. The dispatcher itself enforces the
  // tenant cap atomically inside its transaction, but if it's already saturated
  // we want to surface a 503 to the caller (so they retry) rather than 202'ing
  // and silently failing in `after()`.
  const tenantId = source.tenant_id as TenantId;
  const agentId = source.agent_id as AgentId;
  const sourceWebhookId = source.id as WebhookSourceId;

  // FIX #7: pre-flight cap + budget check. The previous comment promised this
  // but the code did not implement it — concurrency / budget errors thrown
  // inside `after()` were swallowed and the caller got 202. Distinguish:
  //   - 503 concurrency_exceeded   (with Retry-After: 60)
  //   - 503 budget_exceeded
  //   - 500 internal_error         (anything else)
  // Non-mutating count (no FOR UPDATE / advisory lock); the dispatcher's
  // transactional check is still authoritative.
  try {
    const countRow = await queryOne(
      z.object({ count: z.coerce.number() }),
      `SELECT COUNT(*)::int AS count
       FROM sessions
       WHERE tenant_id = $1 AND status IN ('creating', 'active')`,
      [tenantId],
    );
    if (countRow && countRow.count >= MAX_CONCURRENT_SESSIONS) {
      await markDeliveryError(initialDelivery.deliveryRowId, "rate_limited").catch(() => {});
      return NextResponse.json(
        {
          error: {
            code: "concurrency_exceeded",
            message: `Tenant has ${countRow.count} active sessions (cap ${MAX_CONCURRENT_SESSIONS})`,
          },
        },
        { status: 503, headers: { "Retry-After": "60" } },
      );
    }
  } catch (err) {
    logger.warn("webhook pre-flight concurrency check failed (non-fatal)", {
      source_id: source.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Pre-flight budget check. Loads the agent (needed for subscription detection)
  // and runs the same checkTenantBudget logic the dispatcher uses inside its tx.
  try {
    const agent = await queryOne(
      AgentRowInternal,
      "SELECT * FROM agents WHERE id = $1 AND tenant_id = $2",
      [agentId, tenantId],
    );
    if (!agent) {
      await markDeliveryError(initialDelivery.deliveryRowId, "internal_error").catch(() => {});
      return NextResponse.json(
        { error: { code: "internal_error", message: "Agent not found" } },
        { status: 500 },
      );
    }
    const isSubscriptionRun = supportsClaudeRunner(agent.model);
    await withTenantTransaction(tenantId, async (tx) => {
      await checkTenantBudget(tx, tenantId, { isSubscriptionRun });
    });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      // FIX #24: distinct delivery_error code for budget overruns.
      await markDeliveryError(initialDelivery.deliveryRowId, "budget_exceeded").catch(() => {});
      return NextResponse.json(
        {
          error: { code: "budget_exceeded", message: err.message },
        },
        { status: 503, headers: { "Retry-After": "300" } },
      );
    }
    logger.warn("webhook pre-flight budget check failed (non-fatal)", {
      source_id: source.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const prompt = buildPromptFromTemplate(source.prompt_template, payload, { name: source.name });

  // Respond 202 immediately, then dispatch in the background. Webhook senders
  // (Linear, GitHub, …) retry if we don't 2xx within ~5 seconds. The dispatcher
  // touches the DB, runs concurrency + budget checks, and starts sandbox prep
  // — too slow for the inline path. Idempotency is preserved by the
  // recordDelivery row above: a retry with the same delivery_id hits the
  // duplicate branch and returns the original response shape.
  after(async () => {
    let messageId: string | null = null;
    let tenantIdForFinalize: TenantId | null = null;
    try {
      const dispatchResult = await dispatchSessionMessage({
        tenantId,
        agentId,
        prompt,
        triggeredBy: "webhook",
        ephemeral: true,
        callerKeyId: null,
        webhookSourceId: sourceWebhookId,
        platformApiUrl: getCallbackBaseUrl(),
      });
      messageId = dispatchResult.messageId;
      tenantIdForFinalize = tenantId;

      await Promise.all([
        attachDeliveryMessage(initialDelivery.deliveryRowId, messageId),
        touchSourceLastTriggered(sourceWebhookId),
      ]).catch((err) => {
        logger.warn("webhook post-dispatch attach failed", {
          source_id: source.id,
          message_id: messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      // Drain the dispatcher stream so the message actually executes — the
      // dispatcher returns a ReadableStream that produces work as it's
      // consumed, and finalize hooks fire in the stream's natural-close path.
      // We don't relay events anywhere (webhook is fire-and-forget), so just
      // pull bytes until EOF. The 5-min `maxDuration` bounds this.
      const reader = dispatchResult.stream.getReader();
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } finally {
        try { reader.releaseLock(); } catch { /* ignore */ }
      }
    } catch (err) {
      // FIX #24: budget overruns deserve a distinct delivery error code so
      // observability and admin views can distinguish "agent ran out of money"
      // from a generic internal failure. The rate-limit branch is unchanged.
      let code: DeliveryError = "internal_error";
      if (err instanceof ConcurrencyLimitError) code = "rate_limited";
      else if (err instanceof BudgetExceededError) code = "budget_exceeded";
      await markDeliveryError(initialDelivery.deliveryRowId, code).catch(() => {});
      // If the message was created but execution threw, transition it to
      // failed so it doesn't sit in `running` until the cleanup cron times it
      // out.
      if (messageId && tenantIdForFinalize) {
        await transitionMessageStatus(
          messageId,
          tenantIdForFinalize,
          "running",
          "failed",
          {
            completed_at: new Date().toISOString(),
            error_type: "webhook_execution_error",
            error_messages: [err instanceof Error ? err.message : String(err)],
          },
        ).catch(() => {});
      }
      logger.warn("webhook dispatch failed (background)", {
        source_id: source.id,
        delivery_id: deliveryId,
        message_id: messageId,
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
