import type { AgentPlane } from "../client";
import type { AgentPlugin } from "../types";

export class PluginsResource {
  constructor(private readonly _client: AgentPlane) {}

  /** List all plugins for an agent. */
  async list(agentId: string): Promise<AgentPlugin[]> {
    const resp = await this._client._request<{ data: AgentPlugin[] }>(
      "GET",
      `/api/agents/${agentId}/plugins`,
    );
    return resp.data;
  }

  /** Add a plugin to an agent. */
  async add(agentId: string, plugin: AgentPlugin): Promise<AgentPlugin> {
    return this._client._request<AgentPlugin>("POST", `/api/agents/${agentId}/plugins`, {
      body: plugin,
    });
  }

  /** Remove a plugin from an agent. */
  async remove(agentId: string, marketplaceId: string, pluginName: string): Promise<void> {
    await this._client._request<unknown>(
      "DELETE",
      `/api/agents/${agentId}/plugins/${encodeURIComponent(marketplaceId)}/${encodeURIComponent(pluginName)}`,
    );
  }
}
