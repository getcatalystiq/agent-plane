import { NextRequest, NextResponse } from "next/server";
import { queryOne, execute } from "@/db";
import { McpServerRow, UpdateMcpServerSchema } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { NotFoundError } from "@/lib/errors";
import { clearServerCache } from "@/lib/mcp-connections";

export const dynamic = "force-dynamic";

const SERVER_COLS = "id, tenant_id, name, slug, description, logo_url, base_url, mcp_endpoint_path, client_id, oauth_metadata, created_at, updated_at";

type RouteContext = { params: Promise<{ mcpServerId: string }> };

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const { mcpServerId } = await (context as RouteContext).params;
  const tenantId = request.nextUrl.searchParams.get("tenant_id");

  let server;
  if (tenantId) {
    server = await queryOne(
      McpServerRow,
      `SELECT ${SERVER_COLS} FROM mcp_servers WHERE id = $1 AND tenant_id = $2`,
      [mcpServerId, tenantId],
    );
  } else {
    server = await queryOne(
      McpServerRow,
      `SELECT ${SERVER_COLS} FROM mcp_servers WHERE id = $1`,
      [mcpServerId],
    );
  }
  if (!server) throw new NotFoundError("MCP server not found");

  return NextResponse.json(server);
});

export const PATCH = withErrorHandler(async (request: NextRequest, context) => {
  const { mcpServerId } = await (context as RouteContext).params;
  const body = await request.json();
  const input = UpdateMcpServerSchema.parse(body);

  // Verify the server exists (and optionally belongs to tenant)
  const tenantId = request.nextUrl.searchParams.get("tenant_id");
  let existing;
  if (tenantId) {
    existing = await queryOne(
      McpServerRow,
      `SELECT ${SERVER_COLS} FROM mcp_servers WHERE id = $1 AND tenant_id = $2`,
      [mcpServerId, tenantId],
    );
  } else {
    existing = await queryOne(
      McpServerRow,
      `SELECT ${SERVER_COLS} FROM mcp_servers WHERE id = $1`,
      [mcpServerId],
    );
  }
  if (!existing) throw new NotFoundError("MCP server not found");

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.name !== undefined) {
    sets.push(`name = $${idx++}`);
    params.push(input.name);
  }
  if (input.description !== undefined) {
    sets.push(`description = $${idx++}`);
    params.push(input.description);
  }
  if (input.logo_url !== undefined) {
    sets.push(`logo_url = $${idx++}`);
    params.push(input.logo_url);
  }

  if (sets.length === 0) {
    return NextResponse.json({ error: { code: "validation_error", message: "No fields to update" } }, { status: 400 });
  }

  params.push(mcpServerId);
  await execute(`UPDATE mcp_servers SET ${sets.join(", ")} WHERE id = $${idx}`, params);
  clearServerCache(mcpServerId);

  const server = await queryOne(
    McpServerRow,
    `SELECT ${SERVER_COLS} FROM mcp_servers WHERE id = $1`,
    [mcpServerId],
  );
  if (!server) throw new NotFoundError("MCP server not found");

  return NextResponse.json(server);
});

export const DELETE = withErrorHandler(async (request: NextRequest, context) => {
  const { mcpServerId } = await (context as RouteContext).params;
  const tenantId = request.nextUrl.searchParams.get("tenant_id");

  // Verify the server exists (and optionally belongs to tenant)
  if (tenantId) {
    const existing = await queryOne(
      McpServerRow,
      `SELECT ${SERVER_COLS} FROM mcp_servers WHERE id = $1 AND tenant_id = $2`,
      [mcpServerId, tenantId],
    );
    if (!existing) throw new NotFoundError("MCP server not found");
  }

  // Delete all connections first, then the server
  await execute("DELETE FROM mcp_connections WHERE mcp_server_id = $1", [mcpServerId]);

  const { rowCount } = await execute("DELETE FROM mcp_servers WHERE id = $1", [mcpServerId]);
  if (rowCount === 0) throw new NotFoundError("MCP server not found");

  clearServerCache(mcpServerId);

  return NextResponse.json({ deleted: true });
});
