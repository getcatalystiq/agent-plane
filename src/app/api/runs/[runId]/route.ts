import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { getRun } from "@/lib/runs";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { runId } = await context!.params;
  const run = await getRun(runId, auth.tenantId);
  return jsonResponse(run);
});
