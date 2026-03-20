import { NextRequest, NextResponse } from "next/server";
import { query, queryOne } from "@/db";
import { CreatePluginMarketplaceSchema, PluginMarketplaceRow } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { ConflictError } from "@/lib/errors";
import { fetchRepoTree } from "@/lib/github";
import { getEnv } from "@/lib/env";
import { encrypt } from "@/lib/crypto";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const tenantId = request.nextUrl.searchParams.get("tenant_id");

  let marketplaces;
  if (tenantId) {
    marketplaces = await query(
      PluginMarketplaceRow,
      "SELECT * FROM plugin_marketplaces WHERE tenant_id = $1 ORDER BY name",
      [tenantId],
    );
  } else {
    marketplaces = await query(
      PluginMarketplaceRow,
      "SELECT * FROM plugin_marketplaces ORDER BY name",
      [],
    );
  }
  return NextResponse.json({ data: marketplaces });
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const body = await request.json();
  const input = CreatePluginMarketplaceSchema.parse(body);

  // Check uniqueness within tenant
  const existing = await queryOne(
    PluginMarketplaceRow,
    "SELECT * FROM plugin_marketplaces WHERE tenant_id = $1 AND github_repo = $2",
    [input.tenant_id, input.github_repo],
  );
  if (existing) {
    throw new ConflictError(`Marketplace already registered: ${input.github_repo}`);
  }

  // Use provided token for repo validation
  const token = input.github_token;

  // Validate repo exists by fetching its tree
  const [owner, repo] = input.github_repo.split("/");
  const treeResult = await fetchRepoTree(owner, repo, token);
  if (!treeResult.ok) {
    throw new ConflictError(`Cannot access GitHub repo: ${treeResult.message}`);
  }

  // If a token was provided, encrypt and store it
  let githubTokenEnc: string | null = null;
  if (input.github_token) {
    const env = getEnv();
    const encrypted = await encrypt(input.github_token, env.ENCRYPTION_KEY);
    githubTokenEnc = JSON.stringify(encrypted);
  }

  const marketplace = await queryOne(
    PluginMarketplaceRow,
    `INSERT INTO plugin_marketplaces (tenant_id, name, github_repo, github_token_enc) VALUES ($1, $2, $3, $4) RETURNING *`,
    [input.tenant_id, input.name, input.github_repo, githubTokenEnc],
  );

  return NextResponse.json(marketplace, { status: 201 });
});
