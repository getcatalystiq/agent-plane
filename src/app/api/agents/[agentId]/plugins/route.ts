import { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { queryOne, execute } from "@/db";
import { NotFoundError, ConflictError, ValidationError } from "@/lib/errors";
import { AddPluginSchema, AgentPluginsPartialRow } from "@/lib/validation";

export const dynamic = "force-dynamic";

// GET /api/agents/:agentId/plugins — list all plugins
export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId } = await context!.params;

  const agent = await queryOne(
    AgentPluginsPartialRow.extend({ id: z.string(), tenant_id: z.string() }),
    "SELECT id, tenant_id, plugins FROM agents WHERE id = $1 AND tenant_id = $2",
    [agentId, auth.tenantId],
  );
  if (!agent) throw new NotFoundError("Agent not found");

  return jsonResponse({ data: agent.plugins });
});

// POST /api/agents/:agentId/plugins — add a plugin
export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId } = await context!.params;

  const body = await request.json();
  const plugin = AddPluginSchema.parse(body);

  // Validate marketplace exists
  const marketplace = await queryOne(
    z.object({ id: z.string() }),
    "SELECT id FROM plugin_marketplaces WHERE id = $1",
    [plugin.marketplace_id],
  );
  if (!marketplace) {
    throw new ValidationError(`Plugin marketplace "${plugin.marketplace_id}" not found`);
  }

  // Load current plugins for early validation (better error messages)
  const agent = await queryOne(
    AgentPluginsPartialRow.extend({ id: z.string(), tenant_id: z.string() }),
    "SELECT id, tenant_id, plugins FROM agents WHERE id = $1 AND tenant_id = $2",
    [agentId, auth.tenantId],
  );
  if (!agent) throw new NotFoundError("Agent not found");

  // Check duplicate (early exit with descriptive error)
  const key = `${plugin.marketplace_id}:${plugin.plugin_name}`;
  const exists = agent.plugins.some(
    (p) => `${p.marketplace_id}:${p.plugin_name}` === key,
  );
  if (exists) {
    throw new ConflictError(`Plugin "${plugin.plugin_name}" from this marketplace is already added`);
  }

  if (agent.plugins.length >= 20) {
    throw new ValidationError("Maximum 20 plugins per agent");
  }

  // Atomic append with max-length + uniqueness guard
  const result = await execute(
    `UPDATE agents
     SET plugins = plugins || $1::jsonb, updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3
       AND jsonb_array_length(plugins) < 20
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(plugins) p
         WHERE p->>'marketplace_id' = $4 AND p->>'plugin_name' = $5
       )`,
    [JSON.stringify(plugin), agentId, auth.tenantId, plugin.marketplace_id, plugin.plugin_name],
  );

  if (result.rowCount === 0) {
    throw new ConflictError("Plugin already exists or maximum 20 plugins per agent");
  }

  return jsonResponse(plugin, 201);
});
