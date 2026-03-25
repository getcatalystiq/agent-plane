import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { getAgentForTenant } from "@/lib/agents";
import { withErrorHandler } from "@/lib/api";
import { validateSoul, ClawSoulsError } from "@/lib/clawsouls";
import { buildSoulManifest, buildSoulFiles } from "@/lib/soul-manifest";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId } = await context!.params;
  const agent = await getAgentForTenant(agentId, auth.tenantId);

  const manifest = buildSoulManifest(agent);
  const files = buildSoulFiles(agent);

  if (Object.keys(files).length === 0) {
    return NextResponse.json({
      valid: false,
      checks: [{ type: "warn", message: "No SoulSpec files found on this agent" }],
    });
  }

  try {
    const result = await validateSoul(manifest, files);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ClawSoulsError) {
      return NextResponse.json({
        valid: false,
        checks: [{ type: "warn", message: "Validation service unavailable" }],
      });
    }
    throw err;
  }
});
