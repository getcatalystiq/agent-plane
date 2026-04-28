import { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { PaginationSchema, SessionMessageStatusSchema } from "@/lib/validation";
import { getSession } from "@/lib/sessions";
import { listMessages } from "@/lib/session-messages";
import { dispatchSessionMessage } from "@/lib/dispatcher";
import { deriveTriggeredBy } from "@/lib/trigger";
import { SessionStoppedError } from "@/lib/errors";
import type { AgentId } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SendMessageRequestSchema = z.object({
  prompt: z.string().min(1).max(100_000),
  idempotency_key: z.string().min(1).max(200).optional(),
  /** Override agent's max_turns for this message. Bounded by validation. */
  max_turns: z.number().int().min(1).max(200).optional(),
  /** Override agent's max_budget_usd for this message. */
  max_budget_usd: z.number().positive().max(1000).optional(),
});

export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { sessionId } = await context!.params;
  const body = await request.json();
  const input = SendMessageRequestSchema.parse(body);

  // Resolve session up-front to determine first/follow-up + agent.
  const session = await getSession(sessionId, auth.tenantId);
  const isFirstMessage = session.message_count === 0;
  const triggeredBy = deriveTriggeredBy({
    authSource: "tenant",
    isFirstMessage,
  });

  try {
    const result = await dispatchSessionMessage({
      tenantId: auth.tenantId,
      agentId: session.agent_id as AgentId,
      sessionId,
      prompt: input.prompt,
      triggeredBy,
      idempotencyKey: input.idempotency_key,
      callerKeyId: auth.apiKeyId,
      platformApiUrl: new URL(request.url).origin,
      overrides: {
        maxTurns: input.max_turns,
        maxBudgetUsd: input.max_budget_usd,
      },
    });

    return new Response(result.stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Session-Id": result.sessionId,
        "X-Message-Id": result.messageId,
      },
    });
  } catch (err) {
    if (err instanceof SessionStoppedError) {
      // CAS-loser path. Surface 410 Gone with explicit hint per the U3
      // contract. Clients should provision a fresh session and retry.
      return jsonResponse(
        {
          error: {
            code: "session_stopped",
            message: err.message,
          },
          hint: "create a new session via POST /api/sessions",
        },
        410,
      );
    }
    throw err;
  }
});

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { sessionId } = await context!.params;
  const url = new URL(request.url);
  const pagination = PaginationSchema.parse({
    limit: url.searchParams.get("limit"),
    offset: url.searchParams.get("offset"),
  });
  const statusParam = url.searchParams.get("status");
  const status = statusParam ? SessionMessageStatusSchema.parse(statusParam) : undefined;

  // Touch the session for tenant-scoped existence check (404 via RLS).
  await getSession(sessionId, auth.tenantId);

  const messages = await listMessages(auth.tenantId, {
    sessionId,
    status,
    ...pagination,
  });

  return jsonResponse({
    data: messages,
    limit: pagination.limit,
    offset: pagination.offset,
  });
});
