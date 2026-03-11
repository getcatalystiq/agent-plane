import { NextRequest, NextResponse } from "next/server";
import { withErrorHandler } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { RateLimitError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  buildAgentCard,
  getCachedAgentCard,
  setCachedAgentCard,
  sanitizeRequestId,
} from "@/lib/a2a";
import { getHttpClient } from "@/db";
import { z } from "zod";

export const dynamic = "force-dynamic";

const TenantSlugRow = z.object({
  id: z.string(),
  name: z.string(),
});

export const GET = withErrorHandler(async (
  request: NextRequest,
  context,
) => {
  const { slug } = await context!.params;

  // Rate limit: 60 req/min per IP (unauthenticated endpoint)
  const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rl = checkRateLimit(`a2a-card:${clientIp}`, 60, 60_000);
  if (!rl.allowed) {
    logger.warn("A2A Agent Card rate limited", { ip: clientIp, slug });
    throw new RateLimitError(Math.ceil(rl.retryAfterMs / 1000));
  }

  const requestId = sanitizeRequestId(request.headers.get("a2a-request-id"));

  // Check process-level cache
  // We cache by slug since tenantId isn't known yet
  const cached = getCachedAgentCard(slug);
  if (cached) {
    return NextResponse.json(cached, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=300",
        "A2A-Version": "1.0",
        "A2A-Request-Id": requestId,
      },
    });
  }

  // Resolve tenant by slug via HTTP driver (not pool)
  const sql = getHttpClient();
  const tenantRows = await sql`
    SELECT id, name FROM tenants WHERE slug = ${slug} AND status = 'active'
  `;

  if (tenantRows.length === 0) {
    // Uniform 404 for non-existent tenants (prevents enumeration)
    return NextResponse.json(
      { error: { code: "not_found", message: "Not found" } },
      {
        status: 404,
        headers: {
          "Cache-Control": "public, max-age=300",
          "A2A-Version": "1.0",
          "A2A-Request-Id": requestId,
        },
      },
    );
  }

  const tenant = TenantSlugRow.parse(tenantRows[0]);

  // Build base URL from request
  const proto = request.headers.get("x-forwarded-proto") || "https";
  const host = request.headers.get("host") || "localhost";
  const baseUrl = `${proto}://${host}`;

  const card = await buildAgentCard(slug, tenant.name, baseUrl);

  if (!card) {
    // Uniform 404 for tenants with zero a2a_enabled agents
    return NextResponse.json(
      { error: { code: "not_found", message: "Not found" } },
      {
        status: 404,
        headers: {
          "Cache-Control": "public, max-age=300",
          "A2A-Version": "1.0",
          "A2A-Request-Id": requestId,
        },
      },
    );
  }

  // Cache the card
  setCachedAgentCard(slug, card);

  return NextResponse.json(card, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=300",
      "A2A-Version": "1.0",
      "A2A-Request-Id": requestId,
    },
  });
});
