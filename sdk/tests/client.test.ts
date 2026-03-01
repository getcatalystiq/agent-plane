import { describe, it, expect, vi } from "vitest";
import { AgentPlane, AgentPlaneError } from "../src/index";

describe("AgentPlane", () => {
  it("throws if no API key provided", () => {
    delete process.env["AGENTPLANE_API_KEY"];

    expect(() => new AgentPlane({ baseUrl: "https://test.example.com" })).toThrow("API key is required");
  });

  it("throws if no base URL provided", () => {
    delete process.env["AGENTPLANE_BASE_URL"];

    expect(() => new AgentPlane({ apiKey: "ap_live_test1234567890abcdef12345678" })).toThrow("Base URL is required");
  });

  it("reads config from environment variables", () => {
    process.env["AGENTPLANE_API_KEY"] = "ap_live_test1234567890abcdef12345678";
    process.env["AGENTPLANE_BASE_URL"] = "https://test.example.com";
    try {
      const client = new AgentPlane();
      expect(client).toBeDefined();
      expect(client.runs).toBeDefined();
      expect(client.agents).toBeDefined();
    } finally {
      delete process.env["AGENTPLANE_API_KEY"];
      delete process.env["AGENTPLANE_BASE_URL"];
    }
  });

  it("accepts config in options", () => {
    const client = new AgentPlane({
      apiKey: "ap_live_test1234567890abcdef12345678",
      baseUrl: "https://test.example.com",
    });
    expect(client).toBeDefined();
  });

  it("rejects non-HTTPS base URL", () => {
    expect(
      () =>
        new AgentPlane({
          apiKey: "ap_live_test1234567890abcdef12345678",
          baseUrl: "http://example.com",
        }),
    ).toThrow("Base URL must use HTTPS");
  });

  it("allows localhost over HTTP", () => {
    const client = new AgentPlane({
      apiKey: "ap_live_test1234567890abcdef12345678",
      baseUrl: "http://localhost:3000",
    });
    expect(client).toBeDefined();
  });

  it("allows 127.0.0.1 over HTTP", () => {
    const client = new AgentPlane({
      apiKey: "ap_live_test1234567890abcdef12345678",
      baseUrl: "http://127.0.0.1:3000",
    });
    expect(client).toBeDefined();
  });

  it("hides credentials in toJSON", () => {
    const client = new AgentPlane({
      apiKey: "ap_live_test1234567890abcdef12345678",
      baseUrl: "https://test.example.com",
    });
    const json = client.toJSON();
    expect(JSON.stringify(json)).not.toContain("ap_live_");
    expect(json.baseUrl).toBe("https://test.example.com");
  });

  it("hides credentials in inspect", () => {
    const client = new AgentPlane({
      apiKey: "ap_live_test1234567890abcdef12345678",
      baseUrl: "https://test.example.com",
    });
    const inspected = client[Symbol.for("nodejs.util.inspect.custom") as unknown as string]();
    expect(inspected).not.toContain("ap_live_");
  });

  describe("_request", () => {
    it("sends authorization header and parses JSON response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "agent_1", name: "test" }),
      });

      const client = new AgentPlane({
        apiKey: "ap_live_test1234567890abcdef12345678",
        baseUrl: "https://test.example.com",
        fetch: mockFetch as unknown as typeof fetch,
      });

      const result = await client._request<{ id: string }>("GET", "/api/agents");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe("https://test.example.com/api/agents");
      expect(init.headers.Authorization).toBe("Bearer ap_live_test1234567890abcdef12345678");
      expect(init.headers["User-Agent"]).toMatch(/^agentplane-sdk\//);
      expect(result).toEqual({ id: "agent_1", name: "test" });
    });

    it("throws AgentPlaneError on non-ok response", async () => {
      const makeErrorResponse = () => ({
        ok: false,
        status: 404,
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify({ error: { code: "not_found", message: "Agent not found" } })),
            );
            controller.close();
          },
        }),
      });
      const mockFetch = vi.fn().mockImplementation(() => Promise.resolve(makeErrorResponse()));

      const client = new AgentPlane({
        apiKey: "ap_live_test1234567890abcdef12345678",
        baseUrl: "https://test.example.com",
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(client._request("GET", "/api/agents/missing")).rejects.toThrow(AgentPlaneError);

      try {
        await client._request("GET", "/api/agents/missing");
      } catch (err) {
        expect(err).toBeInstanceOf(AgentPlaneError);
        const e = err as AgentPlaneError;
        expect(e.code).toBe("not_found");
        expect(e.status).toBe(404);
        expect(e.message).toBe("Agent not found");
      }
    });

    it("sends query parameters", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [], limit: 10, offset: 0 }),
      });

      const client = new AgentPlane({
        apiKey: "ap_live_test1234567890abcdef12345678",
        baseUrl: "https://test.example.com",
        fetch: mockFetch as unknown as typeof fetch,
      });

      await client._request("GET", "/api/runs", {
        query: { limit: 10, status: "completed", unused: undefined },
      });

      const [url] = mockFetch.mock.calls[0]!;
      const parsed = new URL(url as string);
      expect(parsed.searchParams.get("limit")).toBe("10");
      expect(parsed.searchParams.get("status")).toBe("completed");
      expect(parsed.searchParams.has("unused")).toBe(false);
    });

    it("sends JSON body", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "agent_1" }),
      });

      const client = new AgentPlane({
        apiKey: "ap_live_test1234567890abcdef12345678",
        baseUrl: "https://test.example.com",
        fetch: mockFetch as unknown as typeof fetch,
      });

      await client._request("POST", "/api/agents", {
        body: { name: "test-agent" },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(init.body).toBe('{"name":"test-agent"}');
    });
  });
});
