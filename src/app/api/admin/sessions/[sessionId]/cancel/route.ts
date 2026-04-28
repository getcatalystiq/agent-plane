import { NextRequest } from "next/server";
import { queryOne } from "@/db";
import { withErrorHandler } from "@/lib/api";
import { SessionRow } from "@/lib/validation";
import { cancelSession } from "@/lib/dispatcher";
import { NotFoundError } from "@/lib/errors";
import type { TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const { sessionId } = await context!.params;
  const session = await queryOne(
    SessionRow,
    "SELECT * FROM sessions WHERE id = $1",
    [sessionId],
  );
  if (!session) throw new NotFoundError("Session not found");

  await cancelSession(sessionId, session.tenant_id as TenantId);
  return new Response(null, { status: 204 });
});
