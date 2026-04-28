import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { query } from "@/db";
import { z } from "zod";

export const dynamic = "force-dynamic";

const DailyStatRow = z.object({
  date: z.string(),
  agent_name: z.string(),
  message_count: z.coerce.number(),
  cost_usd: z.coerce.number(),
});

const ChartQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));

  const url = new URL(request.url);
  const { days } = ChartQuerySchema.parse({
    days: url.searchParams.get("days"),
  });

  const dailyStats = await query(
    DailyStatRow,
    `SELECT
       DATE(m.created_at)::text AS date,
       a.name AS agent_name,
       COUNT(*)::int AS message_count,
       COALESCE(SUM(m.cost_usd), 0) AS cost_usd
     FROM session_messages m
     JOIN sessions s ON s.id = m.session_id
     JOIN agents a ON a.id = s.agent_id
     WHERE m.tenant_id = $1 AND m.created_at >= NOW() - make_interval(days => $2)
     GROUP BY DATE(m.created_at), a.name
     ORDER BY date ASC`,
    [auth.tenantId, days],
  );

  return jsonResponse({ data: dailyStats });
});
