import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { queryOne } from "@/db";
import { z } from "zod";

export const dynamic = "force-dynamic";

const StatsRow = z.object({
  agent_count: z.coerce.number(),
  total_messages: z.coerce.number(),
  active_messages: z.coerce.number(),
  total_spend: z.coerce.number(),
  session_count: z.coerce.number(),
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));

  const stats = await queryOne(
    StatsRow,
    `SELECT
       (SELECT COUNT(*) FROM agents WHERE tenant_id = $1)::int AS agent_count,
       (SELECT COUNT(*) FROM session_messages WHERE tenant_id = $1)::int AS total_messages,
       (SELECT COUNT(*) FROM session_messages WHERE tenant_id = $1 AND status = 'running')::int AS active_messages,
       (SELECT COALESCE(SUM(cost_usd), 0) FROM session_messages WHERE tenant_id = $1) AS total_spend,
       (SELECT COUNT(*) FROM sessions WHERE tenant_id = $1 AND status != 'stopped')::int AS session_count`,
    [auth.tenantId],
  );

  return jsonResponse(stats);
});
