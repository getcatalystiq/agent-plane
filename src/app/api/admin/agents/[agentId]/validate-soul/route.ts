import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/db";
import { AgentRow } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { validateSoul, ClawSoulsError } from "@/lib/clawsouls";
import { buildSoulManifest, buildSoulFiles } from "@/lib/soul-manifest";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string }> };

export const POST = withErrorHandler(async (_request: NextRequest, context) => {
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
