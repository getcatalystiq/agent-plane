import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/db";
import { AgentRow } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { buildSoulManifest, buildSoulFiles } from "@/lib/soul-manifest";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string }> };

export const GET = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId } = await (context as RouteContext).params;

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) {
    return NextResponse.json(
      { error: { code: "not_found", message: "Agent not found" } },
      { status: 404 },
    );
  }

  const manifest = buildSoulManifest(agent);
  const files = buildSoulFiles(agent);

  // Populate the manifest's files map with the actual filenames present
  manifest.files = Object.fromEntries(
    Object.keys(files).map((filename) => [filename, filename]),
  );

  return NextResponse.json({ manifest, files });
});
