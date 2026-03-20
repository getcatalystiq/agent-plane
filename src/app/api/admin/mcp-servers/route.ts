import { NextRequest, NextResponse } from "next/server";
import { withErrorHandler } from "@/lib/api";
import { CreateMcpServerSchema } from "@/lib/validation";
import { listMcpServers, registerMcpServer, getCallbackBaseUrl } from "@/lib/mcp-connections";
import { validatePublicUrl } from "@/lib/mcp-oauth";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const tenantId = request.nextUrl.searchParams.get("tenant_id");
  const servers = await listMcpServers(tenantId ?? undefined);
  return NextResponse.json({ data: servers });
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const body = await request.json();
  const input = CreateMcpServerSchema.parse(body);

  // SSRF validation on base_url
  await validatePublicUrl(input.base_url);

  const callbackBaseUrl = getCallbackBaseUrl();
  logger.info("Registering MCP server", { slug: input.slug, base_url: input.base_url, tenant_id: input.tenant_id, callbackBaseUrl });

  const server = await registerMcpServer(
    {
      tenantId: input.tenant_id,
      name: input.name,
      slug: input.slug,
      description: input.description,
      logoUrl: input.logo_url,
      baseUrl: input.base_url,
      mcpEndpointPath: input.mcp_endpoint_path,
    },
    callbackBaseUrl,
  );

  return NextResponse.json(server, { status: 201 });
});
