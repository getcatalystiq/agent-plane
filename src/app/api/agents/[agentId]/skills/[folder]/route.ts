import { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { queryOne, execute } from "@/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { SafeFolderName, UpdateSkillSchema, AgentSkillsPartialRow } from "@/lib/validation";

export const dynamic = "force-dynamic";

// GET /api/agents/:agentId/skills/:folder — get a single skill
export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId, folder } = await context!.params;
  SafeFolderName.parse(folder);

  const agent = await queryOne(
    AgentSkillsPartialRow.extend({ id: z.string(), tenant_id: z.string() }),
    "SELECT id, tenant_id, skills FROM agents WHERE id = $1 AND tenant_id = $2",
    [agentId, auth.tenantId],
  );
  if (!agent) throw new NotFoundError("Agent not found");

  const skill = agent.skills.find((s) => s.folder === folder);
  if (!skill) throw new NotFoundError(`Skill "${folder}" not found`);

  return jsonResponse(skill);
});

// PUT /api/agents/:agentId/skills/:folder — update a skill's files
export const PUT = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId, folder } = await context!.params;
  SafeFolderName.parse(folder);

  const body = await request.json();
  const { files } = UpdateSkillSchema.parse(body);

  // Load current skills to validate size after replacement
  const agent = await queryOne(
    AgentSkillsPartialRow.extend({ id: z.string(), tenant_id: z.string() }),
    "SELECT id, tenant_id, skills FROM agents WHERE id = $1 AND tenant_id = $2",
    [agentId, auth.tenantId],
  );
  if (!agent) throw new NotFoundError("Agent not found");

  const existingSkill = agent.skills.find((s) => s.folder === folder);
  if (!existingSkill) throw new NotFoundError(`Skill "${folder}" not found`);

  // Calculate total size after replacement
  const otherSkillsSize = agent.skills
    .filter((s) => s.folder !== folder)
    .reduce((sum, s) => sum + s.files.reduce((fSum, f) => fSum + f.content.length, 0), 0);
  const newFilesSize = files.reduce((sum, f) => sum + f.content.length, 0);

  if (otherSkillsSize + newFilesSize > 5 * 1024 * 1024) {
    throw new ValidationError("Total skills content must be under 5MB");
  }

  const updatedSkill = { folder, files };

  // Atomic replace — updates the matching element in-place
  const result = await execute(
    `UPDATE agents
     SET skills = (
       SELECT jsonb_agg(
         CASE WHEN elem->>'folder' = $1 THEN $2::jsonb ELSE elem END
       )
       FROM jsonb_array_elements(skills) AS elem
     ), updated_at = NOW()
     WHERE id = $3 AND tenant_id = $4
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(skills) s WHERE s->>'folder' = $1
       )`,
    [folder, JSON.stringify(updatedSkill), agentId, auth.tenantId],
  );

  if (result.rowCount === 0) {
    throw new NotFoundError(`Skill "${folder}" not found`);
  }

  return jsonResponse(updatedSkill);
});

// DELETE /api/agents/:agentId/skills/:folder — remove a skill
export const DELETE = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId, folder } = await context!.params;
  SafeFolderName.parse(folder);

  // Atomic filter — removes the matching element
  const result = await execute(
    `UPDATE agents
     SET skills = (
       SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
       FROM jsonb_array_elements(skills) AS elem
       WHERE elem->>'folder' != $1
     ), updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(skills) s WHERE s->>'folder' = $1
       )`,
    [folder, agentId, auth.tenantId],
  );

  if (result.rowCount === 0) {
    throw new NotFoundError(`Skill "${folder}" not found`);
  }

  return jsonResponse({ deleted: true });
});
