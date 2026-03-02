import type { AgentPlane } from "../client";
import type { PluginMarketplace, PluginListItem } from "../types";

export class PluginMarketplacesResource {
  constructor(private readonly _client: AgentPlane) {}

  /** List available plugin marketplaces. */
  async list(): Promise<PluginMarketplace[]> {
    const resp = await this._client._request<{ data: PluginMarketplace[] }>(
      "GET",
      "/api/plugin-marketplaces",
    );
    return resp.data;
  }

  /** List plugins in a marketplace. */
  async listPlugins(marketplaceId: string): Promise<PluginListItem[]> {
    const resp = await this._client._request<{ data: PluginListItem[] }>(
      "GET",
      `/api/plugin-marketplaces/${marketplaceId}/plugins`,
    );
    return resp.data;
  }
}
