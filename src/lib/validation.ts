import { z } from "zod";

// --- Agent Validation ---

export const CreateAgentSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  git_repo_url: z
    .string()
    .url()
    .regex(/^https:\/\/github\.com\//)
    .max(2048)
    .nullable()
    .optional(),
  git_branch: z.string().min(1).max(255).default("main"),
  composio_toolkits: z.array(z.string().min(1).max(100)).default([]),
  skills: z.array(z.object({
    folder: z.string().min(1).max(255),
    files: z.array(z.object({
      path: z.string().min(1).max(500),
      content: z.string().max(100_000),
    })).min(1),
  })).default([]),
  model: z.string().min(1).max(100).default("claude-sonnet-4-5-20250929"),
  allowed_tools: z
    .array(z.string().min(1).max(100))
    .default(["Read", "Edit", "Write", "Glob", "Grep", "Bash", "WebSearch"]),
  permission_mode: z
    .enum(["default", "acceptEdits", "bypassPermissions", "plan"])
    .default("bypassPermissions"),
  max_turns: z.number().int().min(1).max(1000).default(100),
  max_budget_usd: z.number().min(0.01).max(100.0).default(1.0),
});

// Strip defaults before .partial() so omitted fields stay undefined (not default values)
export const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable(),
  git_repo_url: z.string().url().regex(/^https:\/\/github\.com\//).max(2048).nullable(),
  git_branch: z.string().min(1).max(255),
  composio_toolkits: z.array(z.string().min(1).max(100)),
  skills: z.array(z.object({
    folder: z.string().min(1).max(255),
    files: z.array(z.object({
      path: z.string().min(1).max(500),
      content: z.string().max(100_000),
    })).min(1),
  })),
  model: z.string().min(1).max(100),
  allowed_tools: z.array(z.string().min(1).max(100)),
  permission_mode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]),
  max_turns: z.number().int().min(1).max(1000),
  max_budget_usd: z.number().min(0.01).max(100.0),
}).partial();

export type CreateAgentInput = z.infer<typeof CreateAgentSchema>;
export type UpdateAgentInput = z.infer<typeof UpdateAgentSchema>;

// --- API Key Validation ---

export const CreateApiKeySchema = z.object({
  name: z.string().min(1).max(255).default("default"),
  scopes: z.array(z.string()).default([]),
  expires_at: z.string().datetime().nullable().optional(),
});

export type CreateApiKeyInput = z.infer<typeof CreateApiKeySchema>;

// --- Run Validation ---

export const CreateRunSchema = z.object({
  agent_id: z.string().uuid(),
  prompt: z.string().min(1).max(100_000),
  max_turns: z.number().int().min(1).max(1000).optional(),
  max_budget_usd: z.number().min(0.01).max(100.0).optional(),
});

export type CreateRunInput = z.infer<typeof CreateRunSchema>;

// --- Pagination ---

export const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// --- DB Row Schemas (for typed query helper) ---

export const TenantRow = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  settings: z.unknown().transform((v) => (v && typeof v === "object" ? v : {}) as Record<string, unknown>),
  monthly_budget_usd: z.coerce.number(),
  status: z.enum(["active", "suspended"]),
  current_month_spend: z.coerce.number(),
  spend_period_start: z.coerce.string(),
  created_at: z.coerce.string(),
});

export const ApiKeyRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  name: z.string(),
  key_prefix: z.string(),
  key_hash: z.string(),
  scopes: z.array(z.string()),
  last_used_at: z.coerce.string().nullable(),
  expires_at: z.coerce.string().nullable(),
  revoked_at: z.coerce.string().nullable(),
  created_at: z.coerce.string(),
});

export const AgentRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  git_repo_url: z.string().nullable(),
  git_branch: z.string(),
  composio_toolkits: z.array(z.string()),
  skills: z.unknown().transform((v) => (Array.isArray(v) ? v : []) as Array<{ folder: string; files: Array<{ path: string; content: string }> }>),
  model: z.string(),
  allowed_tools: z.array(z.string()),
  permission_mode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]),
  max_turns: z.coerce.number(),
  max_budget_usd: z.coerce.number(),
  created_at: z.coerce.string(),
  updated_at: z.coerce.string(),
});

export const RunRow = z.object({
  id: z.string(),
  agent_id: z.string(),
  tenant_id: z.string(),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled", "timed_out"]),
  prompt: z.string(),
  result_summary: z.string().nullable(),
  total_input_tokens: z.coerce.number(),
  total_output_tokens: z.coerce.number(),
  cache_read_tokens: z.coerce.number(),
  cache_creation_tokens: z.coerce.number(),
  cost_usd: z.coerce.number(),
  num_turns: z.coerce.number(),
  duration_ms: z.coerce.number(),
  duration_api_ms: z.coerce.number(),
  model_usage: z.unknown().nullable(),
  transcript_blob_url: z.string().nullable(),
  error_type: z.string().nullable(),
  error_messages: z.array(z.string()),
  sandbox_id: z.string().nullable(),
  started_at: z.coerce.string().nullable(),
  completed_at: z.coerce.string().nullable(),
  created_at: z.coerce.string(),
});
