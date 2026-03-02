import type { AgentPlane } from "../client";
import type {
  CustomConnectorServer,
  CustomConnectorConnection,
  CustomConnectorTool,
  CustomConnectorOauthResult,
} from "../types";

export class CustomConnectorsResource {
  constructor(private readonly _client: AgentPlane) {}

  // --- Top-level method ---

  /** List available custom connector servers (MCP server registry). */
  async listServers(): Promise<CustomConnectorServer[]> {
    const resp = await this._client._request<{ data: CustomConnectorServer[] }>(
      "GET",
      "/api/mcp-servers",
    );
    return resp.data;
  }

  // --- Agent-scoped methods ---

  /** List custom connector connections for an agent. */
  async list(agentId: string): Promise<CustomConnectorConnection[]> {
    const resp = await this._client._request<{ data: CustomConnectorConnection[] }>(
      "GET",
      `/api/agents/${agentId}/mcp-connections`,
    );
    return resp.data;
  }

  /** Delete a custom connector connection. */
  async delete(agentId: string, serverId: string): Promise<void> {
    await this._client._request<unknown>(
      "DELETE",
      `/api/agents/${agentId}/mcp-connections/${serverId}`,
    );
  }

  /** Update allowed tools for a custom connector connection. */
  async updateAllowedTools(
    agentId: string,
    serverId: string,
    allowedTools: string[],
  ): Promise<void> {
    await this._client._request<unknown>(
      "PATCH",
      `/api/agents/${agentId}/mcp-connections/${serverId}`,
      { body: { allowed_tools: allowedTools } },
    );
  }

  /** List tools available on a custom connector server. */
  async listTools(agentId: string, serverId: string): Promise<CustomConnectorTool[]> {
    const resp = await this._client._request<{ data: CustomConnectorTool[] }>(
      "GET",
      `/api/agents/${agentId}/mcp-connections/${serverId}/tools`,
    );
    return resp.data;
  }

  /** Initiate OAuth flow for a custom connector. Returns redirect URL. */
  async initiateOauth(
    agentId: string,
    serverId: string,
  ): Promise<CustomConnectorOauthResult> {
    return this._client._request<CustomConnectorOauthResult>(
      "POST",
      `/api/agents/${agentId}/mcp-connections/${serverId}/initiate-oauth`,
    );
  }
}
