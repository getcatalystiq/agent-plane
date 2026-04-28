import { execute, queryOne } from "@/db";
import { z } from "zod";
import type { ConnectionMetadata } from "@/lib/types";
import { logger } from "@/lib/logger";

/**
 * Read agents.composio_connection_metadata as a typed map.
 * Returns {} when the column is empty or the row doesn't exist.
 */
export async function readConnectionMetadata(
  agentId: string,
): Promise<Record<string, ConnectionMetadata>> {
  const row = await queryOne(
    z.object({ composio_connection_metadata: z.unknown() }),
    "SELECT composio_connection_metadata FROM agents WHERE id = $1",
    [agentId],
  );
  if (!row) return {};
  const raw = row.composio_connection_metadata;
  if (!raw || typeof raw !== "object") return {};
  return raw as Record<string, ConnectionMetadata>;
}

/**
 * Atomically merge a single per-toolkit entry into the agent's
 * composio_connection_metadata JSONB column. Other slugs' entries are
 * untouched. The merge happens in SQL via jsonb_set so concurrent writes for
 * different slugs don't clobber each other.
 */
export async function upsertConnectionMetadata(
  agentId: string,
  slug: string,
  entry: ConnectionMetadata,
): Promise<void> {
  await execute(
    `UPDATE agents
       SET composio_connection_metadata = jsonb_set(
         coalesce(composio_connection_metadata, '{}'::jsonb),
         $2,
         $3::jsonb,
         true
       )
       WHERE id = $1`,
    [agentId, `{${slug.toLowerCase()}}`, JSON.stringify(entry)],
  );
  logger.info("Connection metadata upserted", {
    agent_id: agentId,
    slug: slug.toLowerCase(),
    auth_method: entry.auth_method,
    has_bot_user_id: !!entry.bot_user_id,
  });
}

/**
 * Remove a single per-toolkit entry from composio_connection_metadata. Used
 * during scheme switches and toolkit removals.
 */
export async function deleteConnectionMetadata(
  agentId: string,
  slug: string,
): Promise<void> {
  await execute(
    `UPDATE agents
       SET composio_connection_metadata = composio_connection_metadata - $2
       WHERE id = $1`,
    [agentId, slug.toLowerCase()],
  );
}

/**
 * Audit log for credential install/replace events. Single structured line; no
 * separate table this round (per plan).
 */
export function auditCredentialChange(args: {
  agentId: string;
  tenantId: string;
  slug: string;
  authMethod: string;
  event: "install" | "replace" | "remove" | "recapture";
}): void {
  logger.info("connector.credential_change", args);
}
