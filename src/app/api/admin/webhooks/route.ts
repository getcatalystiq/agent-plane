import { NextRequest } from "next/server";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { ConflictError, ValidationError } from "@/lib/errors";
import {
  CreateWebhookSourceSchema,
  createWebhookSource,
  listWebhookSources,
} from "@/lib/webhooks";
import type { AgentId, TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const url = new URL(request.url);
  const tenantId = url.searchParams.get("tenant_id");
  const agentId = url.searchParams.get("agent_id");
  if (!tenantId) throw new ValidationError("tenant_id query param is required");
  const sources = await listWebhookSources(
    tenantId as TenantId,
    agentId ? (agentId as AgentId) : undefined,
  );
  return jsonResponse({ data: sources });
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const body = await request.json();
  const tenantId = body?.tenant_id;
  if (typeof tenantId !== "string") {
    throw new ValidationError("tenant_id is required");
  }
  const input = CreateWebhookSourceSchema.parse(body);
  try {
    const { source, secret } = await createWebhookSource({
      tenantId: tenantId as TenantId,
      agentId: input.agent_id as AgentId,
      name: input.name,
      promptTemplate: input.prompt_template,
      signatureHeader: input.signature_header,
      secret: input.secret,
      enabled: input.enabled,
      filterRules: input.filter_rules ?? null,
    });
    const { secret_enc, previous_secret_enc, previous_secret_expires_at, ...publicFields } = source;
    void secret_enc; void previous_secret_enc; void previous_secret_expires_at;
    // Only echo the secret when the caller didn't supply one — they need to
    // see the auto-generated value once. If they supplied a secret, they
    // already know it; don't bounce it back.
    return jsonResponse({ ...publicFields, ...(input.secret ? {} : { secret }) }, 201);
  } catch (err) {
    if (typeof err === "object" && err && "code" in err) {
      const code = (err as { code: string }).code;
      if (code === "23505") throw new ConflictError("A webhook with this name already exists");
      if (code === "23503") throw new ConflictError("Agent not found or not in this tenant");
    }
    throw err;
  }
});
