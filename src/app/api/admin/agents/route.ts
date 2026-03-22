import { NextRequest, NextResponse } from "next/server";
import { query, queryOne, execute } from "@/db";
import { PaginationSchema, CreateAgentSchema, AgentRow, TenantRow } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { generateId } from "@/lib/crypto";
import { slugifyName, isReservedSlug } from "@/lib/agents";
import { z } from "zod";

export const dynamic = "force-dynamic";

const AgentWithTenant = z.object({
  id: z.string(),
  tenant_id: z.string(),
  tenant_name: z.string(),
  name: z.string(),
  model: z.string(),
  permission_mode: z.string(),
  composio_toolkits: z.array(z.string()),
  max_turns: z.coerce.number(),
  max_budget_usd: z.coerce.number(),
  created_at: z.coerce.string(),
  run_count: z.coerce.number(),
  last_run_at: z.coerce.string().nullable(),
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  const url = new URL(request.url);
  const { limit, offset } = PaginationSchema.parse({
    limit: url.searchParams.get("limit") ?? "50",
    offset: url.searchParams.get("offset") ?? "0",
  });

  const agents = await query(
    AgentWithTenant,
    `SELECT a.id, a.tenant_id, t.name AS tenant_name, a.name, a.model,
       a.permission_mode, a.composio_toolkits, a.max_turns, a.max_budget_usd, a.created_at,
       COUNT(r.id)::int AS run_count,
       MAX(r.created_at) AS last_run_at
     FROM agents a
     JOIN tenants t ON t.id = a.tenant_id
     LEFT JOIN runs r ON r.agent_id = a.id
     GROUP BY a.id, t.name
     ORDER BY a.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );

  return NextResponse.json({ data: agents, limit, offset });
});

const AdminCreateAgentSchema = CreateAgentSchema.extend({
  tenant_id: z.string().uuid(),
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const body = await request.json();
  const input = AdminCreateAgentSchema.parse(body);

  const tenant = await queryOne(TenantRow, "SELECT * FROM tenants WHERE id = $1", [input.tenant_id]);
  if (!tenant) {
    return NextResponse.json({ error: { code: "not_found", message: "Tenant not found" } }, { status: 404 });
  }

  const id = generateId();

  // Derive slug from name if not provided; fallback to agent-{id} for edge cases
  const rawSlug = (input as { slug?: string }).slug ?? (slugifyName(input.name) || `agent-${id.slice(0, 8)}`);
  if (isReservedSlug(rawSlug)) {
    return NextResponse.json({ error: { code: "validation_error", message: `Slug '${rawSlug}' is reserved` } }, { status: 422 });
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
          input.tenant_id,
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
      break;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("agents_tenant_id_name_key") && attempt < 4) {
        name = `${input.name}-${attempt + 2}`;
        slug = `${rawSlug}-${attempt + 2}`;
        continue;
      }
      if (msg.includes("23505") && msg.includes("tenant_slug")) {
        return NextResponse.json({ error: { code: "conflict", message: `Slug '${slug}' is already taken` } }, { status: 409 });
      }
      throw err;
    }
  }

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [id]);
  return NextResponse.json(agent, { status: 201 });
});
