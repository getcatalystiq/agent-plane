import { queryOne } from "@/db";
import { AgentRow } from "@/lib/validation";
import { NotFoundError } from "@/lib/errors";
import type { TenantId } from "@/lib/types";

/**
 * Load an agent, verifying it belongs to the given tenant.
 * Throws NotFoundError if the agent does not exist or belongs to a different tenant.
 */
export async function getAgentForTenant(agentId: string, tenantId: TenantId) {
  const agent = await queryOne(
    AgentRow,
    "SELECT * FROM agents WHERE id = $1 AND tenant_id = $2",
    [agentId, tenantId],
  );
  if (!agent) throw new NotFoundError("Agent not found");
  return agent;
}
