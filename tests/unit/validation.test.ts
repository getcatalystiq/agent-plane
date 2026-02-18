import { describe, it, expect } from "vitest";
import {
  CreateAgentSchema,
  UpdateAgentSchema,
  CreateApiKeySchema,
  CreateRunSchema,
  PaginationSchema,
} from "@/lib/validation";

describe("CreateAgentSchema", () => {
  it("accepts valid minimal input", () => {
    const result = CreateAgentSchema.parse({ name: "My Agent" });
    expect(result.name).toBe("My Agent");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.max_turns).toBe(100);
    expect(result.max_budget_usd).toBe(1.0);
    expect(result.permission_mode).toBe("bypassPermissions");
    expect(result.git_branch).toBe("main");
  });

  it("accepts full input", () => {
    const result = CreateAgentSchema.parse({
      name: "Full Agent",
      description: "A test agent",
      git_repo_url: "https://github.com/org/repo",
      git_branch: "develop",
      composio_toolkits: ["github", "slack"],
      model: "claude-opus-4-6",
      allowed_tools: ["Read", "Write"],
      permission_mode: "default",
      max_turns: 50,
      max_budget_usd: 5.0,
    });
    expect(result.name).toBe("Full Agent");
    expect(result.composio_toolkits).toEqual(["github", "slack"]);
  });

  it("rejects empty name", () => {
    expect(() => CreateAgentSchema.parse({ name: "" })).toThrow();
  });

  it("rejects invalid git URL", () => {
    expect(() =>
      CreateAgentSchema.parse({ name: "test", git_repo_url: "not-a-url" }),
    ).toThrow();
  });

  it("rejects max_turns out of range", () => {
    expect(() =>
      CreateAgentSchema.parse({ name: "test", max_turns: 0 }),
    ).toThrow();
    expect(() =>
      CreateAgentSchema.parse({ name: "test", max_turns: 1001 }),
    ).toThrow();
  });

  it("rejects invalid permission_mode", () => {
    expect(() =>
      CreateAgentSchema.parse({ name: "test", permission_mode: "invalid" }),
    ).toThrow();
  });
});

describe("UpdateAgentSchema", () => {
  it("accepts partial updates", () => {
    const result = UpdateAgentSchema.parse({ name: "Updated Name" });
    expect(result.name).toBe("Updated Name");
  });

  it("accepts empty object", () => {
    const result = UpdateAgentSchema.parse({});
    // partial() still applies defaults for fields that have them
    expect(result.name).toBeUndefined();
  });
});

describe("CreateApiKeySchema", () => {
  it("accepts minimal input", () => {
    const result = CreateApiKeySchema.parse({});
    expect(result.name).toBe("default");
    expect(result.scopes).toEqual([]);
  });

  it("accepts full input", () => {
    const result = CreateApiKeySchema.parse({
      name: "ci-key",
      scopes: ["runs:write"],
      expires_at: "2026-12-31T23:59:59Z",
    });
    expect(result.name).toBe("ci-key");
  });
});

describe("CreateRunSchema", () => {
  it("validates run creation input", () => {
    const result = CreateRunSchema.parse({
      agent_id: "550e8400-e29b-41d4-a716-446655440000",
      prompt: "Hello, world!",
    });
    expect(result.agent_id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(result.prompt).toBe("Hello, world!");
  });

  it("rejects invalid UUID", () => {
    expect(() =>
      CreateRunSchema.parse({ agent_id: "not-a-uuid", prompt: "test" }),
    ).toThrow();
  });

  it("rejects empty prompt", () => {
    expect(() =>
      CreateRunSchema.parse({
        agent_id: "550e8400-e29b-41d4-a716-446655440000",
        prompt: "",
      }),
    ).toThrow();
  });
});

describe("PaginationSchema", () => {
  it("uses defaults", () => {
    const result = PaginationSchema.parse({});
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
  });

  it("coerces string values", () => {
    const result = PaginationSchema.parse({ limit: "50", offset: "10" });
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(10);
  });

  it("clamps limit to 100", () => {
    expect(() => PaginationSchema.parse({ limit: 101 })).toThrow();
  });
});
