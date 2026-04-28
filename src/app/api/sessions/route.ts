import { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import {
  PaginationSchema,
  SessionStatusSchema,
  SessionResponseRow,
} from "@/lib/validation";
import { createSession, listSessions } from "@/lib/sessions";
import { dispatchSessionMessage } from "@/lib/dispatcher";
import { deriveTriggeredBy } from "@/lib/trigger";
import type { AgentId } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CreateSessionRequestSchema = z.object({
  agent_id: z.string().uuid(),
  prompt: z.string().min(1).max(100_000).optional(),
  /**
   * Whether the session is one-shot (true) or persistent multi-turn (false).
   *
   * FIX #32: defaults are explicit and documented:
   *   - With prompt + no ephemeral flag: defaults to `true` (one-shot run
   *     mapped to a session; the dispatcher stops the sandbox after the
   *     first message completes).
   *   - Without prompt + no ephemeral flag: defaults to `false` (caller
   *     intends multi-turn; the session is provisioned in `creating` state
   *     with no sandbox until the first POST to
   *     /api/sessions/:id/messages).
   *
   * The only way to get a persistent session that boots the sandbox on
   * creation is to omit `prompt` and POST a message to the session
   * separately. Pass `ephemeral: false` with a prompt to override the
   * default and keep the session warm after the first turn.
   */
  ephemeral: z.boolean().optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
});

/**
 * POST /api/sessions
 *
 * Creates a session and (optionally) dispatches a first message. See
 * CreateSessionRequestSchema for the ephemeral default contract — the same
 * request body produces different lifecycles depending on whether `prompt`
 * is present, and we make the rule explicit here so callers can audit it.
 */

export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const body = await request.json();
  const input = CreateSessionRequestSchema.parse(body);

  const triggeredBy = deriveTriggeredBy({
    authSource: "tenant",
    isFirstMessage: true,
  });

  // No prompt: provision a session row only. No sandbox boot, no runner.
  // The next POST to /api/sessions/:id/messages will dispatch the first
  // message which spawns the sandbox.
  if (!input.prompt) {
    const ephemeral = input.ephemeral ?? false;
    const { session } = await createSession(
      auth.tenantId,
      input.agent_id as AgentId,
      { ephemeral, triggeredBy },
    );
    return jsonResponse(SessionResponseRow.parse(session), 201);
  }

  // With prompt: dispatch through the chokepoint. The dispatcher will
  // create the session inside its own transaction and return the
  // streaming response.
  const ephemeral = input.ephemeral ?? true;
  const result = await dispatchSessionMessage({
    tenantId: auth.tenantId,
    agentId: input.agent_id as AgentId,
    prompt: input.prompt,
    triggeredBy,
    ephemeral,
    idempotencyKey: input.idempotency_key,
    callerKeyId: auth.apiKeyId,
    platformApiUrl: new URL(request.url).origin,
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
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const url = new URL(request.url);
  const pagination = PaginationSchema.parse({
    limit: url.searchParams.get("limit"),
    offset: url.searchParams.get("offset"),
  });
  const agentId = url.searchParams.get("agent_id") ?? undefined;
  const statusParam = url.searchParams.get("status");
  const status = statusParam ? SessionStatusSchema.parse(statusParam) : undefined;

  const sessions = await listSessions(auth.tenantId, {
    agentId,
    status,
    ...pagination,
  });

  const responseSessions = sessions.map((s) => SessionResponseRow.parse(s));
  return jsonResponse({
    data: responseSessions,
    limit: pagination.limit,
    offset: pagination.offset,
  });
});
