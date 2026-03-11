import { NextRequest, NextResponse } from "next/server";
import {
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
  A2AError,
} from "@a2a-js/sdk/server";
import type { JSONRPCResponse } from "@a2a-js/sdk";
import { withErrorHandler } from "@/lib/api";
import { authenticateA2aRequest } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { RateLimitError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { checkTenantBudget } from "@/lib/runs";
import { getHttpClient } from "@/db";
import { z } from "zod";
import {
  buildAgentCard,
  getCachedAgentCard,
  setCachedAgentCard,
  RunBackedTaskStore,
  SandboxAgentExecutor,
  validateA2aMessage,
  sanitizeRequestId,
} from "@/lib/a2a";
import { getIdempotentResponse, setIdempotentResponse } from "@/lib/idempotency";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // 55s poll + overhead

const MAX_BODY_SIZE = 1_048_576; // 1MB

const TenantForBudgetRow = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["active", "suspended"]),
  monthly_budget_usd: z.coerce.number(),
  current_month_spend: z.coerce.number(),
});

export const POST = withErrorHandler(async (
  request: NextRequest,
  context,
) => {
  const { slug } = await context!.params;
  const requestId = sanitizeRequestId(request.headers.get("a2a-request-id"));

  // Enforce body size limit via Content-Length
  const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
  if (contentLength > MAX_BODY_SIZE) {
    return NextResponse.json(
      { error: { code: "payload_too_large", message: "Request body exceeds 1MB limit" } },
      {
        status: 413,
        headers: { "A2A-Version": "1.0", "A2A-Request-Id": requestId },
      },
    );
  }

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

  // Read and validate body size (streaming counter for bodies without Content-Length)
  const bodyText = await request.text();
  if (bodyText.length > MAX_BODY_SIZE) {
    return NextResponse.json(
      { error: { code: "payload_too_large", message: "Request body exceeds 1MB limit" } },
      {
        status: 413,
        headers: { "A2A-Version": "1.0", "A2A-Request-Id": requestId },
      },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null },
      {
        status: 200, // JSON-RPC errors are always 200
        headers: { "A2A-Version": "1.0", "A2A-Request-Id": requestId },
      },
    );
  }

  // Idempotency support on message/send
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey && body.method === "message/send") {
    const cachedResponse = getIdempotentResponse(`a2a:${auth.tenantId}:${idempotencyKey}`);
    if (cachedResponse) {
      return NextResponse.json(cachedResponse, {
        status: 200,
        headers: { "A2A-Version": "1.0", "A2A-Request-Id": requestId },
      });
    }
  }

  // Validate inbound message for send methods
  if (body.method === "message/send" || body.method === "message/stream") {
    const params = body.params as Record<string, unknown> | undefined;
    const message = params?.message as Record<string, unknown> | undefined;
    if (message) {
      const validationError = validateA2aMessage(message as never);
      if (validationError) {
        const errorResp = {
          jsonrpc: "2.0",
          error: { code: -32602, message: validationError },
          id: body.id ?? null,
        };
        return NextResponse.json(errorResp, {
          status: 200,
          headers: { "A2A-Version": "1.0", "A2A-Request-Id": requestId },
        });
      }
    }

    // Extract and clamp max_budget_usd from metadata
    const metadata = (params?.message as Record<string, unknown>)?.metadata as Record<string, unknown> | undefined;
    const agentplaneMeta = metadata?.agentplane as Record<string, unknown> | undefined;
    const requestedMaxBudget = typeof agentplaneMeta?.max_budget_usd === "number"
      ? agentplaneMeta.max_budget_usd
      : undefined;

    // Budget clamping happens in SandboxAgentExecutor — just pass it through
    void requestedMaxBudget;
  }

  // Resolve tenant info for Agent Card
  const sql = getHttpClient();
  const tenantRows = await sql`
    SELECT id, name, status, monthly_budget_usd, current_month_spend
    FROM tenants WHERE slug = ${slug} AND status = 'active'
  `;
  if (tenantRows.length === 0) {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Agent not found" }, id: body.id ?? null },
      {
        status: 200,
        headers: { "A2A-Version": "1.0", "A2A-Request-Id": requestId },
      },
    );
  }
  const tenant = TenantForBudgetRow.parse(tenantRows[0]);
  const remainingBudget = tenant.monthly_budget_usd - tenant.current_month_spend;

  // Build or get cached Agent Card
  const proto = request.headers.get("x-forwarded-proto") || "https";
  const host = request.headers.get("host") || "localhost";
  const baseUrl = `${proto}://${host}`;

  let agentCard = getCachedAgentCard(slug);
  if (!agentCard) {
    agentCard = await buildAgentCard(slug, tenant.name, baseUrl);
    if (!agentCard) {
      return NextResponse.json(
        { jsonrpc: "2.0", error: { code: -32001, message: "No A2A-enabled agents found" }, id: body.id ?? null },
        {
          status: 200,
          headers: { "A2A-Version": "1.0", "A2A-Request-Id": requestId },
        },
      );
    }
    setCachedAgentCard(slug, agentCard);
  }

  // Extract budget from A2A metadata
  const params = body.params as Record<string, unknown> | undefined;
  const msgMeta = (params?.message as Record<string, unknown> | undefined)?.metadata as Record<string, unknown> | undefined;
  const apMeta = msgMeta?.agentplane as Record<string, unknown> | undefined;
  const requestedMaxBudget = typeof apMeta?.max_budget_usd === "number" ? apMeta.max_budget_usd : undefined;

  // Create SDK components per-request
  const taskStore = new RunBackedTaskStore(auth.tenantId, auth.apiKeyId);
  const executor = new SandboxAgentExecutor({
    tenantId: auth.tenantId,
    createdByKeyId: auth.apiKeyId,
    platformApiUrl: baseUrl,
    resolveAgent: async () => null, // Agent resolution handled in executor
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
        "A2A-Version": "1.0",
        "A2A-Request-Id": requestId,
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
    headers: {
      "A2A-Version": "1.0",
      "A2A-Request-Id": requestId,
    },
  });
});
