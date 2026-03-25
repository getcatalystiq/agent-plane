import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/db";
import { AgentRow, TenantRow } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { validateSoul, publishSoul, ClawSoulsError } from "@/lib/clawsouls";
import { buildSoulManifest, buildSoulFiles } from "@/lib/soul-manifest";
import { decrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { z } from "zod";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string }> };

const PublishBodySchema = z.object({
  owner: z.string().min(1),
});

export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const { agentId } = await (context as RouteContext).params;

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) {
    return NextResponse.json(
      { error: { code: "not_found", message: "Agent not found" } },
      { status: 404 },
    );
  }

  const body = await request.json();
  const input = PublishBodySchema.parse(body);

  // Load tenant to get ClawSouls token
  const tenant = await queryOne(
    TenantRow,
    "SELECT * FROM tenants WHERE id = $1",
    [agent.tenant_id],
  );
  if (!tenant || !tenant.clawsouls_api_token_enc) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "ClawSouls API token not configured" } },
      { status: 401 },
    );
  }

  const env = getEnv();
  const token = await decrypt(
    JSON.parse(tenant.clawsouls_api_token_enc),
    env.ENCRYPTION_KEY,
    env.ENCRYPTION_KEY_PREVIOUS,
  );

  const manifest = buildSoulManifest(agent);
  const files = buildSoulFiles(agent);

  if (Object.keys(files).length === 0) {
    return NextResponse.json({
      published: false,
      checks: [{ type: "warn", message: "No SoulSpec files found on this agent" }],
    });
  }

  // Validate first
  let checks;
  try {
    const validation = await validateSoul(manifest, files);
    checks = validation.checks;
    if (!validation.valid) {
      return NextResponse.json({ published: false, checks });
    }
  } catch (err) {
    if (err instanceof ClawSoulsError) {
      return NextResponse.json({
        published: false,
        checks: [{ type: "warn", message: "Validation service unavailable" }],
      });
    }
    throw err;
  }

  // Publish
  const kebabName = manifest.name;
  try {
    await publishSoul(input.owner, kebabName, manifest, files, token);
  } catch (err) {
    if (err instanceof ClawSoulsError) {
      return NextResponse.json(
        { error: { code: "upstream_error", message: err.message } },
        { status: err.status ?? 502 },
      );
    }
    throw err;
  }

  const url = `https://clawsouls.ai/${encodeURIComponent(input.owner)}/${encodeURIComponent(kebabName)}`;

  return NextResponse.json({ published: true, url, checks });
});
