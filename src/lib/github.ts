/**
 * Pure HTTP client for the GitHub API.
 *
 * This module handles external HTTP calls only — no DB access, no caching.
 * Orchestration and caching live in plugins.ts.
 *
 * Functions:
 * - fetchRepoTree()    — Git Trees API (single call for entire repo)
 * - fetchRawContent()  — raw.githubusercontent.com (CDN, not rate-limited)
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
  | { ok: false; error: "not_found" | "rate_limited" | "server_error" | "parse_error"; message: string };

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "AgentPlane",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
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
