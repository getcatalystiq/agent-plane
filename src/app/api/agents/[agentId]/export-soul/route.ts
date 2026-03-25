import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { getAgentForTenant } from "@/lib/agents";
import { withErrorHandler } from "@/lib/api";
import { buildSoulManifest, buildSoulFiles } from "@/lib/soul-manifest";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId } = await context!.params;
  const agent = await getAgentForTenant(agentId, auth.tenantId);

  const manifest = buildSoulManifest(agent);
  const files = buildSoulFiles(agent);

  // Populate the manifest's files map with the actual filenames present
  manifest.files = Object.fromEntries(
    Object.keys(files).map((filename) => [filename, filename]),
  );

  return NextResponse.json({ manifest, files });
});
