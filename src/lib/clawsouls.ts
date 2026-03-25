/**
 * ClawSouls REST API client.
 *
 * Typed, Zod-validated client with process-level caching for categories and
 * scan-rules. Uses native fetch; no external HTTP libraries.
 */

import { z } from "zod";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = "https://clawsouls.ai/api/v1";
const FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class ClawSoulsError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ClawSoulsError";
  }
}

function mapHttpError(status: number, fallback: string): string {
  switch (status) {
    case 401:
      return "Authentication required";
    case 403:
      return "Forbidden";
    case 404:
      return "Soul not found";
    case 429:
      return "Rate limited";
    default:
      return fallback;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SoulManifest {
  specVersion: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  author: { name: string; github?: string; url?: string };
  license: string;
  tags: string[];
  category: string;
  files: Record<string, string>;
  compatibility?: {
    models?: string[];
    frameworks?: string[];
    minTokenContext?: number;
  };
  allowedTools?: string[];
  recommendedSkills?: Array<{
    name: string;
    version?: string;
    required?: boolean;
  }>;
  disclosure?: { summary: string };
  repository?: string;
}

export interface SoulListItem {
  name: string;
  owner: string;
  fullName: string;
  displayName: string;
  version: string;
  description: string;
  author: { name: string; github?: string };
  license: string;
  tags: string[];
  category: string;
  downloads: number;
  avgRating: number | null;
  reviewCount: number;
  scanScore: number;
  scanStatus: string;
}

export interface SoulDetail extends SoulListItem {
  files: Record<string, string>;
  latestScan?: {
    status: string;
    score: number;
    grade: string;
    errors: string[];
    warnings: string[];
  };
}

export interface ValidationCheck {
  type: "pass" | "fail" | "warn";
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  checks: ValidationCheck[];
}

export interface CategoryInfo {
  name: string;
  count: number;
}

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const AuthorSchema = z.object({
  name: z.string(),
  github: z.string().optional(),
  url: z.string().optional(),
});

const SoulListItemSchema = z.object({
  name: z.string(),
  owner: z.string(),
  fullName: z.string(),
  displayName: z.string(),
  version: z.string(),
  description: z.string(),
  author: z.object({ name: z.string(), github: z.string().optional() }),
  license: z.string(),
  tags: z.array(z.string()),
  category: z.string(),
  downloads: z.number(),
  avgRating: z.number().nullable(),
  reviewCount: z.number(),
  scanScore: z.number(),
  scanStatus: z.string(),
});

const SoulListResponseSchema = z.object({
  data: z.array(SoulListItemSchema),
  total: z.number().optional(),
  page: z.number().optional(),
  limit: z.number().optional(),
});

const LatestScanSchema = z.object({
  status: z.string(),
  score: z.number(),
  grade: z.string(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
});

const SoulDetailSchema = SoulListItemSchema.extend({
  files: z.record(z.string(), z.string()),
  latestScan: LatestScanSchema.optional(),
});

const ValidationCheckSchema = z.object({
  type: z.enum(["pass", "fail", "warn"]),
  message: z.string(),
});

const ValidationResultSchema = z.object({
  valid: z.boolean(),
  checks: z.array(ValidationCheckSchema),
});

const CategoryInfoSchema = z.object({
  name: z.string(),
  count: z.number(),
});

const CategoriesResponseSchema = z.array(CategoryInfoSchema);

const ScanRuleSchema = z.object({
  id: z.string(),
  severity: z.string(),
  description: z.string(),
});

const ScanRulesResponseSchema = z.array(ScanRuleSchema);

export type ScanRule = z.infer<typeof ScanRuleSchema>;

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

async function request(
  path: string,
  opts: RequestInit & { token?: string } = {},
): Promise<Response> {
  const { token, ...init } = opts;
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new ClawSoulsError(
        mapHttpError(res.status, `ClawSouls API error: ${res.status}`),
        res.status,
      );
    }

    return res;
  } finally {
    clearTimeout(timeout);
  }
}

function qs(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      parts.push(
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
      );
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

// ---------------------------------------------------------------------------
// Process-Level Caches
// ---------------------------------------------------------------------------

let cachedCategories: CategoryInfo[] | null = null;
let lastKnownGoodCategories: CategoryInfo[] | null = null;
let categoriesCacheTs = 0;
const CATEGORIES_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedScanRules: ScanRule[] | null = null;
let lastKnownGoodScanRules: ScanRule[] | null = null;
let scanRulesCacheTs = 0;
const SCAN_RULES_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List souls with optional filtering, sorting, and pagination.
 */
export async function listSouls(
  params?: {
    q?: string;
    category?: string;
    tag?: string;
    sort?: string;
    page?: number;
    limit?: number;
  },
): Promise<{ data: SoulListItem[]; total?: number; page?: number; limit?: number }> {
  const query = qs(params ?? {});
  const res = await request(`/souls${query}`);
  const json = await res.json();
  const parsed = SoulListResponseSchema.safeParse(json);

  if (!parsed.success) {
    logger.warn("ClawSouls listSouls response failed validation", {
      error: parsed.error.message,
    });
    throw new ClawSoulsError("Invalid response from ClawSouls API");
  }

  return parsed.data;
}

/**
 * Full-text search for souls.
 */
export async function searchSouls(
  query: string,
  opts?: { tag?: string; category?: string },
): Promise<{ data: SoulListItem[]; total?: number; page?: number; limit?: number }> {
  const params = qs({ q: query, ...opts });
  const res = await request(`/search${params}`);
  const json = await res.json();
  const parsed = SoulListResponseSchema.safeParse(json);

  if (!parsed.success) {
    logger.warn("ClawSouls searchSouls response failed validation", {
      error: parsed.error.message,
    });
    throw new ClawSoulsError("Invalid response from ClawSouls API");
  }

  return parsed.data;
}

/**
 * Get full soul details including files.
 */
export async function getSoul(
  owner: string,
  name: string,
): Promise<SoulDetail> {
  const res = await request(`/souls/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
    headers: { Accept: "text/markdown" },
  });
  const json = await res.json();
  const parsed = SoulDetailSchema.safeParse(json);

  if (!parsed.success) {
    logger.warn("ClawSouls getSoul response failed validation", {
      error: parsed.error.message,
    });
    throw new ClawSoulsError("Invalid response from ClawSouls API");
  }

  return parsed.data;
}

/**
 * Download a soul as a Buffer. Requires authentication.
 */
export async function downloadSoul(
  owner: string,
  name: string,
  token: string,
  version?: string,
): Promise<Buffer> {
  const query = qs({ version });
  const res = await request(
    `/souls/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/download${query}`,
    { token },
  );
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Publish (create or update) a soul. Requires authentication.
 */
export async function publishSoul(
  owner: string,
  name: string,
  manifest: SoulManifest,
  files: Record<string, string>,
  token: string,
): Promise<void> {
  await request(
    `/souls/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/publish`,
    {
      method: "PUT",
      token,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest, files }),
    },
  );
}

/**
 * Validate a soul manifest and files without publishing.
 */
export async function validateSoul(
  manifest: SoulManifest,
  files: Record<string, string>,
): Promise<ValidationResult> {
  const res = await request("/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manifest, files }),
  });
  const json = await res.json();
  const parsed = ValidationResultSchema.safeParse(json);

  if (!parsed.success) {
    logger.warn("ClawSouls validateSoul response failed validation", {
      error: parsed.error.message,
    });
    throw new ClawSoulsError("Invalid response from ClawSouls API");
  }

  return parsed.data;
}

/**
 * List all soul categories. Cached at process level (5 min TTL).
 * Falls back to stale cache on error.
 */
export async function listCategories(): Promise<CategoryInfo[]> {
  if (cachedCategories && Date.now() - categoriesCacheTs < CATEGORIES_TTL_MS) {
    return cachedCategories;
  }

  try {
    const res = await request("/categories");
    const json = await res.json();
    const parsed = CategoriesResponseSchema.safeParse(json);

    if (!parsed.success) {
      logger.warn("ClawSouls listCategories response failed validation", {
        error: parsed.error.message,
      });
      return lastKnownGoodCategories ?? [];
    }

    cachedCategories = parsed.data;
    lastKnownGoodCategories = parsed.data;
    categoriesCacheTs = Date.now();
    return parsed.data;
  } catch (err) {
    logger.warn("Failed to fetch ClawSouls categories, using fallback", {
      error: err instanceof Error ? err.message : String(err),
    });
    return lastKnownGoodCategories ?? [];
  }
}

/**
 * Get scan rules. Cached at process level (15 min TTL).
 * Falls back to stale cache on error.
 */
export async function getScanRules(): Promise<ScanRule[]> {
  if (cachedScanRules && Date.now() - scanRulesCacheTs < SCAN_RULES_TTL_MS) {
    return cachedScanRules;
  }

  try {
    const res = await request("/scan-rules");
    const json = await res.json();
    const parsed = ScanRulesResponseSchema.safeParse(json);

    if (!parsed.success) {
      logger.warn("ClawSouls getScanRules response failed validation", {
        error: parsed.error.message,
      });
      return lastKnownGoodScanRules ?? [];
    }

    cachedScanRules = parsed.data;
    lastKnownGoodScanRules = parsed.data;
    scanRulesCacheTs = Date.now();
    return parsed.data;
  } catch (err) {
    logger.warn("Failed to fetch ClawSouls scan rules, using fallback", {
      error: err instanceof Error ? err.message : String(err),
    });
    return lastKnownGoodScanRules ?? [];
  }
}
