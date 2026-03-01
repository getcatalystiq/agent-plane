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
    expect(result.max_turns).toBe(10);
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

// --- New test blocks ---

const makeSkill = (folder: string, path: string, content = "x") => ({
  folder,
  files: [{ path, content }],
});

describe("SafeRelativePath security", () => {
  it("rejects path containing '..'", () => {
    expect(() =>
      CreateAgentSchema.parse({
        name: "test",
        skills: [makeSkill("folder", "../etc/passwd")],
      }),
    ).toThrow();
  });

  it("rejects absolute path starting with '/'", () => {
    expect(() =>
      CreateAgentSchema.parse({
        name: "test",
        skills: [makeSkill("folder", "/absolute/path")],
      }),
    ).toThrow();
  });

  it("rejects path with null bytes", () => {
    expect(() =>
      CreateAgentSchema.parse({
        name: "test",
        skills: [makeSkill("folder", "path\0with\0null")],
      }),
    ).toThrow();
  });

  it("accepts valid relative path", () => {
    const result = CreateAgentSchema.parse({
      name: "test",
      skills: [makeSkill("folder", "foo/bar/baz.js")],
    });
    expect(result.skills[0].files[0].path).toBe("foo/bar/baz.js");
  });

  it("rejects empty string path", () => {
    expect(() =>
      CreateAgentSchema.parse({
        name: "test",
        skills: [makeSkill("folder", "")],
      }),
    ).toThrow();
  });
});

describe("SafeFolderName", () => {
  it("accepts valid folder name with alphanumeric, underscores, hyphens", () => {
    const result = CreateAgentSchema.parse({
      name: "test",
      skills: [makeSkill("valid-folder_name", "file.js")],
    });
    expect(result.skills[0].folder).toBe("valid-folder_name");
  });

  it("rejects folder name with spaces", () => {
    expect(() =>
      CreateAgentSchema.parse({
        name: "test",
        skills: [makeSkill("has space", "file.js")],
      }),
    ).toThrow();
  });

  it("rejects folder name with path traversal", () => {
    expect(() =>
      CreateAgentSchema.parse({
        name: "test",
        skills: [makeSkill("../escape", "file.js")],
      }),
    ).toThrow();
  });

  it("rejects empty folder name", () => {
    expect(() =>
      CreateAgentSchema.parse({
        name: "test",
        skills: [makeSkill("", "file.js")],
      }),
    ).toThrow();
  });
});

describe("SkillsSchema boundary", () => {
  it("accepts 50 skills", () => {
    const skills = Array.from({ length: 50 }, (_, i) =>
      makeSkill(`folder${i}`, "file.js"),
    );
    const result = CreateAgentSchema.parse({ name: "test", skills });
    expect(result.skills).toHaveLength(50);
  });

  it("rejects 51 skills", () => {
    const skills = Array.from({ length: 51 }, (_, i) =>
      makeSkill(`folder${i}`, "file.js"),
    );
    expect(() =>
      CreateAgentSchema.parse({ name: "test", skills }),
    ).toThrow(/Maximum 50 skills/);
  });

  it("accepts skills with total content exactly 5MB", () => {
    const totalSize = 5 * 1024 * 1024;
    const perFile = 100_000;
    const fullFiles = Math.floor(totalSize / perFile);
    const remainder = totalSize % perFile;
    const files = Array.from({ length: fullFiles }, (_, i) => ({
      path: `file${i}.js`,
      content: "a".repeat(perFile),
    }));
    if (remainder > 0) {
      files.push({ path: `file${fullFiles}.js`, content: "a".repeat(remainder) });
    }
    const result = CreateAgentSchema.parse({
      name: "test",
      skills: [{ folder: "folder", files }],
    });
    const actualTotal = result.skills[0].files.reduce((s, f) => s + f.content.length, 0);
    expect(actualTotal).toBe(totalSize);
  });

  it("rejects skills with total content 5MB + 1 byte", () => {
    const totalSize = 5 * 1024 * 1024 + 1;
    const perFile = 100_000;
    const fullFiles = Math.floor(totalSize / perFile);
    const remainder = totalSize % perFile;
    const files = Array.from({ length: fullFiles }, (_, i) => ({
      path: `file${i}.js`,
      content: "a".repeat(perFile),
    }));
    if (remainder > 0) {
      files.push({ path: `file${fullFiles}.js`, content: "a".repeat(remainder) });
    }
    expect(() =>
      CreateAgentSchema.parse({
        name: "test",
        skills: [{ folder: "folder", files }],
      }),
    ).toThrow(/under 5MB/);
  });

  it("rejects skill with path traversal in path", () => {
    expect(() =>
      CreateAgentSchema.parse({
        name: "test",
        skills: [makeSkill("folder", "../escape")],
      }),
    ).toThrow();
  });

  it("rejects skill with empty files array", () => {
    expect(() =>
      CreateAgentSchema.parse({
        name: "test",
        skills: [{ folder: "folder", files: [] }],
      }),
    ).toThrow();
  });
});
