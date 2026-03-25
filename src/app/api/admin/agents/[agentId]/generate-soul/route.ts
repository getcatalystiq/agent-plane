import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/db";
import { AgentRow } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { generateSoulFiles } from "@/lib/soul-generation";
import { logger } from "@/lib/logger";

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

  // Collect existing SoulSpec content for refinement
  const existingContent: Record<string, string | null> = {
    "SOUL.md": agent.soul_md,
    "IDENTITY.md": agent.identity_md,
    "STYLE.md": agent.style_md,
    "AGENTS.md": agent.agents_md,
    "HEARTBEAT.md": agent.heartbeat_md,
    "USER_TEMPLATE.md": agent.user_template_md,
    "examples/good-outputs.md": agent.examples_good_md,
    "examples/bad-outputs.md": agent.examples_bad_md,
  };

  try {
    const result = await generateSoulFiles(
      {
        name: agent.name,
        description: agent.description,
        model: agent.model,
        composio_toolkits: agent.composio_toolkits,
        skills: agent.skills.map((s) => ({
          folder: s.folder,
          files: s.files.map((f) => ({ path: f.path })),
        })),
        plugins: agent.plugins.map((p) => ({ plugin_name: p.plugin_name })),
        allowed_tools: agent.allowed_tools,
      },
      existingContent,
    );

    return NextResponse.json(result);
  } catch (err) {
    logger.error("Soul generation failed", { err: String(err), agentId });
    return NextResponse.json(
      { error: { code: "generation_failed", message: "Failed to generate SoulSpec files. Please try again." } },
      { status: 500 },
    );
  }
});
