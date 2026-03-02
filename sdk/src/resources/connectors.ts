import type { AgentPlane } from "../client";
import type {
  ConnectorInfo,
  SaveConnectorApiKeyParams,
  ConnectorOauthResult,
  ComposioToolkit,
  ComposioTool,
} from "../types";

export class ConnectorsResource {
  constructor(private readonly _client: AgentPlane) {}

  // --- Agent-scoped methods ---

  /** List connector statuses for an agent. */
  async list(agentId: string): Promise<ConnectorInfo[]> {
    const resp = await this._client._request<{ data: ConnectorInfo[] }>(
      "GET",
      `/api/agents/${agentId}/connectors`,
    );
    return resp.data;
  }

  /** Save an API key for a connector toolkit. */
  async saveApiKey(
    agentId: string,
    params: SaveConnectorApiKeyParams,
  ): Promise<{ slug: string; connected: boolean }> {
    return this._client._request<{ slug: string; connected: boolean }>(
      "POST",
      `/api/agents/${agentId}/connectors`,
      { body: params },
    );
  }

  /** Initiate OAuth flow for a Composio connector. Returns redirect URL. */
  async initiateOauth(agentId: string, toolkit: string): Promise<ConnectorOauthResult> {
    return this._client._request<ConnectorOauthResult>(
      "POST",
      `/api/agents/${agentId}/connectors/${encodeURIComponent(toolkit)}/initiate-oauth`,
    );
  }

  // --- Top-level discovery methods ---

  /** List available Composio toolkits. */
  async availableToolkits(): Promise<ComposioToolkit[]> {
    const resp = await this._client._request<{ data: ComposioToolkit[] }>(
      "GET",
      "/api/composio/toolkits",
    );
    return resp.data;
  }

  /** List tools in a Composio toolkit. */
  async availableTools(toolkit: string): Promise<ComposioTool[]> {
    const resp = await this._client._request<{ data: ComposioTool[] }>(
      "GET",
      "/api/composio/tools",
      { query: { toolkit } },
    );
    return resp.data;
  }
}
