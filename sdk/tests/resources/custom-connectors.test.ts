import { describe, it, expect, vi } from "vitest";
import { createClient, jsonOk, jsonError } from "../helpers";

describe("CustomConnectorsResource", () => {
  describe("top-level methods", () => {
    it("listServers returns server array", async () => {
      const servers = [
        { id: "srv_1", name: "My MCP", slug: "my-mcp", description: "Test", logo_url: null, base_url: "https://mcp.example.com", mcp_endpoint_path: "/mcp", client_id: null, oauth_metadata: null, created_at: "2026-01-01", updated_at: "2026-01-01" },
      ];
      const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ data: servers }));
      const client = createClient(mockFetch);

      const result = await client.customConnectors.listServers();

      expect(result).toEqual(servers);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/mcp-servers");
    });
  });

  describe("agent-scoped methods", () => {
    it("list returns connection array", async () => {
      const connections = [
        { id: "conn_1", tenant_id: "t_1", agent_id: "a_1", mcp_server_id: "srv_1", status: "active", granted_scopes: [], allowed_tools: [], token_expires_at: null, server_name: "Test", server_slug: "test", server_logo_url: null, server_base_url: "https://...", created_at: "2026-01-01", updated_at: "2026-01-01" },
      ];
      const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ data: connections }));
      const client = createClient(mockFetch);

      const result = await client.agents.customConnectors.list("agent_1");

      expect(result).toEqual(connections);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/agents/agent_1/mcp-connections");
    });

    it("delete sends DELETE request", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ deleted: true }));
      const client = createClient(mockFetch);

      await client.agents.customConnectors.delete("agent_1", "srv_1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/agents/agent_1/mcp-connections/srv_1");
      expect(init.method).toBe("DELETE");
    });

    it("updateAllowedTools sends PATCH with allowed_tools", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ updated: true }));
      const client = createClient(mockFetch);

      await client.agents.customConnectors.updateAllowedTools("agent_1", "srv_1", ["tool_a", "tool_b"]);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/agents/agent_1/mcp-connections/srv_1");
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body)).toEqual({ allowed_tools: ["tool_a", "tool_b"] });
    });

    it("listTools returns tool array", async () => {
      const tools = [{ name: "read_file", description: "Read a file", inputSchema: {} }];
      const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ data: tools }));
      const client = createClient(mockFetch);

      const result = await client.agents.customConnectors.listTools("agent_1", "srv_1");

      expect(result).toEqual(tools);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/agents/agent_1/mcp-connections/srv_1/tools");
    });

    it("initiateOauth returns redirectUrl (camelCase)", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        jsonOk({ redirectUrl: "https://mcp-server.com/oauth/authorize?..." }),
      );
      const client = createClient(mockFetch);

      const result = await client.agents.customConnectors.initiateOauth("agent_1", "srv_1");

      expect(result.redirectUrl).toContain("https://mcp-server.com");
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/agents/agent_1/mcp-connections/srv_1/initiate-oauth");
      expect(init.method).toBe("POST");
    });
  });

  it("throws AgentPlaneError on not found", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonError(404, { code: "not_found", message: "Connection not found" }),
    );
    const client = createClient(mockFetch);

    await expect(client.agents.customConnectors.delete("agent_1", "nonexistent"))
      .rejects.toThrow("Connection not found");
  });

  it("client.agents.customConnectors and client.customConnectors share the same instance", () => {
    const mockFetch = vi.fn();
    const client = createClient(mockFetch);

    expect(client.agents.customConnectors).toBe(client.customConnectors);
  });
});
