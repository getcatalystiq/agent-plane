import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/db";
import { PluginMarketplaceRow } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { NotFoundError } from "@/lib/errors";
import { listPlugins } from "@/lib/plugins";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ marketplaceId: string }> };

export const GET = withErrorHandler(async (_request: NextRequest, context) => {
  const { marketplaceId } = await (context as RouteContext).params;

  const marketplace = await queryOne(
    PluginMarketplaceRow,
    "SELECT * FROM plugin_marketplaces WHERE id = $1",
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

  return NextResponse.json({ data: result.data });
});
