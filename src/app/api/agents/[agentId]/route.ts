import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { UpdateAgentSchema } from "@/lib/validation";
import { resolveEffectiveRunner, isPermissionModeAllowed } from "@/lib/models";
import { deriveIdentity } from "@/lib/identity";
import { execute } from "@/db";
import { getAgentForTenant } from "@/lib/agents";
import { pruneAllowedToolsForToolkits } from "@/lib/composio";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId } = await context!.params;
  const agent = await getAgentForTenant(agentId, auth.tenantId);
  return jsonResponse(agent);
});

export const PUT = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId } = await context!.params;

  // Verify agent exists and get current values for cross-field validation
  const current = await getAgentForTenant(agentId, auth.tenantId);

  const body = await request.json();
  const input = UpdateAgentSchema.parse(body);

  // Reject permission_mode incompatible with Vercel AI SDK runner
  // Check whenever model, runner, OR permission_mode changes (prevents two-step bypass)
  const effectiveModel = input.model ?? current.model;
  const effectiveRunner = resolveEffectiveRunner(effectiveModel, input.runner !== undefined ? input.runner : current.runner);
  const effectivePermission = input.permission_mode ?? current.permission_mode;
  if (!isPermissionModeAllowed(effectiveRunner, effectivePermission)) {
    return jsonResponse(
      { error: { code: "validation_error", message: "Vercel AI SDK runner does not support permission modes other than 'default' and 'bypassPermissions'" } },
      400,
    );
  }

  // When toolkits change, prune composio_allowed_tools so orphan entries
  // (e.g. SLACK_* after swapping `slack` → `slackbot`) don't sit in the DB
  // and trigger the run-time "Dropped orphaned" log every run.
  if (input.composio_toolkits !== undefined) {
    const effectiveTools = input.composio_allowed_tools ?? current.composio_allowed_tools ?? [];
    const pruned = pruneAllowedToolsForToolkits(effectiveTools, input.composio_toolkits);
    if (pruned.length !== effectiveTools.length || input.composio_allowed_tools !== undefined) {
      input.composio_allowed_tools = pruned;
    }
  }

  // Build dynamic SET clause from provided fields
  const setClauses: string[] = ["updated_at = NOW()"];
  const params: unknown[] = [];
  let paramIdx = 1;

  const fields: Record<string, unknown> = {
    name: input.name,
    description: input.description,
    git_repo_url: input.git_repo_url,
    git_branch: input.git_branch,
    composio_toolkits: input.composio_toolkits,
    composio_allowed_tools: input.composio_allowed_tools,
    model: input.model,
    runner: input.runner,
    allowed_tools: input.allowed_tools,
    permission_mode: input.permission_mode,
    max_turns: input.max_turns,
    max_budget_usd: input.max_budget_usd,
    max_runtime_seconds: input.max_runtime_seconds,
    a2a_enabled: input.a2a_enabled,
    soul_md: input.soul_md,
    identity_md: input.identity_md,
    style_md: input.style_md,
    agents_md: input.agents_md,
    heartbeat_md: input.heartbeat_md,
    user_template_md: input.user_template_md,
    examples_good_md: input.examples_good_md,
    examples_bad_md: input.examples_bad_md,
    soul_spec_version: input.soul_spec_version,
  };

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      setClauses.push(`${key} = $${paramIdx}`);
      params.push(value);
      paramIdx++;
    }
  }

  // Derive identity JSONB when any identity-related markdown changes
  const identityFields = ["soul_md", "identity_md", "style_md", "agents_md", "heartbeat_md", "user_template_md", "examples_good_md", "examples_bad_md"] as const;
  if (identityFields.some(f => (input as Record<string, unknown>)[f] !== undefined)) {
    const cur = current as Record<string, unknown>;
    const eff = (f: string) => (input as Record<string, unknown>)[f] !== undefined ? (input as Record<string, unknown>)[f] as string | null : cur[f] as string | null;
    const parseResult = deriveIdentity(eff("soul_md"), eff("identity_md"), eff("style_md"), eff("agents_md"), eff("heartbeat_md"), eff("user_template_md"), eff("examples_good_md"), eff("examples_bad_md"));
    setClauses.push(`identity = $${paramIdx}::jsonb`);
    params.push(parseResult.identity ? JSON.stringify(parseResult.identity) : null);
    paramIdx++;
  }

  // Skills and plugins need a JSONB cast
  if (input.skills !== undefined) {
    setClauses.push(`skills = $${paramIdx}::jsonb`);
    params.push(JSON.stringify(input.skills));
    paramIdx++;
  }

  if (input.plugins !== undefined) {
    setClauses.push(`plugins = $${paramIdx}::jsonb`);
    params.push(JSON.stringify(input.plugins));
    paramIdx++;
  }

  // Note: composio_mcp_server_id is intentionally kept — the server is
  // stable and will be updated with the new toolkit list on the next run.

  params.push(agentId, auth.tenantId);
  await execute(
    `UPDATE agents SET ${setClauses.join(", ")}
     WHERE id = $${paramIdx} AND tenant_id = $${paramIdx + 1}`,
    params,
  );

  const updated = await getAgentForTenant(agentId, auth.tenantId);
  logger.info("Agent updated", { tenant_id: auth.tenantId, agent_id: agentId });
  return jsonResponse(updated);
});

export const DELETE = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId } = await context!.params;

  await getAgentForTenant(agentId, auth.tenantId);
  await execute(
    "DELETE FROM agents WHERE id = $1 AND tenant_id = $2",
    [agentId, auth.tenantId],
  );

  logger.info("Agent deleted", { tenant_id: auth.tenantId, agent_id: agentId });
  return jsonResponse({ deleted: true });
});
