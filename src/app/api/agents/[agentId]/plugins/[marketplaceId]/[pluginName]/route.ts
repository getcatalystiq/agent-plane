import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { execute } from "@/db";
import { NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";

// DELETE /api/agents/:agentId/plugins/:marketplaceId/:pluginName — remove a plugin
export const DELETE = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId, marketplaceId, pluginName } = await context!.params;

  // Atomic filter — removes the matching plugin entry
  const result = await execute(
    `UPDATE agents
     SET plugins = (
       SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
       FROM jsonb_array_elements(plugins) AS elem
       WHERE NOT (elem->>'marketplace_id' = $1 AND elem->>'plugin_name' = $2)
     ), updated_at = NOW()
     WHERE id = $3 AND tenant_id = $4
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(plugins) p
         WHERE p->>'marketplace_id' = $1 AND p->>'plugin_name' = $2
       )`,
    [marketplaceId, pluginName, agentId, auth.tenantId],
  );

  if (result.rowCount === 0) {
    throw new NotFoundError("Plugin not found on this agent");
  }

  return jsonResponse({ deleted: true });
});
