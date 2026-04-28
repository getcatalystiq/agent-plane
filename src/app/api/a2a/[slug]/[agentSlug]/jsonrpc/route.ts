import { NextRequest, NextResponse } from "next/server";
import {
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
} from "@a2a-js/sdk/server";
import type { JSONRPCResponse, Message } from "@a2a-js/sdk";
import { withErrorHandler } from "@/lib/api";
import { authenticateA2aRequest } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { RateLimitError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getHttpClient } from "@/db";
import { AgentRowInternal } from "@/lib/validation";
import { supportsClaudeRunner } from "@/lib/models";
import { z } from "zod";
import {
  a2aHeaders,
  buildAgentCard,
  getOrBuildAgentCard,
  MessageBackedTaskStore,
  SandboxAgentExecutor,
  validateA2aMessage,
  sanitizeRequestId,
} from "@/lib/a2a";
import { getIdempotentResponse, setIdempotentResponse } from "@/lib/idempotency";
import { getCallbackBaseUrl } from "@/lib/mcp-connections";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // 55s poll + overhead

const MAX_BODY_SIZE = 1_048_576; // 1MB

const TenantForBudgetRow = z.object({
  id: z.string(),
  name: z.string(),
  monthly_budget_usd: z.coerce.number(),
  current_month_spend: z.coerce.number(),
  has_subscription_token: z.boolean(),
});

type RouteContext = { params: Promise<{ slug: string; agentSlug: string }> };

export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const { slug: tenantSlug, agentSlug } = await (context as RouteContext).params;
  const requestId = sanitizeRequestId(request.headers.get("a2a-request-id"));

  // Auth by tenant slug
  const auth = await authenticateA2aRequest(
    request.headers.get("authorization"),
    tenantSlug,
  );

  // Rate limit: 100 req/min per tenant
  const rl = checkRateLimit(`a2a-rpc:${auth.tenantId}`, 100, 60_000);
  if (!rl.allowed) {
    logger.warn("A2A JSON-RPC rate limited", { tenant_id: auth.tenantId, tenantSlug, agentSlug });
    throw new RateLimitError(Math.ceil(rl.retryAfterMs / 1000));
  }

  // Read and validate body size
  const bodyText = await request.text();
  if (bodyText.length > MAX_BODY_SIZE) {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32600, message: "Request body exceeds 1MB limit" }, id: null },
      { status: 200, headers: a2aHeaders(requestId) },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null },
      { status: 200, headers: a2aHeaders(requestId) },
    );
  }

  // Idempotency support on message/send
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey && body.method === "message/send") {
    const cachedResponse = getIdempotentResponse(`a2a:${auth.tenantId}:${idempotencyKey}`);
    if (cachedResponse) {
      return NextResponse.json(cachedResponse, {
        status: 200,
        headers: a2aHeaders(requestId),
      });
    }
  }

  // Validate inbound message for send methods
  if (body.method === "message/send" || body.method === "message/stream") {
    const params = body.params as Record<string, unknown> | undefined;
    const message = params?.message as Record<string, unknown> | undefined;
    if (message) {
      const validationError = validateA2aMessage(message as unknown as Message);
      if (validationError) {
        return NextResponse.json(
          { jsonrpc: "2.0", error: { code: -32602, message: validationError }, id: body.id ?? null },
          { status: 200, headers: a2aHeaders(requestId) },
        );
      }
    }
  }

  // Resolve tenant info for budget enforcement (PK lookup — auth already verified tenantId)
  const sql = getHttpClient();
  const tenantRows = await sql`
    SELECT id, name, monthly_budget_usd, current_month_spend,
           subscription_token_enc IS NOT NULL AS has_subscription_token
    FROM tenants WHERE id = ${auth.tenantId} AND status = 'active'
  `;
  if (tenantRows.length === 0) {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Agent not found" }, id: body.id ?? null },
      { status: 200, headers: a2aHeaders(requestId) },
    );
  }
  const tenant = TenantForBudgetRow.parse(tenantRows[0]);

  // Resolve agent by slug — fail fast if not A2A-enabled
  const agentRows = await sql`
    SELECT * FROM agents
    WHERE tenant_id = ${auth.tenantId}
      AND slug = ${agentSlug}
      AND a2a_enabled = true
  `;
  if (agentRows.length === 0) {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Agent not found" }, id: body.id ?? null },
      { status: 200, headers: a2aHeaders(requestId) },
    );
  }
  const agent = AgentRowInternal.parse(agentRows[0]);

  // Best-effort budget gate — authoritative check is inside dispatchSessionMessage() (transactional)
  // Subscription runs (Claude model + subscription token) bypass budget enforcement
  const isSubscriptionRun = tenant.has_subscription_token && supportsClaudeRunner(agent.model);
  if (!isSubscriptionRun && tenant.current_month_spend >= tenant.monthly_budget_usd) {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Monthly budget exceeded" }, id: body.id ?? null },
      { status: 200, headers: a2aHeaders(requestId) },
    );
  }
  const remainingBudget = isSubscriptionRun
    ? Infinity
    : tenant.monthly_budget_usd - tenant.current_month_spend;

  const baseUrl = getCallbackBaseUrl();

  // Build/cache agent card with per-agent cache key
  const cacheKey = `${tenantSlug}:${agentSlug}`;
  const agentCard = await getOrBuildAgentCard(cacheKey, () =>
    buildAgentCard({
      agentId: agent.id,
      agentSlug,
      tenantSlug,
      tenantName: tenant.name,
      baseUrl,
    }),
  );

  if (!agentCard) {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Agent not found" }, id: body.id ?? null },
      { status: 200, headers: a2aHeaders(requestId) },
    );
  }

  // Extract budget from A2A metadata
  const params = body.params as Record<string, unknown> | undefined;
  const msgMeta = (params?.message as Record<string, unknown> | undefined)?.metadata as Record<string, unknown> | undefined;
  const apMeta = msgMeta?.["agent-plane"] as Record<string, unknown> | undefined;
  const requestedMaxBudget = typeof apMeta?.max_budget_usd === "number" ? apMeta.max_budget_usd : undefined;

  // Create SDK components per-request
  const taskStore = new MessageBackedTaskStore(auth.tenantId, auth.apiKeyId);
  const executor = new SandboxAgentExecutor({
    tenantId: auth.tenantId,
    agent,
    createdByKeyId: auth.apiKeyId,
    platformApiUrl: baseUrl,
    remainingBudget,
    requestedMaxBudget,
  });

  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);
  const transportHandler = new JsonRpcTransportHandler(requestHandler);

  const serverContext = new ServerCallContext(undefined, {
    get isAuthenticated() { return true; },
    get userName() { return auth.apiKeyName; },
  });

  const result = await transportHandler.handle(body, serverContext);

  // Check if result is AsyncGenerator (streaming)
  if (result && typeof result === "object" && Symbol.asyncIterator in result) {
    const generator = result as AsyncGenerator<JSONRPCResponse, void, undefined>;
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
        try {
          heartbeatInterval = setInterval(() => {
            try { controller.enqueue(encoder.encode(": heartbeat\n\n")); } catch { /* stream closed */ }
          }, 15_000);

          for await (const event of generator) {
            const data = JSON.stringify(event);
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (err) {
          logger.error("A2A streaming error", {
            tenantSlug,
            agentSlug,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          if (heartbeatInterval) clearInterval(heartbeatInterval);
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        ...a2aHeaders(requestId),
      },
    });
  }

  // Non-streaming response
  const jsonResult = result as JSONRPCResponse;

  if (idempotencyKey && body.method === "message/send") {
    setIdempotentResponse(`a2a:${auth.tenantId}:${idempotencyKey}`, jsonResult);
  }

  return NextResponse.json(jsonResult, {
    status: 200,
    headers: a2aHeaders(requestId),
  });
});
