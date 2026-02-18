import { NextRequest, NextResponse } from "next/server";
import { query } from "@/db";
import { PaginationSchema } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

const TenantWithStats = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: z.string(),
  monthly_budget_usd: z.coerce.number(),
  current_month_spend: z.coerce.number(),
  created_at: z.coerce.string(),
  agent_count: z.coerce.number(),
  run_count: z.coerce.number(),
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  const url = new URL(request.url);
  const { limit, offset } = PaginationSchema.parse({
    limit: url.searchParams.get("limit") ?? "50",
    offset: url.searchParams.get("offset") ?? "0",
  });

  const tenants = await query(
    TenantWithStats,
    `SELECT t.*,
       COUNT(DISTINCT a.id)::int AS agent_count,
       COUNT(DISTINCT r.id)::int AS run_count
     FROM tenants t
     LEFT JOIN agents a ON a.tenant_id = t.id
     LEFT JOIN runs r ON r.tenant_id = t.id
     GROUP BY t.id
     ORDER BY t.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );

  return NextResponse.json({ data: tenants, limit, offset });
});
