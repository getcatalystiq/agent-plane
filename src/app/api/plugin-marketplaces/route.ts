import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { query } from "@/db";
import { PluginMarketplacePublicRow } from "@/lib/validation";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

// GET /api/plugin-marketplaces — list available marketplaces (tenant-scoped)
export const GET = withErrorHandler(async (request: NextRequest) => {
  await authenticateApiKey(request.headers.get("authorization"));

  const marketplaces = await query(
    PluginMarketplacePublicRow,
    "SELECT id, name, github_repo, created_at, updated_at FROM plugin_marketplaces ORDER BY name",
  );

  return jsonResponse({ data: marketplaces });
});
