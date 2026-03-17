import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all external dependencies before importing
vi.mock("@/db", () => ({
  query: vi.fn(),
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn().mockResolvedValue("mock-token"),
}));

vi.mock("@/lib/env", () => ({
  getEnv: vi.fn().mockReturnValue({ ENCRYPTION_KEY: "a".repeat(64) }),
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const mockFetchRepoTree = vi.fn();
const mockFetchRawContent = vi.fn();

vi.mock("@/lib/github", () => ({
  fetchRepoTree: (...args: unknown[]) => mockFetchRepoTree(...args),
  fetchRawContent: (...args: unknown[]) => mockFetchRawContent(...args),
}));

vi.mock("@/lib/validation", async () => {
  const actual = await vi.importActual("@/lib/validation");
  return actual;
});

import { listPlugins, fetchPluginContent, clearPluginCache } from "@/lib/plugins";
import { query } from "@/db";

describe("listPlugins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPluginCache(); // Clear tree cache between tests
  });

  it("detects hasAgents for plugins with agents/ directory", async () => {
    mockFetchRepoTree.mockResolvedValue({
      ok: true,
      data: [
        { path: "my-plugin/.claude-plugin/plugin.json", type: "blob", sha: "a", size: 100, url: "", mode: "100644" },
        { path: "my-plugin/agents/reviewer.md", type: "blob", sha: "b", size: 500, url: "", mode: "100644" },
        { path: "my-plugin/skills/lint/SKILL.md", type: "blob", sha: "c", size: 300, url: "", mode: "100644" },
      ],
    });
    mockFetchRawContent.mockResolvedValue({
      ok: true,
      data: JSON.stringify({ name: "My Plugin", version: "1.0.0" }),
    });

    const result = await listPlugins("org/repo");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toHaveLength(1);
    expect(result.data[0].hasAgents).toBe(true);
    expect(result.data[0].hasSkills).toBe(true);
  });

  it("does not detect hasAgents for plugins without agents/ directory", async () => {
    mockFetchRepoTree.mockResolvedValue({
      ok: true,
      data: [
        { path: "my-plugin/.claude-plugin/plugin.json", type: "blob", sha: "a", size: 100, url: "", mode: "100644" },
        { path: "my-plugin/skills/lint/SKILL.md", type: "blob", sha: "c", size: 300, url: "", mode: "100644" },
      ],
    });
    mockFetchRawContent.mockResolvedValue({
      ok: true,
      data: JSON.stringify({ name: "My Plugin" }),
    });

    const result = await listPlugins("org/repo2");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data[0].hasAgents).toBe(false);
    expect(result.data[0].hasSkills).toBe(true);
  });

  it("ignores commands/ directory (no hasCommands property)", async () => {
    mockFetchRepoTree.mockResolvedValue({
      ok: true,
      data: [
        { path: "my-plugin/.claude-plugin/plugin.json", type: "blob", sha: "a", size: 100, url: "", mode: "100644" },
        { path: "my-plugin/commands/check.md", type: "blob", sha: "b", size: 200, url: "", mode: "100644" },
      ],
    });
    mockFetchRawContent.mockResolvedValue({
      ok: true,
      data: JSON.stringify({ name: "My Plugin" }),
    });

    const result = await listPlugins("org/repo3");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data[0]).not.toHaveProperty("hasCommands");
    expect(result.data[0].hasAgents).toBe(false);
  });
});

describe("fetchPluginContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPluginCache();
  });

  const mockMarketplace = {
    id: "mp-1",
    name: "Test",
    github_repo: "org/repo",
    github_token_enc: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  it("discovers agent files and maps them to .claude/agents/ path", async () => {
    (query as ReturnType<typeof vi.fn>).mockResolvedValue([mockMarketplace]);
    mockFetchRepoTree.mockResolvedValue({
      ok: true,
      data: [
        { path: "my-plugin/agents/reviewer.md", type: "blob", sha: "a", size: 500, url: "", mode: "100644" },
      ],
    });
    mockFetchRawContent.mockResolvedValue({
      ok: true,
      data: "---\nname: reviewer\ndescription: Reviews code\n---\nYou are a reviewer.",
    });

    const result = await fetchPluginContent([
      { marketplace_id: "mp-1", plugin_name: "my-plugin" },
    ]);

    expect(result.agentFiles).toHaveLength(1);
    expect(result.agentFiles[0].path).toBe(".claude/agents/my-plugin-reviewer.md");
    expect(result.agentFiles[0].content).toContain("name: reviewer");
    expect(result.skillFiles).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("discovers skill files alongside agent files", async () => {
    (query as ReturnType<typeof vi.fn>).mockResolvedValue([mockMarketplace]);
    mockFetchRepoTree.mockResolvedValue({
      ok: true,
      data: [
        { path: "my-plugin/agents/reviewer.md", type: "blob", sha: "a", size: 500, url: "", mode: "100644" },
        { path: "my-plugin/skills/lint/SKILL.md", type: "blob", sha: "b", size: 300, url: "", mode: "100644" },
      ],
    });
    mockFetchRawContent.mockResolvedValue({ ok: true, data: "content" });

    const result = await fetchPluginContent([
      { marketplace_id: "mp-1", plugin_name: "my-plugin" },
    ]);

    expect(result.agentFiles).toHaveLength(1);
    expect(result.skillFiles).toHaveLength(1);
    expect(result.skillFiles[0].path).toBe(".claude/skills/my-plugin-lint/SKILL.md");
  });

  it("ignores commands/ directory entirely", async () => {
    (query as ReturnType<typeof vi.fn>).mockResolvedValue([mockMarketplace]);
    mockFetchRepoTree.mockResolvedValue({
      ok: true,
      data: [
        { path: "my-plugin/commands/check.md", type: "blob", sha: "a", size: 200, url: "", mode: "100644" },
        { path: "my-plugin/skills/lint/SKILL.md", type: "blob", sha: "b", size: 300, url: "", mode: "100644" },
      ],
    });
    mockFetchRawContent.mockResolvedValue({ ok: true, data: "content" });

    const result = await fetchPluginContent([
      { marketplace_id: "mp-1", plugin_name: "my-plugin" },
    ]);

    // Only skill files, commands ignored
    expect(result.skillFiles).toHaveLength(1);
    expect(result.agentFiles).toHaveLength(0);
    expect(result).not.toHaveProperty("commandFiles");
  });

  it("enforces MAX_FILES_PER_PLUGIN including agent files", async () => {
    (query as ReturnType<typeof vi.fn>).mockResolvedValue([mockMarketplace]);

    // Create 21 files (exceeds default limit of 20)
    const entries = Array.from({ length: 15 }, (_, i) => ({
      path: `my-plugin/skills/s${i}/SKILL.md`, type: "blob" as const, sha: `s${i}`, size: 100, url: "", mode: "100644",
    })).concat(Array.from({ length: 6 }, (_, i) => ({
      path: `my-plugin/agents/agent${i}.md`, type: "blob" as const, sha: `a${i}`, size: 100, url: "", mode: "100644",
    })));

    mockFetchRepoTree.mockResolvedValue({ ok: true, data: entries });

    const result = await fetchPluginContent([
      { marketplace_id: "mp-1", plugin_name: "my-plugin" },
    ]);

    expect(result.skillFiles).toHaveLength(0);
    expect(result.agentFiles).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("exceeds");
  });

  it("handles nested plugin names with slashes", async () => {
    (query as ReturnType<typeof vi.fn>).mockResolvedValue([mockMarketplace]);
    mockFetchRepoTree.mockResolvedValue({
      ok: true,
      data: [
        { path: "org/my-plugin/agents/reviewer.md", type: "blob", sha: "a", size: 500, url: "", mode: "100644" },
      ],
    });
    mockFetchRawContent.mockResolvedValue({ ok: true, data: "agent content" });

    const result = await fetchPluginContent([
      { marketplace_id: "mp-1", plugin_name: "org/my-plugin" },
    ]);

    expect(result.agentFiles).toHaveLength(1);
    // Slashes in plugin name are replaced with dashes
    expect(result.agentFiles[0].path).toBe(".claude/agents/org-my-plugin-reviewer.md");
  });

  it("returns empty result for empty plugins array", async () => {
    const result = await fetchPluginContent([]);
    expect(result.skillFiles).toHaveLength(0);
    expect(result.agentFiles).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});
