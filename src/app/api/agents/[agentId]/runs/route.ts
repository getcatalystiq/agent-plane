import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { PaginationSchema, RunStatusSchema } from "@/lib/validation";
import { listRuns } from "@/lib/runs";
import { queryOne } from "@/db";
import { NotFoundError } from "@/lib/errors";
import { z } from "zod";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId } = await context!.params;

  // Verify agent belongs to this tenant
  const agent = await queryOne(
    z.object({ id: z.string() }),
    "SELECT id FROM agents WHERE id = $1 AND tenant_id = $2",
    [agentId, auth.tenantId],
  );
  if (!agent) throw new NotFoundError("Agent not found");

  const url = new URL(request.url);
  const pagination = PaginationSchema.parse({
    limit: url.searchParams.get("limit"),
    offset: url.searchParams.get("offset"),
  });
  const statusParam = url.searchParams.get("status");
  const status = statusParam ? RunStatusSchema.parse(statusParam) : undefined;

  const runs = await listRuns(auth.tenantId, {
    agentId,
    status,
    ...pagination,
  });

  return jsonResponse({ data: runs, limit: pagination.limit, offset: pagination.offset });
});
