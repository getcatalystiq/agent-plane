import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { queryOne } from "@/db";
import { PluginMarketplacePublicRow } from "@/lib/validation";
import { NotFoundError } from "@/lib/errors";
import { listPlugins } from "@/lib/plugins";

export const dynamic = "force-dynamic";

// GET /api/plugin-marketplaces/:marketplaceId/plugins — list plugins in a marketplace (tenant-scoped)
export const GET = withErrorHandler(async (request: NextRequest, context) => {
  await authenticateApiKey(request.headers.get("authorization"));
  const { marketplaceId } = await context!.params;

  const marketplace = await queryOne(
    PluginMarketplacePublicRow,
    "SELECT id, name, github_repo, created_at, updated_at FROM plugin_marketplaces WHERE id = $1",
    [marketplaceId],
  );
  if (!marketplace) throw new NotFoundError("Plugin marketplace not found");

  const result = await listPlugins(marketplace.github_repo);
  if (!result.ok) {
    return NextResponse.json(
      { error: `Failed to fetch plugins: ${result.message}` },
      { status: 502 },
    );
  }

  return jsonResponse({ data: result.data });
});
