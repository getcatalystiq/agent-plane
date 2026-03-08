/**
 * Plugin orchestration — caching, DB queries, plugin discovery.
 *
 * This module handles the plugin lifecycle:
 * - listPlugins()         — discover plugins in a marketplace (admin UI)
 * - fetchPluginContent()  — fetch skill/command files for agent runtime
 *
 * Mirrors mcp-connections.ts pattern (orchestration layer).
 * Pure HTTP calls are delegated to github.ts.
 */

import { fetchRepoTree, fetchRawContent } from "./github";
import type { GitHubTreeEntry, GitHubResult } from "./github";
import { PluginManifestSchema, PluginMcpJsonSchema, SafePluginFilename, PluginMarketplaceRow } from "./validation";
import { query } from "@/db";
import { decrypt } from "./crypto";
import { getEnv } from "./env";
import { logger } from "./logger";
import { z } from "zod";

// --- Types ---

export interface PluginListItem {
  name: string;          // directory name in the repo (used as identifier for fetching)
  displayName: string;   // human-readable name from plugin.json manifest
  description: string | null;
  version: string | null;
  author: string | null;
  hasSkills: boolean;
  hasCommands: boolean;
  hasMcpJson: boolean;
}

export interface PluginFileSet {
  skillFiles: Array<{ path: string; content: string }>;
  commandFiles: Array<{ path: string; content: string }>;
  warnings: string[];
}

export interface PluginMcpSuggestion {
  connector_name: string;
  composio_slug: string;
  suggested_by_plugin: string;
}

// --- Cache (process-level Map with TTL, same pattern as serverCache in mcp-connections.ts) ---

interface TreeCacheEntry {
  tree: GitHubTreeEntry[];
  cachedAt: number;
}

const treeCache = new Map<string, TreeCacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedTree(key: string): GitHubTreeEntry[] | null {
  const entry = treeCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    treeCache.delete(key);
    return null;
  }
  return entry.tree;
}

function setCachedTree(key: string, tree: GitHubTreeEntry[]): void {
  treeCache.set(key, { tree, cachedAt: Date.now() });
}

/** Clear cache entries for a specific marketplace repo. */
export function clearPluginCache(githubRepo?: string): void {
  if (githubRepo) {
    treeCache.delete(githubRepo);
  } else {
    treeCache.clear();
  }
}

// --- Recent-push content cache (survives GitHub CDN staleness) ---

interface ContentCacheEntry {
  files: Map<string, string>; // path → content
  cachedAt: number;
}

const contentCache = new Map<string, ContentCacheEntry>();
const CONTENT_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes (enough for CDN to catch up)

/** Cache file contents after a successful push so page reloads don't hit stale CDN. */
export function cacheRecentPush(githubRepo: string, files: Array<{ path: string; content: string }>): void {
  const fileMap = new Map<string, string>();
  for (const f of files) fileMap.set(f.path, f.content);
  contentCache.set(githubRepo, { files: fileMap, cachedAt: Date.now() });
}

/** Get recently-pushed content for a file, or null if not cached / expired. */
export function getCachedContent(githubRepo: string, filePath: string): string | null {
  const entry = contentCache.get(githubRepo);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CONTENT_CACHE_TTL_MS) {
    contentCache.delete(githubRepo);
    return null;
  }
  return entry.files.get(filePath) ?? null;
}

// --- Helpers ---

function parseGithubRepo(githubRepo: string): { owner: string; repo: string } {
  const [owner, repo] = githubRepo.split("/");
  return { owner, repo };
}

/** Decrypt a marketplace's stored token. */
async function getMarketplaceToken(marketplace: z.infer<typeof PluginMarketplaceRow>): Promise<string | undefined> {
  if (marketplace.github_token_enc) {
    try {
      const env = getEnv();
      return await decrypt(JSON.parse(marketplace.github_token_enc), env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_PREVIOUS);
    } catch { /* decryption failed */ }
  }
  return undefined;
}

async function getTree(githubRepo: string, token?: string): Promise<GitHubResult<GitHubTreeEntry[]>> {
  const cached = getCachedTree(githubRepo);
  if (cached) return { ok: true, data: cached };

  const { owner, repo } = parseGithubRepo(githubRepo);
  const result = await fetchRepoTree(owner, repo, token);
  if (result.ok) {
    setCachedTree(githubRepo, result.data);
  }
  return result;
}

// --- Public API ---

/**
 * List available plugins in a marketplace repo.
 * Identifies top-level directories with .claude-plugin/plugin.json.
 */
export async function listPlugins(githubRepo: string, marketplaceToken?: string): Promise<GitHubResult<PluginListItem[]>> {
  const treeResult = await getTree(githubRepo, marketplaceToken);
  if (!treeResult.ok) return treeResult;

  const tree = treeResult.data;

  // Find directories that have .claude-plugin/plugin.json (at any nesting depth)
  const pluginDirs = new Set<string>();
  for (const entry of tree) {
    const match = entry.path.match(/^(.+)\/.claude-plugin\/plugin\.json$/);
    if (match && entry.type === "blob") {
      pluginDirs.add(match[1]);
    }
  }

  const { owner, repo } = parseGithubRepo(githubRepo);
  const token = marketplaceToken;
  const plugins: PluginListItem[] = [];

  for (const dir of pluginDirs) {
    // Fetch plugin.json content
    const manifestResult = await fetchRawContent(owner, repo, `${dir}/.claude-plugin/plugin.json`, token);
    if (!manifestResult.ok) continue;

    let manifest: z.infer<typeof PluginManifestSchema>;
    try {
      manifest = PluginManifestSchema.parse(JSON.parse(manifestResult.data));
    } catch {
      continue; // Skip plugins with invalid manifests
    }

    const hasSkills = tree.some(e => e.path.startsWith(`${dir}/skills/`) && e.type === "blob");
    const hasCommands = tree.some(e => e.path.startsWith(`${dir}/commands/`) && e.type === "blob" && e.path.endsWith(".md"));
    const hasMcpJson = tree.some(e => e.path === `${dir}/.mcp.json` && e.type === "blob");

    plugins.push({
      name: dir,
      displayName: manifest.name,
      description: manifest.description ?? null,
      version: manifest.version ?? null,
      author: manifest.author?.name ?? null,
      hasSkills,
      hasCommands,
      hasMcpJson,
    });
  }

  return { ok: true, data: plugins.sort((a, b) => a.name.localeCompare(b.name)) };
}

const MAX_FILES_PER_PLUGIN = 20;

/**
 * Fetch plugin skill and command files for runtime injection.
 * Groups plugins by marketplace, fetches one tree per marketplace.
 * Returns pre-resolved files ready for sandbox.writeFiles().
 */
export async function fetchPluginContent(
  plugins: Array<{ marketplace_id: string; plugin_name: string }>,
): Promise<PluginFileSet> {
  const result: PluginFileSet = { skillFiles: [], commandFiles: [], warnings: [] };
  if (plugins.length === 0) return result;

  // Resolve marketplace_id -> github_repo
  const marketplaceIds = [...new Set(plugins.map(p => p.marketplace_id))];
  const marketplaces = await query(
    PluginMarketplaceRow,
    "SELECT * FROM plugin_marketplaces WHERE id = ANY($1)",
    [marketplaceIds],
  );
  const marketplaceMap = new Map(marketplaces.map(m => [m.id, m]));

  // Group plugins by marketplace for efficient tree fetching
  const byMarketplace = new Map<string, Array<{ plugin_name: string }>>();
  for (const plugin of plugins) {
    const marketplace = marketplaceMap.get(plugin.marketplace_id);
    if (!marketplace) {
      result.warnings.push(`Unknown marketplace: ${plugin.marketplace_id}`);
      continue;
    }
    const existing = byMarketplace.get(marketplace.github_repo) ?? [];
    existing.push({ plugin_name: plugin.plugin_name });
    byMarketplace.set(marketplace.github_repo, existing);
  }

  // Process each marketplace
  for (const [githubRepo, marketplacePlugins] of byMarketplace) {
    // Find the marketplace row to get its token
    const marketplace = marketplaces.find(m => m.github_repo === githubRepo);
    const token = marketplace ? await getMarketplaceToken(marketplace) : undefined;

    const treeResult = await getTree(githubRepo, token);
    if (!treeResult.ok) {
      result.warnings.push(`Failed to fetch ${githubRepo}: ${treeResult.message}`);
      continue;
    }

    const tree = treeResult.data;
    const { owner, repo } = parseGithubRepo(githubRepo);

    // Fetch files for each plugin in this marketplace
    for (const plugin of marketplacePlugins) {
      const pluginName = plugin.plugin_name;

      // Find skill files: all files under pluginName/skills/
      const skillEntries = tree.filter(
        e => e.type === "blob"
          && e.path.startsWith(`${pluginName}/skills/`),
      );

      // Find command files: pluginName/commands/*.md
      const commandEntries = tree.filter(
        e => e.type === "blob"
          && e.path.startsWith(`${pluginName}/commands/`)
          && e.path.endsWith(".md"),
      );

      const totalFiles = skillEntries.length + commandEntries.length;
      if (totalFiles > MAX_FILES_PER_PLUGIN) {
        result.warnings.push(`Plugin ${pluginName}: exceeds ${MAX_FILES_PER_PLUGIN} file limit (${totalFiles} files), skipping`);
        continue;
      }

      // Check total size from tree before fetching
      const totalSize = [...skillEntries, ...commandEntries].reduce((sum, e) => sum + (e.size ?? 0), 0);
      if (totalSize > 5 * 1024 * 1024) {
        result.warnings.push(`Plugin ${pluginName}: exceeds 5MB total size limit, skipping`);
        continue;
      }

      // Fetch skill files in parallel
      const skillFetches = skillEntries.map(async (entry) => {
        const filename = entry.path.split("/").pop() ?? "";
        const validation = SafePluginFilename.safeParse(filename);
        if (!validation.success) {
          result.warnings.push(`Plugin ${pluginName}: unsafe filename ${filename}, skipping`);
          return null;
        }

        const contentResult = await fetchRawContent(owner, repo, entry.path, token);
        if (!contentResult.ok) {
          result.warnings.push(`Plugin ${pluginName}: failed to fetch ${entry.path}: ${contentResult.message}`);
          return null;
        }

        // Preserve subdirectory structure for skill discovery (Claude Code expects <folder>/SKILL.md)
        // Flatten plugin name slashes to dashes so the folder stays one level deep under .claude/skills/
        const relativePath = entry.path.replace(`${pluginName}/skills/`, "");
        const parts = relativePath.split("/");
        const fileName = parts.pop()!;
        const safeName = pluginName.replace(/\//g, "-");
        const folderName = [safeName, ...parts].join("-");

        return {
          path: `.claude/skills/${folderName}/${fileName}`,
          content: contentResult.data,
        };
      });

      // Fetch command files in parallel
      const commandFetches = commandEntries.map(async (entry) => {
        const filename = entry.path.split("/").pop() ?? "";
        const validation = SafePluginFilename.safeParse(filename);
        if (!validation.success) {
          result.warnings.push(`Plugin ${pluginName}: unsafe filename ${filename}, skipping`);
          return null;
        }

        const contentResult = await fetchRawContent(owner, repo, entry.path, token);
        if (!contentResult.ok) {
          result.warnings.push(`Plugin ${pluginName}: failed to fetch ${entry.path}: ${contentResult.message}`);
          return null;
        }

        return {
          path: `.claude/commands/${pluginName.replace(/\//g, "-")}-${filename}`,
          content: contentResult.data,
        };
      });

      const [skillResults, commandResults] = await Promise.all([
        Promise.all(skillFetches),
        Promise.all(commandFetches),
      ]);

      for (const s of skillResults) {
        if (s) result.skillFiles.push(s);
      }
      for (const c of commandResults) {
        if (c) result.commandFiles.push(c);
      }
    }
  }

  if (result.warnings.length > 0) {
    logger.warn("Plugin fetch warnings", { warnings: result.warnings });
  }

  return result;
}

/**
 * Fetch .mcp.json connector suggestions from enabled plugins.
 */
export async function fetchPluginMcpSuggestions(
  plugins: Array<{ marketplace_id: string; plugin_name: string }>,
): Promise<{ suggestions: PluginMcpSuggestion[]; warnings: string[] }> {
  const suggestions: PluginMcpSuggestion[] = [];
  const warnings: string[] = [];
  if (plugins.length === 0) return { suggestions, warnings };

  // Resolve marketplace_id -> github_repo
  const marketplaceIds = [...new Set(plugins.map(p => p.marketplace_id))];
  const marketplaces = await query(
    PluginMarketplaceRow,
    "SELECT * FROM plugin_marketplaces WHERE id = ANY($1)",
    [marketplaceIds],
  );
  const marketplaceMap = new Map(marketplaces.map(m => [m.id, m]));

  for (const plugin of plugins) {
    const marketplace = marketplaceMap.get(plugin.marketplace_id);
    if (!marketplace) continue;

    const { owner, repo } = parseGithubRepo(marketplace.github_repo);
    const token = await getMarketplaceToken(marketplace);

    const contentResult = await fetchRawContent(
      owner,
      repo,
      `${plugin.plugin_name}/.mcp.json`,
      token,
    );
    if (!contentResult.ok) continue;

    let mcpJson: z.infer<typeof PluginMcpJsonSchema>;
    try {
      mcpJson = PluginMcpJsonSchema.parse(JSON.parse(contentResult.data));
    } catch {
      warnings.push(`Plugin ${plugin.plugin_name}: invalid .mcp.json`);
      continue;
    }

    if (mcpJson.mcpServers) {
      for (const key of Object.keys(mcpJson.mcpServers)) {
        suggestions.push({
          connector_name: key,
          composio_slug: toComposioSlug(key),
          suggested_by_plugin: plugin.plugin_name,
        });
      }
    }
  }

  return { suggestions, warnings };
}

// Explicit mapping for known connectors, fallback to uppercase
const MCP_TO_COMPOSIO_MAP: Record<string, string> = {
  slack: "SLACK",
  hubspot: "HUBSPOT",
  linear: "LINEAR",
  github: "GITHUB",
  notion: "NOTION",
  gmail: "GMAIL",
  google_calendar: "GOOGLECALENDAR",
  jira: "JIRA",
  confluence: "CONFLUENCE",
  asana: "ASANA",
  figma: "FIGMA",
  intercom: "INTERCOM",
  salesforce: "SALESFORCE",
  zendesk: "ZENDESK",
};

function toComposioSlug(key: string): string {
  return MCP_TO_COMPOSIO_MAP[key.toLowerCase()] ?? key.toUpperCase();
}
