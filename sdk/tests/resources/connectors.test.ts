import { describe, it, expect, vi } from "vitest";
import { AgentPlane } from "../../src/index";

function createClient(mockFetch: ReturnType<typeof vi.fn>) {
  return new AgentPlane({
    apiKey: "ap_live_test1234567890abcdef12345678",
    baseUrl: "http://localhost:3000",
    fetch: mockFetch as unknown as typeof fetch,
  });
}

function jsonOk(data: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) };
}

describe("ConnectorsResource", () => {
  describe("agent-scoped methods", () => {
    it("list returns connector info array", async () => {
      const connectors = [
        { slug: "github", name: "GitHub", logo: "https://...", auth_scheme: "OAUTH2", connected: true },
      ];
      const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ data: connectors }));
      const client = createClient(mockFetch);

      const result = await client.agents.connectors.list("agent_1");

      expect(result).toEqual(connectors);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/agents/agent_1/connectors");
    });

    it("saveApiKey sends POST with toolkit and api_key", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ slug: "github", connected: true }));
      const client = createClient(mockFetch);

      const result = await client.agents.connectors.saveApiKey("agent_1", {
        toolkit: "github",
        api_key: "ghp_abc123",
      });

      expect(result).toEqual({ slug: "github", connected: true });
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/agents/agent_1/connectors");
      expect(init.method).toBe("POST");
    });

    it("initiateOauth returns redirect_url", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        jsonOk({ redirect_url: "https://oauth.provider.com/authorize?..." }),
      );
      const client = createClient(mockFetch);

      const result = await client.agents.connectors.initiateOauth("agent_1", "github");

      expect(result.redirect_url).toContain("https://oauth.provider.com");
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/agents/agent_1/connectors/github/initiate-oauth");
      expect(init.method).toBe("POST");
    });

    it("initiateOauth encodes toolkit name in URL", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ redirect_url: "https://..." }));
      const client = createClient(mockFetch);

      await client.agents.connectors.initiateOauth("agent_1", "google sheets");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/agents/agent_1/connectors/google%20sheets/initiate-oauth");
    });
  });

  describe("discovery methods", () => {
    it("availableToolkits returns toolkit array", async () => {
      const toolkits = [{ slug: "github", name: "GitHub", logo: "https://..." }];
      const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ data: toolkits }));
      const client = createClient(mockFetch);

      const result = await client.connectors.availableToolkits();

      expect(result).toEqual(toolkits);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/composio/toolkits");
    });

    it("availableTools returns tool array with query param", async () => {
      const tools = [{ slug: "GITHUB_CREATE_ISSUE", name: "Create Issue", description: "..." }];
      const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ data: tools }));
      const client = createClient(mockFetch);

      const result = await client.connectors.availableTools("github");

      expect(result).toEqual(tools);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/composio/tools");
      expect(url).toContain("toolkit=github");
    });
  });

  it("client.agents.connectors and client.connectors share the same instance", () => {
    const mockFetch = vi.fn();
    const client = createClient(mockFetch);

    expect(client.agents.connectors).toBe(client.connectors);
  });
});
