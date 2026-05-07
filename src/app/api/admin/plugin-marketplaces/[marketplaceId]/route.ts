import { NextRequest, NextResponse } from "next/server";
import { queryOne, execute } from "@/db";
import { PluginMarketplaceRow, UpdateMarketplaceSchema } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { NotFoundError, ConflictError, ForbiddenError } from "@/lib/errors";
import { clearPluginCache } from "@/lib/plugins";
import { checkWriteAccess } from "@/lib/github";
import { encrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { z } from "zod";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ marketplaceId: string }> };

const UuidSchema = z.string().uuid();

function ensureUuid(id: string) {
  if (!UuidSchema.safeParse(id).success) {
    throw new NotFoundError("Plugin marketplace not found");
  }
}

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const { marketplaceId } = await (context as RouteContext).params;
  ensureUuid(marketplaceId);
  const tenantId = request.nextUrl.searchParams.get("tenant_id");

  let marketplace;
  if (tenantId) {
    marketplace = await queryOne(
      PluginMarketplaceRow,
      "SELECT * FROM plugin_marketplaces WHERE id = $1 AND tenant_id = $2",
      [marketplaceId, tenantId],
    );
  } else {
    marketplace = await queryOne(
      PluginMarketplaceRow,
      "SELECT * FROM plugin_marketplaces WHERE id = $1",
      [marketplaceId],
    );
  }
  if (!marketplace) throw new NotFoundError("Plugin marketplace not found");

  return NextResponse.json(marketplace);
});

export const PATCH = withErrorHandler(async (request: NextRequest, context) => {
  const { marketplaceId } = await (context as RouteContext).params;
  ensureUuid(marketplaceId);
  const tenantId = request.nextUrl.searchParams.get("tenant_id");

  let marketplace;
  if (tenantId) {
    marketplace = await queryOne(
      PluginMarketplaceRow,
      "SELECT * FROM plugin_marketplaces WHERE id = $1 AND tenant_id = $2",
      [marketplaceId, tenantId],
    );
  } else {
    marketplace = await queryOne(
      PluginMarketplaceRow,
      "SELECT * FROM plugin_marketplaces WHERE id = $1",
      [marketplaceId],
    );
  }
  if (!marketplace) throw new NotFoundError("Plugin marketplace not found");

  const body = await request.json();
  const input = UpdateMarketplaceSchema.parse(body);

  if (input.github_token !== undefined) {
    if (input.github_token === null) {
      // Remove token (revoke ownership)
      await execute(
        "UPDATE plugin_marketplaces SET github_token_enc = NULL WHERE id = $1",
        [marketplaceId],
      );
    } else {
      // Validate write access before storing
      const [owner, repo] = marketplace.github_repo.split("/");
      const accessResult = await checkWriteAccess(owner, repo, input.github_token);
      if (!accessResult.ok) {
        throw new ForbiddenError(`Token validation failed: ${accessResult.message}`);
      }

      const env = getEnv();
      const encrypted = await encrypt(input.github_token, env.ENCRYPTION_KEY);
      await execute(
        "UPDATE plugin_marketplaces SET github_token_enc = $1 WHERE id = $2",
        [JSON.stringify(encrypted), marketplaceId],
      );
    }
  }

  const updated = await queryOne(
    PluginMarketplaceRow,
    "SELECT * FROM plugin_marketplaces WHERE id = $1",
    [marketplaceId],
  );

  // Return marketplace without exposing the encrypted token value
  return NextResponse.json({
    ...updated,
    github_token_enc: undefined,
    is_owned: updated!.github_token_enc !== null,
  });
});

const AgentRefCount = z.object({ count: z.coerce.number() });

export const DELETE = withErrorHandler(async (request: NextRequest, context) => {
  const { marketplaceId } = await (context as RouteContext).params;
  ensureUuid(marketplaceId);
  const tenantId = request.nextUrl.searchParams.get("tenant_id");

  // Verify marketplace exists (and optionally belongs to tenant)
  if (tenantId) {
    const existing = await queryOne(
      PluginMarketplaceRow,
      "SELECT * FROM plugin_marketplaces WHERE id = $1 AND tenant_id = $2",
      [marketplaceId, tenantId],
    );
    if (!existing) throw new NotFoundError("Plugin marketplace not found");
  }

  // Check if any agents reference this marketplace in their plugins JSONB
  const refCount = await queryOne(
    AgentRefCount,
    `SELECT COUNT(*)::int AS count FROM agents WHERE plugins @> $1::jsonb`,
    [JSON.stringify([{ marketplace_id: marketplaceId }])],
  );

  if (refCount && refCount.count > 0) {
    throw new ConflictError(
      `Cannot delete marketplace: ${refCount.count} agent(s) use plugins from it. Remove plugins from agents first.`,
    );
  }

  const { rowCount } = await execute(
    "DELETE FROM plugin_marketplaces WHERE id = $1",
    [marketplaceId],
  );
  if (rowCount === 0) throw new NotFoundError("Plugin marketplace not found");

  clearPluginCache();

  return NextResponse.json({ deleted: true });
});
