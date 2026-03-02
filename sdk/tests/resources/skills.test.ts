import { describe, it, expect, vi } from "vitest";
import { AgentPlane } from "../../src/index";

function createClient(mockFetch: ReturnType<typeof vi.fn>) {
  return new AgentPlane({
    apiKey: "ap_live_test1234567890abcdef12345678",
    baseUrl: "http://localhost:3000",
    fetch: mockFetch as unknown as typeof fetch,
  });
}

function jsonOk(data: unknown, status = 200) {
  return { ok: true, status, json: () => Promise.resolve(data) };
}

describe("SkillsResource", () => {
  it("list returns skills array", async () => {
    const skills = [{ folder: "my-skill", files: [{ path: "index.ts", content: "code" }] }];
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ data: skills }));
    const client = createClient(mockFetch);

    const result = await client.agents.skills.list("agent_1");

    expect(result).toEqual(skills);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/agents/agent_1/skills");
  });

  it("get returns a single skill", async () => {
    const skill = { folder: "my-skill", files: [{ path: "index.ts", content: "code" }] };
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk(skill));
    const client = createClient(mockFetch);

    const result = await client.agents.skills.get("agent_1", "my-skill");

    expect(result).toEqual(skill);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/agents/agent_1/skills/my-skill");
  });

  it("get encodes folder name in URL", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ folder: "a b", files: [] }));
    const client = createClient(mockFetch);

    await client.agents.skills.get("agent_1", "a b");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/agents/agent_1/skills/a%20b");
  });

  it("create sends POST with skill body", async () => {
    const skill = { folder: "new-skill", files: [{ path: "main.ts", content: "hello" }] };
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk(skill));
    const client = createClient(mockFetch);

    const result = await client.agents.skills.create("agent_1", skill);

    expect(result).toEqual(skill);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/agents/agent_1/skills");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(skill);
  });

  it("update sends PUT with files", async () => {
    const updated = { folder: "my-skill", files: [{ path: "index.ts", content: "updated" }] };
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk(updated));
    const client = createClient(mockFetch);

    const result = await client.agents.skills.update("agent_1", "my-skill", {
      files: [{ path: "index.ts", content: "updated" }],
    });

    expect(result).toEqual(updated);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/agents/agent_1/skills/my-skill");
    expect(init.method).toBe("PUT");
  });

  it("delete sends DELETE request", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ deleted: true }));
    const client = createClient(mockFetch);

    await client.agents.skills.delete("agent_1", "my-skill");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/agents/agent_1/skills/my-skill");
    expect(init.method).toBe("DELETE");
  });

  it("throws AgentPlaneError on non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 409,
      headers: new Headers({ "content-length": "100" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ error: { code: "conflict", message: "Folder already exists" } }),
            ),
          );
          controller.close();
        },
      }),
    });
    const client = createClient(mockFetch);

    await expect(client.agents.skills.create("agent_1", { folder: "dup", files: [{ path: "x", content: "y" }] }))
      .rejects.toThrow("Folder already exists");
  });
});
