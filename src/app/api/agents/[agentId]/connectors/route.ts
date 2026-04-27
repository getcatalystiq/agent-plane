import { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { queryOne } from "@/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import {
  getConnectorStatuses,
  saveApiKeyConnector,
  toTenantConnectorInfo,
  sanitizeComposioError,
} from "@/lib/composio";

export const dynamic = "force-dynamic";

// GET /api/agents/:agentId/connectors — list connector statuses
export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId } = await context!.params;

  // Only load the columns we need (skip skills JSONB)
  const agent = await queryOne(
    z.object({ id: z.string(), tenant_id: z.string(), composio_toolkits: z.array(z.string()) }),
    "SELECT id, tenant_id, composio_toolkits FROM agents WHERE id = $1 AND tenant_id = $2",
    [agentId, auth.tenantId],
  );
  if (!agent) throw new NotFoundError("Agent not found");

  const statuses = await getConnectorStatuses(agent.id, agent.composio_toolkits);
  return jsonResponse({ data: statuses.map(toTenantConnectorInfo) });
});

const SaveKeySchema = z.object({
  toolkit: z.string().min(1),
  api_key: z.string().min(1),
});

// POST /api/agents/:agentId/connectors — save API key for a connector
export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId } = await context!.params;

  const agent = await queryOne(
    z.object({ id: z.string(), tenant_id: z.string(), composio_toolkits: z.array(z.string()) }),
    "SELECT id, tenant_id, composio_toolkits FROM agents WHERE id = $1 AND tenant_id = $2",
    [agentId, auth.tenantId],
  );
  if (!agent) throw new NotFoundError("Agent not found");

  const body = await request.json();
  const { toolkit, api_key } = SaveKeySchema.parse(body);

  // Validate toolkit is in agent's configured toolkits
  if (!agent.composio_toolkits.map((t) => t.toLowerCase()).includes(toolkit.toLowerCase())) {
    throw new ValidationError(
      `Toolkit "${toolkit}" is not configured on this agent. Add it to composio_toolkits first.`,
    );
  }

  try {
    await saveApiKeyConnector(agent.id, toolkit, api_key);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ValidationError(sanitizeComposioError(msg));
  }

  return jsonResponse({ slug: toolkit.toLowerCase(), connected: true });
});
