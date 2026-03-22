import { queryOne, execute } from "@/db";
import { AgentRow, CreateAgentSchema } from "@/lib/validation";
import { NotFoundError, ValidationError, ConflictError } from "@/lib/errors";
import { generateId } from "@/lib/crypto";
import type { TenantId } from "@/lib/types";
import type { z } from "zod";

const RESERVED_SLUGS = new Set(["well-known", "api", "admin", "health", "jsonrpc"]);

/** Slugify a name for URL-safe usage. */
export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}

interface CreateAgentOptions {
  /** Override the auto-derived slug. */
  slug?: string;
}

interface CreateAgentResult {
  id: string;
  name: string;
  slug: string;
}

/**
 * Insert an agent with retry on duplicate name/slug.
 * Throws ValidationError for reserved slugs, ConflictError for slug collisions.
 */
export async function createAgentRecord(
  tenantId: string,
  input: z.infer<typeof CreateAgentSchema>,
  options?: CreateAgentOptions,
): Promise<CreateAgentResult> {
  const id = generateId();
  const rawSlug = options?.slug ?? (slugifyName(input.name) || `agent-${id.slice(0, 8)}`);

  if (isReservedSlug(rawSlug)) {
    throw new ValidationError(`Slug '${rawSlug}' is reserved`);
  }

  let name = input.name;
  let slug = rawSlug;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await execute(
        `INSERT INTO agents (id, tenant_id, name, slug, description, git_repo_url, git_branch,
          composio_toolkits, skills, model, runner, allowed_tools, permission_mode, max_turns, max_budget_usd, max_runtime_seconds, a2a_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          id,
          tenantId,
          name,
          slug,
          input.description ?? null,
          input.git_repo_url ?? null,
          input.git_branch,
          input.composio_toolkits,
          JSON.stringify(input.skills),
          input.model,
          input.runner ?? null,
          input.allowed_tools,
          input.permission_mode,
          input.max_turns,
          input.max_budget_usd,
          input.max_runtime_seconds,
          input.a2a_enabled,
        ],
      );
      return { id, name, slug };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("agents_tenant_id_name_key") && attempt < 4) {
        name = `${input.name}-${attempt + 2}`;
        slug = `${rawSlug}-${attempt + 2}`;
        continue;
      }
      if (msg.includes("23505") && msg.includes("tenant_slug")) {
        throw new ConflictError(`Slug '${slug}' is already taken`);
      }
      throw err;
    }
  }
  throw new ConflictError(`Failed to create agent after retries`);
}

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
