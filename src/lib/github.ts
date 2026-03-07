/**
 * Pure HTTP client for the GitHub API.
 *
 * This module handles external HTTP calls only — no DB access, no caching.
 * Orchestration and caching live in plugins.ts.
 *
 * Functions:
 * - fetchRepoTree()    — Git Trees API (single call for entire repo)
 * - fetchRawContent()  — raw.githubusercontent.com (CDN, not rate-limited)
 * - checkWriteAccess() — verify token has push permission
 * - pushFiles()        — atomic multi-file commit via Git Trees + Commits API
 *
 * Security:
 * - Never follows download_url from API responses (SSRF risk)
 * - Only connects to api.github.com and raw.githubusercontent.com
 * - Validates responses through Zod schemas
 */

import { GitHubTreeResponseSchema } from "./validation";
import type { z } from "zod";

export type GitHubTreeEntry = z.infer<typeof GitHubTreeResponseSchema>["tree"][number];

export type GitHubResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: "not_found" | "rate_limited" | "server_error" | "parse_error" | "conflict" | "forbidden"; message: string };

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "AgentPlane",
  };
  if (token) {
    // Classic PATs (ghp_) use "token" scheme; fine-grained (github_pat_) use "Bearer"
    const scheme = token.startsWith("ghp_") ? "token" : "Bearer";
    headers.Authorization = `${scheme} ${token}`;
  }
  return headers;
}

/**
 * Fetch the full repository tree in a single API call.
 * Uses: GET /repos/{owner}/{repo}/git/trees/HEAD?recursive=1
 */
export async function fetchRepoTree(
  owner: string,
  repo: string,
  token?: string,
): Promise<GitHubResult<GitHubTreeEntry[]>> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/HEAD?recursive=1`;

  let response: Response;
  try {
    response = await fetch(url, { headers: buildHeaders(token) });
  } catch (err) {
    return { ok: false, error: "server_error", message: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (response.status === 404) {
    // Could be a truly missing repo OR an empty repo (no commits → HEAD doesn't exist).
    // Check the repo endpoint to distinguish.
    const repoUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    try {
      const repoResponse = await fetch(repoUrl, { headers: buildHeaders(token) });
      if (repoResponse.ok) {
        // Repo exists but is empty — return empty tree
        return { ok: true, data: [] };
      }
    } catch { /* fall through to not_found */ }
    return { ok: false, error: "not_found", message: `Repository not found: ${owner}/${repo}` };
  }
  if (response.status === 403 || response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    return { ok: false, error: "rate_limited", message: `Rate limited${retryAfter ? ` (retry after ${retryAfter}s)` : ""}` };
  }
  if (!response.ok) {
    return { ok: false, error: "server_error", message: `GitHub API error: ${response.status}` };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, error: "parse_error", message: "Invalid JSON from GitHub API" };
  }

  const parsed = GitHubTreeResponseSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: "parse_error", message: `Unexpected response shape: ${parsed.error.message}` };
  }

  return { ok: true, data: parsed.data.tree };
}

/**
 * Fetch raw file content from raw.githubusercontent.com (CDN, not rate-limited).
 * Validates content is valid UTF-8 text (rejects binary/control characters).
 */
export async function fetchRawContent(
  owner: string,
  repo: string,
  filePath: string,
  token?: string,
): Promise<GitHubResult<string>> {
  const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/HEAD/${filePath}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch (err) {
    return { ok: false, error: "server_error", message: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (response.status === 404) {
    return { ok: false, error: "not_found", message: `File not found: ${filePath}` };
  }
  if (!response.ok) {
    return { ok: false, error: "server_error", message: `GitHub raw fetch error: ${response.status}` };
  }

  const content = await response.text();

  // Reject binary content: check for null bytes or non-printable control chars (allow \n, \r, \t)
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(content)) {
    return { ok: false, error: "parse_error", message: `File contains non-text content: ${filePath}` };
  }

  // Enforce per-file size limit (100KB)
  if (content.length > 100_000) {
    return { ok: false, error: "parse_error", message: `File exceeds 100KB limit: ${filePath} (${content.length} bytes)` };
  }

  return { ok: true, data: content };
}

/**
 * Check if a token has push (write) access to a repository.
 */
export async function checkWriteAccess(
  owner: string,
  repo: string,
  token: string,
): Promise<GitHubResult<boolean>> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  let response: Response;
  try {
    response = await fetch(url, { headers: buildHeaders(token) });
  } catch (err) {
    return { ok: false, error: "server_error", message: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (response.status === 404) {
    return { ok: false, error: "not_found", message: `Repository not found: ${owner}/${repo}` };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: "forbidden", message: "Token does not have access to this repository" };
  }
  if (!response.ok) {
    return { ok: false, error: "server_error", message: `GitHub API error: ${response.status}` };
  }

  let json: Record<string, unknown>;
  try {
    json = await response.json();
  } catch {
    return { ok: false, error: "parse_error", message: "Invalid JSON from GitHub API" };
  }

  const permissions = json.permissions as Record<string, boolean> | undefined;
  if (!permissions?.push) {
    return { ok: false, error: "forbidden", message: "Token does not have push permission on this repository" };
  }

  return { ok: true, data: true };
}

/**
 * Get the default branch of a repository.
 */
export async function getDefaultBranch(
  owner: string,
  repo: string,
  token: string,
): Promise<GitHubResult<string>> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  let response: Response;
  try {
    response = await fetch(url, { headers: buildHeaders(token) });
  } catch (err) {
    return { ok: false, error: "server_error", message: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!response.ok) {
    return { ok: false, error: "server_error", message: `GitHub API error: ${response.status}` };
  }

  let json: Record<string, unknown>;
  try {
    json = await response.json();
  } catch {
    return { ok: false, error: "parse_error", message: "Invalid JSON from GitHub API" };
  }

  const branch = json.default_branch as string | undefined;
  if (!branch) {
    return { ok: false, error: "parse_error", message: "No default_branch in response" };
  }

  return { ok: true, data: branch };
}

export interface PushFile {
  path: string;
  content: string;
}

/**
 * Push files to a repository via Git Trees + Commits API (atomic multi-file commit).
 *
 * Flow:
 * 1. GET ref → current commit SHA
 * 2. POST tree → new tree with changed files
 * 3. POST commit → new commit pointing to tree
 * 4. PATCH ref → update branch (non-force, rejects on conflict)
 */
export async function pushFiles(
  owner: string,
  repo: string,
  token: string,
  branch: string,
  files: PushFile[],
  message: string,
): Promise<GitHubResult<{ commitSha: string }>> {
  const headers = { ...buildHeaders(token), "Content-Type": "application/json" };
  const baseUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  // 1. Get current commit SHA from ref
  let refResponse: Response;
  try {
    refResponse = await fetch(`${baseUrl}/git/ref/heads/${encodeURIComponent(branch)}`, { headers });
  } catch (err) {
    return { ok: false, error: "server_error", message: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!refResponse.ok) {
    return { ok: false, error: "server_error", message: `Failed to get ref: ${refResponse.status}` };
  }
  const refData = await refResponse.json();
  const currentCommitSha = refData.object?.sha as string;
  if (!currentCommitSha) {
    return { ok: false, error: "parse_error", message: "No commit SHA in ref response" };
  }

  // Get the tree SHA from the current commit
  let commitResponse: Response;
  try {
    commitResponse = await fetch(`${baseUrl}/git/commits/${currentCommitSha}`, { headers });
  } catch (err) {
    return { ok: false, error: "server_error", message: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!commitResponse.ok) {
    return { ok: false, error: "server_error", message: `Failed to get commit: ${commitResponse.status}` };
  }
  const commitData = await commitResponse.json();
  const baseTreeSha = commitData.tree?.sha as string;

  // 2. Create new tree
  const treeEntries = files.map((f) => ({
    path: f.path,
    mode: "100644" as const,
    type: "blob" as const,
    content: f.content,
  }));

  let treeResponse: Response;
  try {
    treeResponse = await fetch(`${baseUrl}/git/trees`, {
      method: "POST",
      headers,
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
    });
  } catch (err) {
    return { ok: false, error: "server_error", message: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!treeResponse.ok) {
    return { ok: false, error: "server_error", message: `Failed to create tree: ${treeResponse.status}` };
  }
  const treeData = await treeResponse.json();
  const newTreeSha = treeData.sha as string;

  // 3. Create commit
  let newCommitResponse: Response;
  try {
    newCommitResponse = await fetch(`${baseUrl}/git/commits`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message,
        tree: newTreeSha,
        parents: [currentCommitSha],
      }),
    });
  } catch (err) {
    return { ok: false, error: "server_error", message: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!newCommitResponse.ok) {
    return { ok: false, error: "server_error", message: `Failed to create commit: ${newCommitResponse.status}` };
  }
  const newCommitData = await newCommitResponse.json();
  const newCommitSha = newCommitData.sha as string;

  // 4. Update ref (non-force — rejects on conflict)
  let updateRefResponse: Response;
  try {
    updateRefResponse = await fetch(`${baseUrl}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ sha: newCommitSha, force: false }),
    });
  } catch (err) {
    return { ok: false, error: "server_error", message: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (updateRefResponse.status === 409 || updateRefResponse.status === 422) {
    return { ok: false, error: "conflict", message: "Branch was modified externally. Please refresh and try again." };
  }
  if (!updateRefResponse.ok) {
    return { ok: false, error: "server_error", message: `Failed to update ref: ${updateRefResponse.status}` };
  }

  return { ok: true, data: { commitSha: newCommitSha } };
}
