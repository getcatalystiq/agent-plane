/**
 * Admin API for chat-platform bots — GET / POST / DELETE per
 * (agent, platform).
 *
 * Plan reference: U8 in
 * docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
 *
 * Auth: ADMIN_API_KEY is global; the route enforces tenant isolation by
 * deriving tenant_id from the agent row, not from the caller. Agent-not-
 * found and cross-tenant agent both return uniform 404 (no enumeration
 * oracle).
 *
 * After a successful upsert / disable, the route imports `forceRefresh`
 * from the bot registry and calls it server-side — no internal HTTP route
 * carries CRON_SECRET in transit.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { queryOne } from "@/db";
import { withErrorHandler } from "@/lib/api";
import { logger } from "@/lib/logger";
import {
  upsertBotConfig,
  getBotConfig,
  disableBotConfig,
  AttestationGateError,
  CredentialValidationError,
  type ChatPlatform,
  type DiscordCredentials,
  type SlackCredentials,
} from "@/lib/platform/operations";
import { forceRefresh } from "@/lib/platform/bot";
import type { TenantId, AgentId } from "@/lib/types";

export const dynamic = "force-dynamic";

const PlatformParam = z.enum(["discord", "slack"]);

type RouteContext = { params: Promise<{ agentId: string; platform: string }> };

const AgentTenantRow = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
});

async function loadAgentOr404(agentId: string): Promise<{ id: string; tenant_id: string } | null> {
  return queryOne(AgentTenantRow, "SELECT id, tenant_id FROM agents WHERE id = $1", [agentId]);
}

const DiscordCredentialsBody = z.object({
  platform: z.literal("discord"),
  botToken: z.string().min(1),
  publicKey: z.string().min(1),
  applicationId: z.string().min(1),
});

// Slack signing secrets are 32 lowercase hex chars (per Slack's Basic
// Information → App Credentials → Signing Secret value, observed
// across every working bot in the registry). Operators have repeatedly
// pasted the wrong field — Client Secret, Verification Token, Webhook
// URL, etc. — into this slot, where any non-empty string used to pass.
// The downstream HMAC verify then fails on every inbound event with a
// signature mismatch that's invisible until the operator hits the
// fingerprint diagnostic. Reject the wrong field at the connect-time
// boundary instead.
const SLACK_SIGNING_SECRET_RE = /^[a-f0-9]{32}$/;

const SlackCredentialsBody = z.object({
  platform: z.literal("slack"),
  botToken: z
    .string()
    .min(1)
    .refine((v) => v.startsWith("xoxb-"), {
      message:
        "Slack bot token must start with `xoxb-` (Bot User OAuth Token from Slack app's OAuth & Permissions page). Did you paste an OAuth code or User OAuth Token instead?",
    }),
  signingSecret: z
    .string()
    .min(1)
    .refine((v) => SLACK_SIGNING_SECRET_RE.test(v), {
      message:
        "Slack signing secret must be 32 lowercase hex characters. Copy it from Slack app → Basic Information → App Credentials → Signing Secret (NOT Client Secret, NOT Verification Token, NOT Webhook URL).",
    }),
  appId: z.string().optional(),
  teamId: z.string().optional(),
});

const UpsertBody = z.object({
  credentials: z.discriminatedUnion("platform", [DiscordCredentialsBody, SlackCredentialsBody]),
  attestations: z.object({ private_workspace: z.boolean() }),
});

// ---------------------------------------------------------------------------
// GET — public-shape config or uniform 404
// ---------------------------------------------------------------------------

export const GET = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId, platform: rawPlatform } = await (context as RouteContext).params;

  const platformResult = PlatformParam.safeParse(rawPlatform);
  if (!platformResult.success) return uniform404();

  const agent = await loadAgentOr404(agentId);
  if (!agent) return uniform404();

  const config = await getBotConfig(agent.tenant_id as TenantId, agent.id as AgentId, platformResult.data);
  if (!config) return uniform404();

  return NextResponse.json({ config });
});

// ---------------------------------------------------------------------------
// POST — upsert + force-refresh on success; preserves prior config on
// validation failure (upsertBotConfig only writes after both gates pass).
// ---------------------------------------------------------------------------

export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const { agentId, platform: rawPlatform } = await (context as RouteContext).params;

  const platformResult = PlatformParam.safeParse(rawPlatform);
  if (!platformResult.success) return uniform404();

  const agent = await loadAgentOr404(agentId);
  if (!agent) return uniform404();

  const platform = platformResult.data;
  const json = await request.json();
  const parsed = UpsertBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_body", message: parsed.error.message } },
      { status: 400 },
    );
  }

  if (parsed.data.credentials.platform !== platform) {
    return NextResponse.json(
      { error: { code: "platform_mismatch", message: "credentials.platform must match URL" } },
      { status: 400 },
    );
  }

  try {
    const config = await upsertBotConfig({
      tenantId: agent.tenant_id as TenantId,
      agentId: agent.id as AgentId,
      credentials: parsed.data.credentials as DiscordCredentials | SlackCredentials,
      attestations: parsed.data.attestations,
    });

    // Force the bot registry cache to evict / rebuild — no HTTP, no
    // CRON_SECRET in transit. Direct in-process import.
    await forceRefresh().catch((err) => {
      logger.warn("platforms POST: forceRefresh failed (best-effort)", {
        agent_id: agentId,
        platform,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return NextResponse.json({ config });
  } catch (err) {
    if (err instanceof AttestationGateError) {
      return NextResponse.json(
        { error: { code: err.reason, message: err.message } },
        { status: 400 },
      );
    }
    if (err instanceof CredentialValidationError) {
      return NextResponse.json(
        {
          error: {
            code: err.result.error.code,
            message: err.result.error.message,
            retryAfterSeconds: err.result.error.retryAfterSeconds,
          },
        },
        { status: 400 },
      );
    }
    // Round-5 review #4: TenantBotCapExceededError now extends
    // ConflictError → AppError, so withErrorHandler maps it to 409
    // automatically using the class's toJSON() (which surfaces
    // platform + limit). The hand-rolled mapping that lived here is
    // unnecessary — let it bubble.
    throw err;
  }
});

// ---------------------------------------------------------------------------
// DELETE — flip enabled=false + force-refresh.
// ---------------------------------------------------------------------------

export const DELETE = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId, platform: rawPlatform } = await (context as RouteContext).params;

  const platformResult = PlatformParam.safeParse(rawPlatform);
  if (!platformResult.success) return uniform404();

  const agent = await loadAgentOr404(agentId);
  if (!agent) return uniform404();

  const platform = platformResult.data;
  const config = await disableBotConfig(
    agent.tenant_id as TenantId,
    agent.id as AgentId,
    platform,
  );
  if (!config) return uniform404();

  await forceRefresh().catch((err) => {
    logger.warn("platforms DELETE: forceRefresh failed (best-effort)", {
      agent_id: agentId,
      platform,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return NextResponse.json({ config });
});

function uniform404(): NextResponse {
  // Uniform 404 for both not-found and cross-tenant cases. Avoids the
  // enumeration oracle where 400 vs 404 vs 403 leaks whether an agent
  // exists at all.
  return NextResponse.json(
    { error: { code: "not_found", message: "Bot config not found" } },
    { status: 404 },
  );
}

export type ChatPlatformParam = ChatPlatform;
