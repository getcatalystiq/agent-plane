import { describe, it, expect, vi } from "vitest";
import { createClient, jsonOk, jsonError } from "../helpers";

describe("PluginsResource", () => {
  it("list returns plugins array", async () => {
    const plugins = [{ marketplace_id: "mp_1", plugin_name: "my-plugin" }];
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ data: plugins }));
    const client = createClient(mockFetch);

    const result = await client.agents.plugins.list("agent_1");

    expect(result).toEqual(plugins);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/agents/agent_1/plugins");
  });

  it("add sends POST with plugin body", async () => {
    const plugin = { marketplace_id: "mp_1", plugin_name: "my-plugin" };
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk(plugin));
    const client = createClient(mockFetch);

    const result = await client.agents.plugins.add("agent_1", plugin);

    expect(result).toEqual(plugin);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/agents/agent_1/plugins");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(plugin);
  });

  it("remove sends DELETE with encoded path segments", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ deleted: true }));
    const client = createClient(mockFetch);

    await client.agents.plugins.remove("agent_1", "mp_1", "my-plugin");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/agents/agent_1/plugins/mp_1/my-plugin");
    expect(init.method).toBe("DELETE");
  });

  it("throws AgentPlaneError on conflict", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonError(409, { code: "conflict", message: "Plugin already added" }),
    );
    const client = createClient(mockFetch);

    await expect(client.agents.plugins.add("agent_1", { marketplace_id: "mp_1", plugin_name: "dup" }))
      .rejects.toThrow("Plugin already added");
  });
});
