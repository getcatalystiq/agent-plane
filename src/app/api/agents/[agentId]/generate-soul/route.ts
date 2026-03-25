import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { getAgentForTenant } from "@/lib/agents";
import { withErrorHandler } from "@/lib/api";
import { generateSoulFiles } from "@/lib/soul-generation";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId } = await context!.params;
  const agent = await getAgentForTenant(agentId, auth.tenantId);

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
