import { describe, it, expect, vi } from "vitest";
import { createClient, jsonOk, jsonError } from "../helpers";

describe("PluginMarketplacesResource", () => {
  it("list returns marketplace array", async () => {
    const marketplaces = [
      { id: "mp_1", name: "Official Plugins", github_repo: "org/plugins", created_at: "2026-01-01", updated_at: "2026-01-01" },
    ];
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ data: marketplaces }));
    const client = createClient(mockFetch);

    const result = await client.pluginMarketplaces.list();

    expect(result).toEqual(marketplaces);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/plugin-marketplaces");
  });

  it("listPlugins returns plugin array with camelCase fields", async () => {
    const plugins = [
      {
        name: "my-plugin",
        displayName: "My Plugin",
        description: "A test plugin",
        version: "1.0.0",
        author: "Test Author",
        hasSkills: true,
        hasCommands: false,
        hasMcpJson: false,
      },
    ];
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ data: plugins }));
    const client = createClient(mockFetch);

    const result = await client.pluginMarketplaces.listPlugins("mp_1");

    expect(result).toEqual(plugins);
    expect(result[0].displayName).toBe("My Plugin");
    expect(result[0].hasSkills).toBe(true);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/plugin-marketplaces/mp_1/plugins");
  });

  it("listPlugins encodes marketplaceId in URL", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ data: [] }));
    const client = createClient(mockFetch);

    await client.pluginMarketplaces.listPlugins("mp 1");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/plugin-marketplaces/mp%201/plugins");
  });

  it("throws AgentPlaneError on server error", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonError(500, { code: "internal_error", message: "Internal server error" }),
    );
    const client = createClient(mockFetch);

    await expect(client.pluginMarketplaces.list())
      .rejects.toThrow("Internal server error");
  });
});
