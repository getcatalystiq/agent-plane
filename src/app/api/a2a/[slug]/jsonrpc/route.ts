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
import { z } from "zod";
import {
  a2aHeaders,
  buildAgentCard,
  getCachedAgentCard,
  setCachedAgentCard,
  RunBackedTaskStore,
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
});

export const POST = withErrorHandler(async (
  request: NextRequest,
  context,
) => {
  const { slug } = await context!.params;
  const requestId = sanitizeRequestId(request.headers.get("a2a-request-id"));

  // Auth
  const auth = await authenticateA2aRequest(
    request.headers.get("authorization"),
    slug,
  );

  // Rate limit: 100 req/min per tenant
  const rl = checkRateLimit(`a2a-rpc:${auth.tenantId}`, 100, 60_000);
  if (!rl.allowed) {
    logger.warn("A2A JSON-RPC rate limited", { tenant_id: auth.tenantId, slug });
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

  // Resolve tenant info for budget enforcement
  const sql = getHttpClient();
  const tenantRows = await sql`
    SELECT id, name, monthly_budget_usd, current_month_spend
    FROM tenants WHERE slug = ${slug} AND status = 'active'
  `;
  if (tenantRows.length === 0) {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Agent not found" }, id: body.id ?? null },
      { status: 200, headers: a2aHeaders(requestId) },
    );
  }
  const tenant = TenantForBudgetRow.parse(tenantRows[0]);

  // Best-effort budget gate — the authoritative check is inside createRun() (transactional).
  // This early check avoids unnecessary work for clearly over-budget tenants.
  if (tenant.current_month_spend >= tenant.monthly_budget_usd) {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Monthly budget exceeded" }, id: body.id ?? null },
      { status: 200, headers: a2aHeaders(requestId) },
    );
  }
  const remainingBudget = tenant.monthly_budget_usd - tenant.current_month_spend;

  // Use trusted baseUrl from env (not request headers — prevents cache poisoning)
  const baseUrl = getCallbackBaseUrl();

  let agentCard = getCachedAgentCard(slug);
  if (!agentCard) {
    agentCard = await buildAgentCard(tenant.id, slug, tenant.name, baseUrl);
    if (!agentCard) {
      return NextResponse.json(
        { jsonrpc: "2.0", error: { code: -32001, message: "No A2A-enabled agents found" }, id: body.id ?? null },
        { status: 200, headers: a2aHeaders(requestId) },
      );
    }
    setCachedAgentCard(slug, agentCard);
  }

  // Extract budget from A2A metadata
  const params = body.params as Record<string, unknown> | undefined;
  const msgMeta = (params?.message as Record<string, unknown> | undefined)?.metadata as Record<string, unknown> | undefined;
  const apMeta = msgMeta?.["agent-plane"] as Record<string, unknown> | undefined;
  const requestedMaxBudget = typeof apMeta?.max_budget_usd === "number" ? apMeta.max_budget_usd : undefined;

  // Create SDK components per-request
  const taskStore = new RunBackedTaskStore(auth.tenantId, auth.apiKeyId);
  const executor = new SandboxAgentExecutor({
    tenantId: auth.tenantId,
    createdByKeyId: auth.apiKeyId,
    platformApiUrl: baseUrl,
    remainingBudget,
    requestedMaxBudget,
  });

  const requestHandler = new DefaultRequestHandler(
    agentCard,
    taskStore,
    executor,
  );

  const transportHandler = new JsonRpcTransportHandler(requestHandler);

  // Create ServerCallContext
  const serverContext = new ServerCallContext(undefined, {
    get isAuthenticated() { return true; },
    get userName() { return auth.apiKeyName; },
  });

  // Handle the request
  const result = await transportHandler.handle(body, serverContext);

  // Check if result is AsyncGenerator (streaming)
  if (result && typeof result === "object" && Symbol.asyncIterator in result) {
    // Streaming response — pipe as SSE
    const generator = result as AsyncGenerator<JSONRPCResponse, void, undefined>;
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
        try {
          // Heartbeat every 15s
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
            slug,
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

  // Cache idempotent response
  if (idempotencyKey && body.method === "message/send") {
    setIdempotentResponse(`a2a:${auth.tenantId}:${idempotencyKey}`, jsonResult);
  }

  return NextResponse.json(jsonResult, {
    status: 200,
    headers: a2aHeaders(requestId),
  });
});
