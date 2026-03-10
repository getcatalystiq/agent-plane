import { NextRequest } from "next/server";
import { queryOne, withTenantTransaction } from "@/db";
import { withErrorHandler } from "@/lib/api";
import { SendMessageSchema, SessionRow, AgentRowInternal } from "@/lib/validation";
import { transitionSessionStatus } from "@/lib/sessions";
import { checkTenantBudget } from "@/lib/runs";
import { prepareSessionSandbox, executeSessionMessage, createSessionStreamResponse } from "@/lib/session-executor";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { TenantId, SessionStatus } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const { sessionId } = await context!.params;
  const body = await request.json();
  const input = SendMessageSchema.parse(body);

  // Admin: no RLS — query directly
  const session = await queryOne(
    SessionRow,
    "SELECT * FROM sessions WHERE id = $1",
    [sessionId],
  );
  if (!session) throw new NotFoundError("Session not found");

  if (session.status === "stopped") {
    throw new ConflictError("Session is stopped");
  }
  if (session.status === "active") {
    throw new ConflictError("Session is currently processing a message");
  }

  const tenantId = session.tenant_id as TenantId;

  // Atomically claim the session lock: transition idle/creating → active
  const fromStatus = session.status as SessionStatus;
  const claimed = await transitionSessionStatus(
    sessionId,
    tenantId,
    fromStatus,
    "active",
    { idle_since: null },
  );
  if (!claimed) {
    throw new ConflictError("Session is currently processing a message");
  }

  // Run budget check and agent load in parallel (both are independent DB queries)
  const [, agent] = await Promise.all([
    withTenantTransaction(tenantId, async (tx) => {
      await checkTenantBudget(tx, tenantId);
    }).catch(async (err) => {
      await transitionSessionStatus(sessionId, tenantId, "active", "idle", {
        idle_since: new Date().toISOString(),
      }).catch((rollbackErr) => {
        logger.error("Failed to rollback session to idle after budget check failure", {
          session_id: sessionId,
          error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        });
      });
      throw err;
    }),
    queryOne(
      AgentRowInternal,
      "SELECT * FROM agents WHERE id = $1",
      [session.agent_id],
    ),
  ]);
  if (!agent) throw new NotFoundError("Agent not found");

  const effectiveBudget = Math.min(
    input.max_budget_usd ?? agent.max_budget_usd,
    agent.max_budget_usd,
  );
  const effectiveMaxTurns = Math.min(
    input.max_turns ?? agent.max_turns,
    agent.max_turns,
  );

  const sandbox = await prepareSessionSandbox(
    {
      sessionId,
      tenantId,
      agent,
      prompt: input.prompt,
      platformApiUrl: new URL(request.url).origin,
      effectiveBudget,
      effectiveMaxTurns,
    },
    session,
  );

  const result = await executeSessionMessage(
    {
      sessionId,
      tenantId,
      agent,
      prompt: input.prompt,
      platformApiUrl: new URL(request.url).origin,
      effectiveBudget,
      effectiveMaxTurns,
    },
    sandbox,
    session,
  );

  return createSessionStreamResponse(result, tenantId, sessionId, effectiveBudget);
});
