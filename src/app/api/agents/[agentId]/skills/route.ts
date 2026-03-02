import { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { queryOne, execute } from "@/db";
import { NotFoundError, ConflictError, ValidationError } from "@/lib/errors";
import { CreateSkillSchema, AgentSkillsPartialRow } from "@/lib/validation";

export const dynamic = "force-dynamic";

// GET /api/agents/:agentId/skills — list all skills
export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId } = await context!.params;

  const agent = await queryOne(
    AgentSkillsPartialRow.extend({ id: z.string(), tenant_id: z.string() }),
    "SELECT id, tenant_id, skills FROM agents WHERE id = $1 AND tenant_id = $2",
    [agentId, auth.tenantId],
  );
  if (!agent) throw new NotFoundError("Agent not found");

  return jsonResponse({ data: agent.skills });
});

// POST /api/agents/:agentId/skills — create a new skill
export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId } = await context!.params;

  const body = await request.json();
  const skill = CreateSkillSchema.parse(body);

  // Load current skills for validation
  const agent = await queryOne(
    AgentSkillsPartialRow.extend({ id: z.string(), tenant_id: z.string() }),
    "SELECT id, tenant_id, skills FROM agents WHERE id = $1 AND tenant_id = $2",
    [agentId, auth.tenantId],
  );
  if (!agent) throw new NotFoundError("Agent not found");

  // Validate limits before atomic insert
  if (agent.skills.length >= 50) {
    throw new ValidationError("Maximum 50 skills per agent");
  }

  const newTotalSize =
    agent.skills.reduce(
      (sum, s) => sum + s.files.reduce((fSum, f) => fSum + f.content.length, 0),
      0,
    ) + skill.files.reduce((sum, f) => sum + f.content.length, 0);

  if (newTotalSize > 5 * 1024 * 1024) {
    throw new ValidationError("Total skills content must be under 5MB");
  }

  // Atomic append — fails if folder already exists or count limit reached (rowCount = 0)
  const result = await execute(
    `UPDATE agents
     SET skills = skills || $1::jsonb, updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3
       AND jsonb_array_length(skills) < 50
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(skills) s WHERE s->>'folder' = $4
       )`,
    [JSON.stringify(skill), agentId, auth.tenantId, skill.folder],
  );

  if (result.rowCount === 0) {
    throw new ConflictError(`Skill folder "${skill.folder}" already exists`);
  }

  return jsonResponse(skill, 201);
});
