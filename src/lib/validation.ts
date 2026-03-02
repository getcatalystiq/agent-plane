import { z } from "zod";

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
  name: z.string().min(1).max(100),
  github_repo: z.string()
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, "Must be owner/repo format"),
});

export const PluginMarketplaceRow = z.object({
  id: z.string(),
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
  plugin_name: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
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
  model: z.string().min(1).max(100).default("claude-sonnet-4-6"),
  allowed_tools: z
    .array(z.string().min(1).max(100))
    .default(["Read", "Edit", "Write", "Glob", "Grep", "Bash", "WebSearch"]),
  permission_mode: z
    .enum(["default", "acceptEdits", "bypassPermissions", "plan"])
    .default("bypassPermissions"),
  max_turns: z.number().int().min(1).max(1000).default(10),
  max_budget_usd: z.number().min(0.01).max(100.0).default(1.0),
});

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

// --- Run Status Validation ---

export const RunStatusSchema = z.enum([
  "pending", "running", "completed", "failed", "cancelled", "timed_out",
]);

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
  composio_mcp_server_id: z.string().nullable(),
  composio_mcp_server_name: z.string().nullable(),
  composio_allowed_tools: z.array(z.string()).default([]),
  skills: z.array(AgentSkillSchema).default([]).catch([]),
  plugins: z.array(AgentPluginSchema).default([]).catch([]),
  model: z.string(),
  allowed_tools: z.array(z.string()),
  permission_mode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]),
  max_turns: z.coerce.number(),
  max_budget_usd: z.coerce.number(),
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
