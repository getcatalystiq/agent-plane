import type { AgentPlane } from "../client";
import type { PluginMarketplace, PluginListItem, PluginDetail } from "../types";

/**
 * Plugin marketplace management. Provides CRUD access to the tenant-scoped
 * marketplace registry.
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

  /** Get a single marketplace by ID. */
  async get(marketplaceId: string): Promise<PluginMarketplace> {
    return this._client._request<PluginMarketplace>(
      "GET",
      `/api/plugin-marketplaces/${encodeURIComponent(marketplaceId)}`,
    );
  }

  /** Create a new marketplace. */
  async create(data: { name: string; github_repo: string; github_token?: string }): Promise<PluginMarketplace> {
    return this._client._request<PluginMarketplace>(
      "POST",
      "/api/plugin-marketplaces",
      { body: data },
    );
  }

  /** Delete a marketplace. */
  async delete(marketplaceId: string): Promise<{ deleted: boolean }> {
    return this._client._request<{ deleted: boolean }>(
      "DELETE",
      `/api/plugin-marketplaces/${encodeURIComponent(marketplaceId)}`,
    );
  }

  /** Update marketplace token. */
  async updateToken(marketplaceId: string, data: { github_token: string | null }): Promise<PluginMarketplace> {
    return this._client._request<PluginMarketplace>(
      "PATCH",
      `/api/plugin-marketplaces/${encodeURIComponent(marketplaceId)}`,
      { body: data },
    );
  }

  /** List plugins in a marketplace. */
  async listPlugins(marketplaceId: string): Promise<PluginListItem[]> {
    const resp = await this._client._request<{ data: PluginListItem[] }>(
      "GET",
      `/api/plugin-marketplaces/${encodeURIComponent(marketplaceId)}/plugins`,
    );
    return resp.data;
  }

  /** Get plugin detail (metadata, agents, skills). */
  async getPlugin(marketplaceId: string, pluginName: string): Promise<PluginDetail> {
    return this._client._request<PluginDetail>(
      "GET",
      `/api/plugin-marketplaces/${encodeURIComponent(marketplaceId)}/plugins/${pluginName}`,
    );
  }
}
