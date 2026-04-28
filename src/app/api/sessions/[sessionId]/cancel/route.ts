import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler } from "@/lib/api";
import { cancelSession } from "@/lib/dispatcher";

export const dynamic = "force-dynamic";

/**
 * Coarse cancel: marks any in-flight message `cancelled`, stops the sandbox,
 * and CASes the session to `stopped`. Idempotent — calling on an already
 * stopped session returns 204.
 */
export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { sessionId } = await context!.params;
  await cancelSession(sessionId, auth.tenantId);
  return new Response(null, { status: 204 });
});
