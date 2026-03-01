import { describe, it, expect } from "vitest";
import {
  CreateMcpServerSchema,
  UpdateMcpServerSchema,
  UpdateMcpConnectionSchema,
} from "@/lib/validation";

describe("CreateMcpServerSchema", () => {
  const valid = {
    name: "Test MCP Server",
    slug: "test-mcp-server",
    description: "A test server",
    base_url: "https://mcp.example.com",
  };

  it("accepts valid minimal input", () => {
    const result = CreateMcpServerSchema.parse(valid);
    expect(result.name).toBe("Test MCP Server");
    expect(result.slug).toBe("test-mcp-server");
    expect(result.mcp_endpoint_path).toBe("/mcp");
  });

  it("accepts full input with logo and custom endpoint", () => {
    const result = CreateMcpServerSchema.parse({
      ...valid,
      logo_url: "https://example.com/logo.png",
      mcp_endpoint_path: "/v1/mcp",
    });
    expect(result.logo_url).toBe("https://example.com/logo.png");
    expect(result.mcp_endpoint_path).toBe("/v1/mcp");
  });

  it("rejects empty name", () => {
    expect(() => CreateMcpServerSchema.parse({ ...valid, name: "" })).toThrow();
  });

  it("rejects empty slug", () => {
    expect(() => CreateMcpServerSchema.parse({ ...valid, slug: "" })).toThrow();
  });

  it("rejects slug with uppercase", () => {
    expect(() => CreateMcpServerSchema.parse({ ...valid, slug: "Test-Server" })).toThrow();
  });

  it("rejects slug with spaces", () => {
    expect(() => CreateMcpServerSchema.parse({ ...valid, slug: "test server" })).toThrow();
  });

  it("accepts slug with hyphens and numbers", () => {
    const result = CreateMcpServerSchema.parse({ ...valid, slug: "my-server-123" });
    expect(result.slug).toBe("my-server-123");
  });

  it("rejects reserved slug 'composio'", () => {
    expect(() => CreateMcpServerSchema.parse({ ...valid, slug: "composio" })).toThrow();
  });

  it("rejects invalid base_url", () => {
    expect(() => CreateMcpServerSchema.parse({ ...valid, base_url: "not-a-url" })).toThrow();
  });

  it("rejects base_url with http (non-https)", () => {
    expect(() => CreateMcpServerSchema.parse({ ...valid, base_url: "http://insecure.com" })).toThrow();
  });

  it("rejects mcp_endpoint_path not starting with /", () => {
    expect(() =>
      CreateMcpServerSchema.parse({ ...valid, mcp_endpoint_path: "mcp" }),
    ).toThrow();
  });
});

describe("UpdateMcpServerSchema", () => {
  it("accepts partial update with name only", () => {
    const result = UpdateMcpServerSchema.parse({ name: "Updated Name" });
    expect(result.name).toBe("Updated Name");
  });

  it("accepts empty object (no updates)", () => {
    const result = UpdateMcpServerSchema.parse({});
    expect(result.name).toBeUndefined();
  });

  it("rejects invalid logo_url", () => {
    expect(() => UpdateMcpServerSchema.parse({ logo_url: "not-a-url" })).toThrow();
  });
});

describe("UpdateMcpConnectionSchema", () => {
  it("accepts allowed_tools array", () => {
    const result = UpdateMcpConnectionSchema.parse({
      allowed_tools: ["tool_a", "tool_b"],
    });
    expect(result.allowed_tools).toEqual(["tool_a", "tool_b"]);
  });

  it("accepts empty allowed_tools (no filter)", () => {
    const result = UpdateMcpConnectionSchema.parse({
      allowed_tools: [],
    });
    expect(result.allowed_tools).toEqual([]);
  });

  it("rejects missing allowed_tools", () => {
    expect(() => UpdateMcpConnectionSchema.parse({})).toThrow();
  });
});
