import { z } from "zod";
import { isValidTimezone } from "@/lib/schedule";
import { supportsClaudeRunner, resolveEffectiveRunner, isPermissionModeAllowed } from "@/lib/models";

// --- Identity JSONB Schema (reusable for nullable JSONB object columns) ---

export const identityJsonbSchema = z.unknown().transform((v) => (v && typeof v === "object" ? v : null) as Record<string, unknown> | null);

// --- Runner Validation ---

export const RunnerTypeSchema = z.enum(["claude-agent-sdk", "vercel-ai-sdk"]);

// --- Skills Validation ---

export const SafeFolderName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-zA-Z0-9_-]+$/, "Folder must be alphanumeric with underscores/hyphens only");

const SafeRelativePath = z
  .string()
  .min(1)
  .max(500)
  .refine((p) => !p.includes("..") && !p.startsWith("/") && !p.includes("\0"), {
    message: "Path must be relative, no '..' segments, no null bytes",
  });

export const AgentSkillFileSchema = z.object({
  path: SafeRelativePath,
  content: z.string().max(100_000),
});

const AgentSkillSchema = z.object({
  folder: SafeFolderName,
  files: z.array(AgentSkillFileSchema).min(1),
});

const SkillsSchema = z
  .array(AgentSkillSchema)
  .max(50, "Maximum 50 skills per agent")
  .refine(
    (skills) => {
      const folders = skills.map((s) => s.folder);
      return new Set(folders).size === folders.length;
    },
    { message: "Skill folder names must be unique" },
  )
  .refine(
    (skills) => {
      const totalSize = skills.reduce(
        (sum, s) => sum + s.files.reduce((fSum, f) => fSum + f.content.length, 0),
        0,
      );
      return totalSize <= 5 * 1024 * 1024;
    },
    { message: "Total skills content must be under 5MB" },
  );

// --- Plugin Marketplace Validation ---

export const CreatePluginMarketplaceSchema = z.object({
  tenant_id: z.string().uuid(),
  name: z.string().min(1).max(100),
  github_repo: z.string()
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, "Must be owner/repo format"),
  github_token: z.string().min(1).optional(),
});

export const PluginMarketplaceRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  name: z.string(),
  github_repo: z.string(),
  github_token_enc: z.string().nullable().default(null),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export type PluginMarketplace = z.infer<typeof PluginMarketplaceRow>;

export const PluginMarketplacePublicRow = z.object({
  id: z.string(),
  name: z.string(),
  github_repo: z.string(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export type PluginMarketplacePublic = z.infer<typeof PluginMarketplacePublicRow>;

export const UpdateMarketplaceSchema = z.object({
  github_token: z.string().min(1).nullable(),
}).partial();

// Agent plugin config (stored in agents.plugins JSONB)
export const AgentPluginSchema = z.object({
  marketplace_id: z.string().uuid(),
  plugin_name: z.string().min(1).max(200).regex(/^[a-zA-Z0-9/_-]+$/),
});

export const AgentPluginsSchema = z.array(AgentPluginSchema)
  .max(20)
  .refine(
    (plugins) => {
      const keys = plugins.map(p => `${p.marketplace_id}:${p.plugin_name}`);
      return new Set(keys).size === keys.length;
    },
    { message: "Duplicate plugin entries are not allowed" },
  );

// --- Granular Skills/Plugins CRUD Schemas ---

export const CreateSkillSchema = AgentSkillSchema;

export const UpdateSkillSchema = z.object({
  files: z.array(AgentSkillFileSchema).min(1),
});

export const AddPluginSchema = AgentPluginSchema;

// --- Partial Row Schemas (for JSONB column reads in route handlers) ---

export const AgentSkillsPartialRow = z.object({
  skills: z.array(
    z.object({
      folder: z.string(),
      files: z.array(z.object({ path: z.string(), content: z.string() })),
    }),
  ).default([]).catch([]),
});

export const AgentPluginsPartialRow = z.object({
  plugins: z.array(AgentPluginSchema).default([]).catch([]),
});

// Plugin manifest (fetched from GitHub plugin.json)
export const PluginManifestSchema = z.object({
  name: z.string().min(1).max(100),
  version: z.string().max(50).optional(),
  description: z.string().max(2000).optional(),
  author: z.object({ name: z.string().max(200) }).optional(),
});

// Plugin .mcp.json (fetched from GitHub)
export const PluginMcpJsonSchema = z.object({
  mcpServers: z.record(
    z.string().min(1).max(100),
    z.object({
      type: z.string().min(1).max(50),
      url: z.string().min(1),
    }),
  ).optional(),
});

// --- Plugin File Content Validation ---

/**
 * Validate YAML frontmatter in a markdown file.
 * Returns null if valid, or an error message string.
 */
export function validateFrontmatter(content: string, fileType: string): string | null {
  const lines = content.split("\n");

  if (lines[0]?.trim() !== "---") {
    return `${fileType} must start with '---' on line 1`;
  }

  const closingIndex = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (closingIndex === -1) {
    return `${fileType} has no closing '---' for frontmatter`;
  }

  const frontmatterLines = lines.slice(1, closingIndex);

  // Check indentation before presence (indented keys shouldn't count as present)
  const hasIndentedName = frontmatterLines.some(line => /^\s+name:/.test(line));
  const hasUnindentedName = frontmatterLines.some(line => /^name:/.test(line));
  if (hasIndentedName && !hasUnindentedName) {
    return `${fileType} 'name' key is indented — top-level YAML keys must not have leading spaces`;
  }
  if (!hasUnindentedName) {
    return `${fileType} frontmatter missing 'name' field`;
  }

  const hasIndentedDescription = frontmatterLines.some(line => /^\s+description:/.test(line));
  const hasUnindentedDescription = frontmatterLines.some(line => /^description:/.test(line));
  if (hasIndentedDescription && !hasUnindentedDescription) {
    return `${fileType} 'description' key is indented — top-level YAML keys must not have leading spaces`;
  }
  if (!hasUnindentedDescription) {
    return `${fileType} frontmatter missing 'description' field`;
  }

  return null;
}

// GitHub API response schemas
export const GitHubTreeEntrySchema = z.object({
  path: z.string(),
  mode: z.string(),
  type: z.enum(["blob", "tree"]),
  sha: z.string(),
  size: z.number().optional(),
  url: z.string(),
});

export const GitHubTreeResponseSchema = z.object({
  sha: z.string(),
  tree: z.array(GitHubTreeEntrySchema),
  truncated: z.boolean(),
});

// Safe filename for plugin files from GitHub
export const SafePluginFilename = z.string()
  .min(1).max(255)
  .regex(/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/, "Must have a safe filename with extension");

// --- Schedule Validation ---

export const ScheduleFrequencySchema = z.enum(["manual", "hourly", "daily", "weekdays", "weekly"]);
export const RunTriggeredBySchema = z.enum(["api", "schedule", "playground", "chat", "a2a", "webhook"]);
export const SessionStatusSchema = z.enum(["creating", "active", "idle", "stopped"]);
export const TimezoneSchema = z.string().min(1).max(100).refine(isValidTimezone, { message: "Invalid IANA timezone" });

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
  composio_allowed_tools: z.array(z.string().min(1).max(100)).default([]),
  skills: SkillsSchema.default([]),
  plugins: AgentPluginsSchema.default([]),
  model: z.string().min(1).max(100)
    .regex(/^[a-z0-9._-]+(?:\/[a-z0-9._:-]{1,80})?$/, "Model ID must be lowercase alphanumeric with dots/hyphens, optionally with provider/ prefix")
    .default("claude-sonnet-4-6"),
  runner: RunnerTypeSchema.nullable().default(null),
  allowed_tools: z
    .array(z.string().min(1).max(100))
    .default(["Read", "Edit", "Write", "Glob", "Grep", "Bash", "WebSearch"]),
  permission_mode: z
    .enum(["default", "acceptEdits", "bypassPermissions", "plan"])
    .default("bypassPermissions"),
  max_turns: z.number().int().min(1).max(1000).default(10),
  max_budget_usd: z.number().min(0.01).max(100.0).default(1.0),
  max_runtime_seconds: z.number().int().min(60).max(3600).default(600),
  a2a_enabled: z.boolean().default(false),
  soul_md: z.string().max(50_000).nullable().optional(),
  identity_md: z.string().max(50_000).nullable().optional(),
  style_md: z.string().max(50_000).nullable().optional(),
  agents_md: z.string().max(50_000).nullable().optional(),
  heartbeat_md: z.string().max(50_000).nullable().optional(),
  user_template_md: z.string().max(50_000).nullable().optional(),
  examples_good_md: z.string().max(50_000).nullable().optional(),
  examples_bad_md: z.string().max(50_000).nullable().optional(),
  soul_spec_version: z.string().max(10).nullable().optional(),
}).refine(
  (data) => {
    if (data.runner === "claude-agent-sdk" && !supportsClaudeRunner(data.model)) {
      return false;
    }
    return true;
  },
  { message: "Claude Agent SDK runner only supports Anthropic models" },
).refine(
  (data) => isPermissionModeAllowed(resolveEffectiveRunner(data.model, data.runner), data.permission_mode),
  { message: "Vercel AI SDK runner does not support permission modes other than 'default' and 'bypassPermissions'" },
);

// Strip defaults before .partial() so omitted fields stay undefined (not default values)
export const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable(),
  git_repo_url: z.string().url().regex(/^https:\/\/github\.com\//).max(2048).nullable(),
  git_branch: z.string().min(1).max(255),
  composio_toolkits: z.array(z.string().min(1).max(100)),
  composio_allowed_tools: z.array(z.string().min(1).max(100)),
  skills: SkillsSchema,
  plugins: AgentPluginsSchema,
  model: z.string().min(1).max(100)
    .regex(/^[a-z0-9._-]+(?:\/[a-z0-9._:-]{1,80})?$/, "Model ID must be lowercase alphanumeric with dots/hyphens, optionally with provider/ prefix"),
  runner: RunnerTypeSchema.nullable(),
  allowed_tools: z.array(z.string().min(1).max(100)),
  permission_mode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]),
  max_turns: z.number().int().min(1).max(1000),
  max_budget_usd: z.number().min(0.01).max(100.0),
  max_runtime_seconds: z.number().int().min(60).max(3600),
  a2a_enabled: z.boolean(),
  a2a_tags: z.array(z.string().min(1).max(100)),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/, "Slug must be lowercase alphanumeric with hyphens"),
  soul_md: z.string().max(50_000).nullable(),
  identity_md: z.string().max(50_000).nullable(),
  style_md: z.string().max(50_000).nullable(),
  agents_md: z.string().max(50_000).nullable(),
  heartbeat_md: z.string().max(50_000).nullable(),
  user_template_md: z.string().max(50_000).nullable(),
  examples_good_md: z.string().max(50_000).nullable(),
  examples_bad_md: z.string().max(50_000).nullable(),
  soul_spec_version: z.string().max(10).nullable(),
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

// --- Run Status Validation ---

export const RunStatusSchema = z.enum([
  "pending", "running", "completed", "failed", "cancelled", "timed_out",
]);

// --- Pagination ---

export const PaginationSchema = z.object({
  limit: z.preprocess((v) => (v === null || v === "" ? undefined : v), z.coerce.number().int().min(1).max(100).default(20)),
  offset: z.preprocess((v) => (v === null || v === "" ? undefined : v), z.coerce.number().int().min(0).default(0)),
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
  timezone: z.string().default("UTC"),
  logo_url: z.string().nullable().default(null),
  clawsouls_api_token_enc: z.string().nullable().default(null),
  subscription_base_url: z.string().nullable().default(null),
  subscription_token_expires_at: z.coerce.string().nullable().default(null),
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
  composio_mcp_server_id: z.string().nullable(),
  composio_mcp_server_name: z.string().nullable(),
  composio_allowed_tools: z.array(z.string()).default([]),
  skills: z.array(AgentSkillSchema).default([]).catch([]),
  plugins: z.array(AgentPluginSchema).default([]).catch([]),
  model: z.string(),
  runner: RunnerTypeSchema.nullable().default(null),
  allowed_tools: z.array(z.string()),
  permission_mode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]),
  max_turns: z.coerce.number(),
  max_budget_usd: z.coerce.number(),
  max_runtime_seconds: z.coerce.number(),
  a2a_enabled: z.boolean().default(false),
  a2a_tags: z.array(z.string()).default([]),
  slug: z.string().catch(""),
  soul_md: z.string().nullable().default(null),
  identity_md: z.string().nullable().default(null),
  style_md: z.string().nullable().default(null),
  agents_md: z.string().nullable().default(null),
  heartbeat_md: z.string().nullable().default(null),
  user_template_md: z.string().nullable().default(null),
  examples_good_md: z.string().nullable().default(null),
  examples_bad_md: z.string().nullable().default(null),
  soul_spec_version: z.string().nullable().default('0.5'),
  identity: identityJsonbSchema.default(null),
  created_at: z.coerce.string(),
  updated_at: z.coerce.string(),
});

// Internal schema that includes sensitive Composio MCP fields not exposed in API responses.
export const AgentRowInternal = AgentRow.extend({
  composio_mcp_url: z.string().nullable(),
  composio_mcp_api_key_enc: z.string().nullable(),
});

export type AgentInternal = z.infer<typeof AgentRowInternal>;

// --- MCP Server Validation ---

const RESERVED_MCP_SLUGS = ["composio"];

export const CreateMcpServerSchema = z.object({
  tenant_id: z.string().uuid(),
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens")
    .refine((s) => !RESERVED_MCP_SLUGS.includes(s), {
      message: `Slug cannot be a reserved name (${RESERVED_MCP_SLUGS.join(", ")})`,
    }),
  description: z.string().max(500).default(""),
  logo_url: z.string().url().optional(),
  base_url: z
    .string()
    .url()
    .refine((url) => url.startsWith("https://"), "Must be HTTPS"),
  mcp_endpoint_path: z
    .string()
    .max(200)
    .regex(/^\/[a-zA-Z0-9/_-]*$/, "Must be an absolute path")
    .default("/mcp"),
});

export type CreateMcpServerInput = z.infer<typeof CreateMcpServerSchema>;

export const UpdateMcpServerSchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().max(500),
    logo_url: z.string().url().nullable(),
  })
  .partial();

export type UpdateMcpServerInput = z.infer<typeof UpdateMcpServerSchema>;

export const UpdateMcpConnectionSchema = z.object({
  allowed_tools: z.array(z.string().min(1).max(100)),
});

export type UpdateMcpConnectionInput = z.infer<typeof UpdateMcpConnectionSchema>;

// --- MCP Server DB Row Schemas ---

export const McpServerRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  logo_url: z.string().nullable(),
  base_url: z.string(),
  mcp_endpoint_path: z.string(),
  client_id: z.string().nullable(),
  oauth_metadata: z
    .unknown()
    .transform((v) => (v && typeof v === "object" ? v : null) as Record<string, unknown> | null),
  created_at: z.coerce.string(),
  updated_at: z.coerce.string(),
});

// Internal schema includes sensitive client_secret_enc (never exposed in API)
export const McpServerRowInternal = McpServerRow.extend({
  client_secret_enc: z.string().nullable(),
});

export type McpServer = z.infer<typeof McpServerRow>;
export type McpServerInternal = z.infer<typeof McpServerRowInternal>;

export const McpConnectionRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  agent_id: z.string(),
  mcp_server_id: z.string(),
  status: z.enum(["initiated", "active", "expired", "failed"]),
  granted_scopes: z.array(z.string()),
  allowed_tools: z.array(z.string()),
  token_expires_at: z.coerce.string().nullable(),
  created_at: z.coerce.string(),
  updated_at: z.coerce.string(),
});

// Internal schema includes sensitive token fields (never exposed in API)
export const McpConnectionRowInternal = McpConnectionRow.extend({
  access_token_enc: z.string().nullable(),
  refresh_token_enc: z.string().nullable(),
  code_verifier_enc: z.string().nullable(),
  oauth_state: z.string().nullable(),
});

export type McpConnection = z.infer<typeof McpConnectionRow>;
export type McpConnectionInternal = z.infer<typeof McpConnectionRowInternal>;

// OAuthMetadata Zod schema for strict parsing of cached metadata
export const OAuthMetadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  registration_endpoint: z.string().url().optional(),
  scopes_supported: z.array(z.string()).optional(),
  response_types_supported: z.array(z.string()),
  grant_types_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});

// --- Session Message status (mirrors legacy RunStatus values; "queued" replaces "pending") ---

export const SessionMessageStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export type SessionMessageStatus = z.infer<typeof SessionMessageStatusSchema>;

// SessionMessageRow — one row per execution. Replaces the legacy RunRow. All
// billing-grade and audit fields live here at the message grain. Mirrors the
// columns defined in migration 033_runs_sessions_unify.sql.
export const SessionMessageRow = z.object({
  id: z.string(),
  session_id: z.string(),
  tenant_id: z.string(),
  prompt: z.string(),
  status: SessionMessageStatusSchema,
  triggered_by: RunTriggeredBySchema.catch("api"),
  runner: RunnerTypeSchema.nullable().default(null),
  cost_usd: z.coerce.number(),
  total_input_tokens: z.coerce.number(),
  total_output_tokens: z.coerce.number(),
  cache_read_tokens: z.coerce.number(),
  cache_creation_tokens: z.coerce.number(),
  num_turns: z.coerce.number(),
  duration_ms: z.coerce.number(),
  duration_api_ms: z.coerce.number(),
  model_usage: z.unknown().nullable(),
  transcript_blob_url: z.string().nullable(),
  result_summary: z.string().nullable(),
  error_type: z.string().nullable(),
  error_messages: z.array(z.string()),
  webhook_source_id: z.string().nullable().default(null),
  created_by_key_id: z.string().nullable().default(null),
  started_at: z.coerce.string().nullable(),
  completed_at: z.coerce.string().nullable(),
  created_at: z.coerce.string(),
  // Convenience fields populated by JOINs in list queries; optional/nullable.
  agent_id: z.string().nullable().optional(),
  agent_name: z.string().nullable().optional(),
  agent_model: z.string().nullable().optional(),
});

export type SessionMessage = z.infer<typeof SessionMessageRow>;

// --- Schedule DB Row & CRUD Schemas ---

const ScheduleTimeSchema = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Must be HH:MM or HH:MM:SS format").refine(
  (v) => {
    const [h, m] = v.split(":").map(Number);
    return h >= 0 && h <= 23 && m >= 0 && m <= 59;
  },
  { message: "Hours must be 0-23, minutes must be 0-59" },
);

export const ScheduleRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  agent_id: z.string(),
  name: z.string().nullable().default(null),
  frequency: ScheduleFrequencySchema,
  time: z.string().nullable().default(null),
  day_of_week: z.coerce.number().nullable().default(null),
  prompt: z.string().nullable().default(null),
  enabled: z.boolean(),
  last_run_at: z.coerce.string().nullable().default(null),
  next_run_at: z.coerce.string().nullable().default(null),
  created_at: z.coerce.string(),
  updated_at: z.coerce.string(),
});

export type Schedule = z.infer<typeof ScheduleRow>;

const scheduleBaseFields = {
  name: z.string().min(1).max(100).nullable().optional(),
  frequency: ScheduleFrequencySchema,
  time: ScheduleTimeSchema.nullable(),
  day_of_week: z.number().int().min(0).max(6).nullable(),
  prompt: z.string().min(1).max(100_000).nullable(),
  enabled: z.boolean(),
};

function addScheduleCrossFieldValidation<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  return schema.superRefine((data, ctx) => {
    const freq = data.frequency as string;
    if (["daily", "weekdays", "weekly"].includes(freq) && !data.time) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "time is required for daily/weekdays/weekly", path: ["time"] });
    }
    if (freq === "weekly" && (data.day_of_week === null || data.day_of_week === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "day_of_week is required for weekly", path: ["day_of_week"] });
    }
    if (freq !== "weekly" && data.day_of_week !== null && data.day_of_week !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "day_of_week only applies to weekly", path: ["day_of_week"] });
    }
    if (data.enabled && (!data.prompt || (typeof data.prompt === "string" && data.prompt.length === 0))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "prompt is required when enabled", path: ["prompt"] });
    }
    if (data.enabled && freq === "manual") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cannot enable a manual schedule", path: ["enabled"] });
    }
  });
}

export const ScheduleInputSchema = addScheduleCrossFieldValidation(
  z.object(scheduleBaseFields),
);

export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;

// --- Session Validation ---

export const CreateSessionSchema = z.object({
  agent_id: z.string().uuid(),
  prompt: z.string().min(1).max(100_000).optional(),
});

export type CreateSessionInput = z.infer<typeof CreateSessionSchema>;

export const SendMessageSchema = z.object({
  prompt: z.string().min(1).max(100_000),
  max_turns: z.number().int().min(1).max(1000).optional(),
  max_budget_usd: z.number().min(0.01).max(100.0).optional(),
});

export type SendMessageInput = z.infer<typeof SendMessageSchema>;

// SessionRow — mirrors the unified `sessions` table from migration 033. Adds
// `ephemeral`, `idle_ttl_seconds`, and `expires_at` to the legacy session
// shape. `last_message_at` is removed — the same information is derivable
// from `session_messages.completed_at` and would otherwise drift.
export const SessionRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  agent_id: z.string(),
  sandbox_id: z.string().nullable(),
  sdk_session_id: z.string().nullable(),
  session_blob_url: z.string().nullable(),
  status: SessionStatusSchema,
  ephemeral: z.boolean().default(false),
  idle_ttl_seconds: z.coerce.number().int().default(600),
  expires_at: z.coerce.string(),
  context_id: z.string().nullable().default(null),
  message_count: z.coerce.number(),
  idle_since: z.coerce.string().nullable(),
  last_backup_at: z.coerce.string().nullable(),
  mcp_refreshed_at: z.coerce.string().nullable(),
  created_at: z.coerce.string(),
  updated_at: z.coerce.string(),
});

export type Session = z.infer<typeof SessionRow>;

// Public response schema — strips internal fields (sandbox_id, session_blob_url)
export const SessionResponseRow = SessionRow.omit({
  sandbox_id: true,
  session_blob_url: true,
  last_backup_at: true,
  mcp_refreshed_at: true,
});

export type SessionResponse = z.infer<typeof SessionResponseRow>;

// --- Webhook Dedupe Rules ---

// Dot-path segments must look like JSON identifiers and chain with dots.
// Allows 1–10 segments, each up to 64 chars. Total length capped at 200.
const DEDUPE_KEY_PATH_REGEX =
  /^[a-zA-Z_][a-zA-Z0-9_]{0,63}(\.[a-zA-Z_][a-zA-Z0-9_]{0,63}){0,9}$/;

const DedupeKeyPathSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    DEDUPE_KEY_PATH_REGEX,
    "key_path must be 1–10 dot-separated segments of letters/digits/underscore (e.g. 'data.url')",
  );

const DedupeWindowSecondsSchema = z
  .number()
  .int()
  .min(1, "window_seconds must be ≥ 1")
  .max(3600, "window_seconds must be ≤ 3600");

const DedupeProviderSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z][a-z0-9_-]*$/, "provider must be lowercase letters/digits/underscore/hyphen");

export const CreateDedupeRuleSchema = z.object({
  provider: DedupeProviderSchema,
  key_path: DedupeKeyPathSchema,
  window_seconds: DedupeWindowSecondsSchema,
  enabled: z.boolean().optional(),
});
export type CreateDedupeRuleInput = z.infer<typeof CreateDedupeRuleSchema>;

export const UpdateDedupeRuleSchema = z
  .object({
    key_path: DedupeKeyPathSchema.optional(),
    window_seconds: DedupeWindowSecondsSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (patch) =>
      patch.key_path !== undefined ||
      patch.window_seconds !== undefined ||
      patch.enabled !== undefined,
    { message: "patch must include at least one of key_path, window_seconds, enabled" },
  );
export type UpdateDedupeRuleInput = z.infer<typeof UpdateDedupeRuleSchema>;

// --- Webhook Payload Filter Rules ---
//
// Per-source boolean expression evaluated against the parsed payload after
// content-dedupe. Mismatch = drop with audit (200 + filtered: true). Empty
// conditions or null rules = no filtering. See src/lib/webhook-filter.ts for
// the evaluator and operator semantics.

export const FilterOperatorSchema = z.enum([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "exists",
  "not_exists",
]);
export type FilterOperator = z.infer<typeof FilterOperatorSchema>;

const FilterConditionSchema = z
  .object({
    keyPath: DedupeKeyPathSchema,
    operator: FilterOperatorSchema,
    // Required for non-existence operators; ignored for exists/not_exists.
    value: z.string().max(500).optional(),
  })
  .refine(
    (cond) =>
      cond.operator === "exists" ||
      cond.operator === "not_exists" ||
      typeof cond.value === "string",
    {
      message:
        "value is required for equals/not_equals/contains/not_contains operators",
    },
  );
export type FilterCondition = z.infer<typeof FilterConditionSchema>;

export const FilterRulesSchema = z.object({
  combinator: z.enum(["AND", "OR"]),
  conditions: z.array(FilterConditionSchema).max(50),
});
export type FilterRules = z.infer<typeof FilterRulesSchema>;
