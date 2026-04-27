import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { ConflictError } from "@/lib/errors";
import {
  CreateWebhookSourceSchema,
  createWebhookSource,
  listWebhookSources,
} from "@/lib/webhooks";
import type { AgentId, TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const url = new URL(request.url);
  const agentIdParam = url.searchParams.get("agent_id");
  const sources = await listWebhookSources(
    auth.tenantId,
    agentIdParam ? (agentIdParam as AgentId) : undefined,
  );
  return jsonResponse({ data: sources });
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const body = await request.json();
  const input = CreateWebhookSourceSchema.parse(body);

  try {
    const { source, secret } = await createWebhookSource({
      tenantId: auth.tenantId as TenantId,
      agentId: input.agent_id as AgentId,
      name: input.name,
      promptTemplate: input.prompt_template,
      signatureHeader: input.signature_header,
      secret: input.secret,
      enabled: input.enabled,
      filterRules: input.filter_rules ?? null,
    });
    return jsonResponse(
      {
        ...redactSecrets(source),
        ...(input.secret ? {} : { secret }),
      },
      201,
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError("A webhook with this name already exists");
    }
    if (isForeignKeyViolation(err)) {
      throw new ConflictError("Agent not found or not accessible to this tenant");
    }
    throw err;
  }
});

function redactSecrets<T extends { secret_enc?: unknown; previous_secret_enc?: unknown; previous_secret_expires_at?: unknown }>(
  row: T,
): Omit<T, "secret_enc" | "previous_secret_enc" | "previous_secret_expires_at"> {
  const { secret_enc: _s, previous_secret_enc: _p, previous_secret_expires_at: _e, ...rest } = row;
  return rest;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "23505";
}

function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "23503";
}
