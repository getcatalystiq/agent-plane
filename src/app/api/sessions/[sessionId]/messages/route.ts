import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler } from "@/lib/api";
import { SendMessageSchema, AgentRowInternal } from "@/lib/validation";
import { getSession, transitionSessionStatus } from "@/lib/sessions";
import { checkTenantBudget } from "@/lib/runs";
import { prepareSessionSandbox, executeSessionMessage, createSessionStreamResponse } from "@/lib/session-executor";
import { queryOne, withTenantTransaction } from "@/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { SessionStatus } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { sessionId } = await context!.params;
  const body = await request.json();
  const input = SendMessageSchema.parse(body);

  const session = await getSession(sessionId, auth.tenantId);

  if (session.status === "stopped") {
    throw new ConflictError("Session is stopped");
  }
  if (session.status === "active") {
    throw new ConflictError("Session is currently processing a message");
  }

  // Atomically claim the session lock: transition idle/creating → active
  // This prevents concurrent message races (WHERE status = fromStatus guard)
  const fromStatus = session.status as SessionStatus;
  const claimed = await transitionSessionStatus(
    sessionId,
    auth.tenantId,
    fromStatus,
    "active",
    { idle_since: null },
  );
  if (!claimed) {
    throw new ConflictError("Session is currently processing a message");
  }

  // Run budget check and agent load in parallel (both are independent DB queries)
  const [, agent] = await Promise.all([
    withTenantTransaction(auth.tenantId, async (tx) => {
      await checkTenantBudget(tx, auth.tenantId);
    }).catch(async (err) => {
      // Rollback session to idle on budget check failure
      await transitionSessionStatus(sessionId, auth.tenantId, "active", "idle", {
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
      "SELECT * FROM agents WHERE id = $1 AND tenant_id = $2",
      [session.agent_id, auth.tenantId],
    ),
  ]);
  if (!agent) throw new NotFoundError("Agent not found");

  // Apply per-message overrides capped to agent config
  const effectiveBudget = Math.min(
    input.max_budget_usd ?? agent.max_budget_usd,
    agent.max_budget_usd,
  );
  const effectiveMaxTurns = Math.min(
    input.max_turns ?? agent.max_turns,
    agent.max_turns,
  );

  // Get or create sandbox
  const sandbox = await prepareSessionSandbox(
    {
      sessionId,
      tenantId: auth.tenantId,
      agent,
      prompt: input.prompt,
      platformApiUrl: new URL(request.url).origin,
      effectiveBudget,
      effectiveMaxTurns,
    },
    session,
  );

  // Execute message
  const result = await executeSessionMessage(
    {
      sessionId,
      tenantId: auth.tenantId,
      agent,
      prompt: input.prompt,
      platformApiUrl: new URL(request.url).origin,
      effectiveBudget,
      effectiveMaxTurns,
    },
    sandbox,
    session,
  );

  return createSessionStreamResponse(result, auth.tenantId, sessionId, effectiveBudget);
});
