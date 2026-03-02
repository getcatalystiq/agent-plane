import type { AgentPlane } from "../client";
import type { PluginMarketplace, PluginListItem } from "../types";

/**
 * Plugin marketplace discovery. Provides read-only access to the global
 * marketplace registry. Marketplace creation/deletion/token management
 * requires admin access and is not available through tenant API keys.
 */
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
      `/api/plugin-marketplaces/${encodeURIComponent(marketplaceId)}/plugins`,
    );
    return resp.data;
  }
}
