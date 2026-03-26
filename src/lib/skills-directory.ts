/**
 * skills.sh directory integration.
 *
 * Fetches and parses the skills.sh leaderboard HTML to list available skills,
 * previews individual SKILL.md files via GitHub CDN, and imports full skill
 * content (all files) via the GitHub API.
 *
 * No public API exists for skills.sh — we parse server-rendered HTML.
 * Skill content lives in public GitHub repos.
 */

import { z } from "zod";
import { fetchRepoTree, fetchRawContent, type GitHubResult } from "./github";
import { logger } from "./logger";

// --- Types ---

export interface SkillEntry {
  name: string;
  owner: string;
  repo: string;
  skill: string;
  installs: string;
}

export interface ImportedSkill {
  folder: string;
  files: Array<{ path: string; content: string }>;
  warnings: string[];
}

export type SkillsTab = "all" | "trending" | "hot";

// --- Validation ---

const SkillEntrySchema = z.object({
  name: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  skill: z.string().min(1),
  installs: z.string(),
});

// --- Process-Level Cache (model-catalog.ts pattern) ---

const cachedEntries = new Map<SkillsTab, SkillEntry[]>();
const lastKnownGood = new Map<SkillsTab, SkillEntry[]>();
const cacheTimestamps = new Map<SkillsTab, number>();
const DIRECTORY_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Tree cache for GitHub repo trees (plugins.ts pattern)
const treeCache = new Map<string, { data: { path: string; type: string }[]; cachedAt: number }>();
const TREE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Preview cache for SKILL.md content
const previewCache = new Map<string, { data: string; cachedAt: number }>();
const PREVIEW_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const MAX_FILES_PER_SKILL = 20;

// --- URL Parsing ---

export function parseSkillsShUrl(url: string): { owner: string; repo: string; skill: string } | null {
  // Normalize: strip protocol, www, trailing slash
  let path = url
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");

  // Remove skills.sh prefix if present
  if (path.startsWith("skills.sh/")) {
    path = path.slice("skills.sh/".length);
  } else if (path.startsWith("skills.sh")) {
    return null; // Just "skills.sh" with no path
  }

  // Expect owner/repo/skill
  const parts = path.split("/");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return null;
  }

  return { owner: parts[0], repo: parts[1], skill: parts[2] };
}

// --- HTML Parsing ---

/**
 * Parse skill entries from skills.sh HTML.
 *
 * Each entry is an <a> tag linking to /{owner}/{repo}/{skill} containing:
 * - <h3> with skill name
 * - <p> with owner/repo
 * - <span> with install count
 */
export function parseSkillsHtml(html: string): SkillEntry[] {
  const entryRegex =
    /<a[^>]*href="\/([^"\/]+)\/([^"\/]+)\/([^"]+)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<p[^>]*class="[^"]*text-\(--ds-gray-600\)[^"]*"[^>]*>([\s\S]*?)<\/p>[\s\S]*?<span[^>]*class="font-mono text-sm text-foreground"[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/a>/g;

  const entries: SkillEntry[] = [];
  let match;
  while ((match = entryRegex.exec(html)) !== null) {
    const raw = {
      name: match[4].trim(),
      owner: match[1],
      repo: match[2],
      skill: match[3],
      installs: match[6].trim(),
    };

    const parsed = SkillEntrySchema.safeParse(raw);
    if (parsed.success) {
      entries.push(parsed.data);
    }
  }

  return entries;
}

// --- Directory Listing ---

const TAB_URLS: Record<SkillsTab, string> = {
  all: "https://skills.sh/",
  trending: "https://skills.sh/trending",
  hot: "https://skills.sh/hot",
};

export async function fetchSkillsDirectory(
  tab: SkillsTab = "all",
): Promise<{ ok: true; data: SkillEntry[] } | { ok: false; error: string }> {
  // Check fresh cache
  const cached = cachedEntries.get(tab);
  const ts = cacheTimestamps.get(tab) ?? 0;
  if (cached && Date.now() - ts < DIRECTORY_CACHE_TTL_MS) {
    return { ok: true, data: cached };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(TAB_URLS[tab], { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      logger.warn("skills.sh returned non-200", { status: res.status, tab });
      const stale = lastKnownGood.get(tab);
      if (stale) return { ok: true, data: stale };
      return { ok: false, error: `skills.sh returned ${res.status}` };
    }

    const html = await res.text();
    const entries = parseSkillsHtml(html);

    if (entries.length === 0) {
      logger.warn("skills.sh HTML parsed zero entries — possible structure change", { tab });
      const stale = lastKnownGood.get(tab);
      if (stale) return { ok: true, data: stale };
      return { ok: false, error: "Failed to parse skills directory — HTML structure may have changed" };
    }

    cachedEntries.set(tab, entries);
    lastKnownGood.set(tab, entries);
    cacheTimestamps.set(tab, Date.now());
    return { ok: true, data: entries };
  } catch (err) {
    logger.warn("Failed to fetch skills.sh", {
      error: err instanceof Error ? err.message : String(err),
      tab,
    });
    const stale = lastKnownGood.get(tab);
    if (stale) return { ok: true, data: stale };
    return { ok: false, error: `Failed to fetch skills.sh: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// --- Repo Tree Helpers ---

async function getRepoTree(owner: string, repo: string): Promise<GitHubResult<{ path: string; type: string }[]>> {
  const treeCacheKey = `${owner}/${repo}`;
  const cachedTree = treeCache.get(treeCacheKey);
  if (cachedTree && Date.now() - cachedTree.cachedAt < TREE_CACHE_TTL_MS) {
    return { ok: true, data: cachedTree.data };
  }

  const treeResult = await fetchRepoTree(owner, repo);
  if (treeResult.ok === false) {
    return { ok: false, error: treeResult.error, message: treeResult.message };
  }
  const entries = treeResult.data.map((e) => ({ path: e.path, type: e.type }));
  treeCache.set(treeCacheKey, { data: entries, cachedAt: Date.now() });
  return { ok: true, data: entries };
}

/**
 * Find the directory prefix for a skill in the repo tree.
 * Skills may live at various depths: `{skill}/`, `skills/{skill}/`, `.github/skills/{skill}/`, etc.
 * We find the directory that contains `SKILL.md` and whose last segment matches the skill name.
 */
function findSkillPrefix(tree: { path: string; type: string }[], skill: string): string | null {
  const suffix = `${skill}/SKILL.md`;
  const match = tree.find((e) => e.type === "blob" && e.path.endsWith(suffix));
  if (!match) return null;
  // prefix is everything up to and including the skill dir: "skills/find-skills/"
  return match.path.slice(0, match.path.length - "SKILL.md".length);
}

// --- Preview ---

export async function previewSkill(
  owner: string,
  repo: string,
  skill: string,
): Promise<GitHubResult<string>> {
  const cacheKey = `${owner}/${repo}/${skill}`;
  const cached = previewCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < PREVIEW_CACHE_TTL_MS) {
    return { ok: true, data: cached.data };
  }

  // Use tree to find actual SKILL.md path (may be under skills/, .github/skills/, etc.)
  const treeResult = await getRepoTree(owner, repo);
  if (treeResult.ok === false) {
    return { ok: false, error: treeResult.error, message: treeResult.message };
  }

  const prefix = findSkillPrefix(treeResult.data, skill);
  if (!prefix) {
    return { ok: false, error: "not_found", message: `SKILL.md not found for ${skill} in ${owner}/${repo}` };
  }

  const result = await fetchRawContent(owner, repo, `${prefix}SKILL.md`);
  if (result.ok === true) {
    previewCache.set(cacheKey, { data: result.data, cachedAt: Date.now() });
  }
  return result;
}

// --- Import (full tree + multi-file fetch) ---

/**
 * Generate a safe folder name from owner/repo/skill.
 * Replaces non-alphanumeric chars with hyphens, matches SafeFolderName pattern.
 */
export function toFolderName(owner: string, repo: string, skill: string): string {
  return `${owner}-${repo}-${skill}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 255);
}

export async function importSkillContent(
  owner: string,
  repo: string,
  skill: string,
): Promise<GitHubResult<ImportedSkill>> {
  const treeResult = await getRepoTree(owner, repo);
  if (treeResult.ok === false) {
    return { ok: false, error: treeResult.error, message: treeResult.message };
  }

  // Find skill directory in tree (may be nested under skills/, .github/skills/, etc.)
  const prefix = findSkillPrefix(treeResult.data, skill);
  if (!prefix) {
    return { ok: false, error: "not_found", message: `SKILL.md not found for ${skill} in ${owner}/${repo}` };
  }

  const skillFiles = treeResult.data.filter(
    (e) => e.type === "blob" && e.path.startsWith(prefix),
  );

  const warnings: string[] = [];

  // Cap file count
  if (skillFiles.length > MAX_FILES_PER_SKILL) {
    warnings.push(`Skill has ${skillFiles.length} files, only the first ${MAX_FILES_PER_SKILL} will be imported`);
  }
  const filesToFetch = skillFiles.slice(0, MAX_FILES_PER_SKILL);

  // Fetch all files in parallel via CDN
  const fileResults = await Promise.allSettled(
    filesToFetch.map(async (entry) => {
      const relativePath = entry.path.slice(prefix.length);
      const result = await fetchRawContent(owner, repo, entry.path);
      return { relativePath, result };
    }),
  );

  const files: Array<{ path: string; content: string }> = [];
  for (const settled of fileResults) {
    if (settled.status === "rejected") {
      warnings.push(`Failed to fetch file: ${settled.reason}`);
      continue;
    }
    const { relativePath, result } = settled.value;
    if (result.ok === true) {
      files.push({ path: relativePath, content: result.data });
    } else {
      warnings.push(`Skipped ${relativePath}: ${result.message}`);
    }
  }

  if (files.length === 0) {
    return { ok: false, error: "not_found", message: `All files under ${prefix} were skipped (binary or too large)` };
  }

  return {
    ok: true,
    data: {
      folder: toFolderName(owner, repo, skill),
      files,
      warnings,
    },
  };
}
