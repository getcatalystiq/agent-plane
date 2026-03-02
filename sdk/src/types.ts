// --- Client Options ---

export interface AgentPlaneOptions {
  /** API key (ap_live_* or ap_test_*). Falls back to AGENTPLANE_API_KEY env var. */
  apiKey?: string | undefined;
  /** Base URL for the API. Falls back to AGENTPLANE_BASE_URL env var. */
  baseUrl?: string | undefined;
  /** Custom fetch implementation for testing or custom environments. */
  fetch?: typeof globalThis.fetch | undefined;
}

// --- Run Status ---

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

// --- Agent ---

export interface AgentSkillFile {
  path: string;
  content: string;
}

export interface AgentSkill {
  folder: string;
  files: AgentSkillFile[];
}

export interface AgentPlugin {
  marketplace_id: string;
  plugin_name: string;
}

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

export interface Agent {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  git_repo_url: string | null;
  git_branch: string;
  composio_toolkits: string[];
  composio_mcp_server_id: string | null;
  composio_mcp_server_name: string | null;
  composio_allowed_tools: string[];
  skills: AgentSkill[];
  plugins: AgentPlugin[];
  model: string;
  allowed_tools: string[];
  permission_mode: PermissionMode;
  max_turns: number;
  max_budget_usd: number;
  created_at: string;
  updated_at: string;
}

export interface CreateAgentParams {
  name: string;
  description?: string | null | undefined;
  git_repo_url?: string | null | undefined;
  git_branch?: string | undefined;
  composio_toolkits?: string[] | undefined;
  composio_allowed_tools?: string[] | undefined;
  skills?: AgentSkill[] | undefined;
  plugins?: AgentPlugin[] | undefined;
  model?: string | undefined;
  allowed_tools?: string[] | undefined;
  permission_mode?: PermissionMode | undefined;
  max_turns?: number | undefined;
  max_budget_usd?: number | undefined;
}

export type UpdateAgentParams = Partial<CreateAgentParams>;

// --- Run ---

export interface Run {
  id: string;
  agent_id: string;
  tenant_id: string;
  status: RunStatus;
  prompt: string;
  result_summary: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  num_turns: number;
  duration_ms: number;
  duration_api_ms: number;
  model_usage: unknown | null;
  transcript_blob_url: string | null;
  error_type: string | null;
  error_messages: string[];
  sandbox_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface CreateRunParams {
  agent_id: string;
  prompt: string;
  max_turns?: number | undefined;
  max_budget_usd?: number | undefined;
}

export interface ListRunsParams extends PaginationParams {
  agent_id?: string | undefined;
  status?: RunStatus | undefined;
}

// --- Pagination ---

export interface PaginationParams {
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface PaginatedResponse<T> {
  data: T[];
  limit: number;
  offset: number;
  has_more: boolean;
}

// --- Connectors (Composio) ---

export interface ConnectorInfo {
  slug: string;
  name: string;
  logo: string;
  auth_scheme: string;
  connected: boolean;
}

export interface SaveConnectorApiKeyParams {
  toolkit: string;
  api_key: string;
}

/**
 * Composio OAuth result. Uses `redirect_url` (snake_case) to match the
 * Composio connector API wire format.
 */
export interface ConnectorOauthResult {
  redirect_url: string;
}

export interface ComposioToolkit {
  slug: string;
  name: string;
  logo: string;
}

export interface ComposioTool {
  slug: string;
  name: string;
  description: string;
}

// --- Custom Connectors (MCP) ---

export interface CustomConnectorServer {
  id: string;
  name: string;
  slug: string;
  description: string;
  logo_url: string | null;
  base_url: string;
  mcp_endpoint_path: string;
  client_id: string | null;
  oauth_metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface CustomConnectorConnection {
  id: string;
  tenant_id: string;
  agent_id: string;
  mcp_server_id: string;
  status: "initiated" | "active" | "expired" | "failed";
  granted_scopes: string[];
  allowed_tools: string[];
  token_expires_at: string | null;
  server_name: string;
  server_slug: string;
  server_logo_url: string | null;
  server_base_url: string;
  created_at: string;
  updated_at: string;
}

export interface CustomConnectorTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * MCP custom connector OAuth result. Uses `redirectUrl` (camelCase) to match
 * the MCP connection API wire format. Note: differs from ConnectorOauthResult
 * which uses snake_case — this reflects different upstream API conventions.
 */
export interface CustomConnectorOauthResult {
  redirectUrl: string;
}

// --- Plugin Marketplaces ---

export interface PluginMarketplace {
  id: string;
  name: string;
  github_repo: string;
  created_at: string;
  updated_at: string;
}

export interface PluginListItem {
  name: string;
  displayName: string;
  description: string | null;
  version: string | null;
  author: string | null;
  hasSkills: boolean;
  hasCommands: boolean;
  hasMcpJson: boolean;
}

// --- Stream Events ---

export interface RunStartedEvent {
  type: "run_started";
  run_id: string;
  agent_id: string;
  model: string;
  timestamp: string;
  mcp_server_count?: number | undefined;
  mcp_errors?: string[] | undefined;
}

export interface TextDeltaEvent {
  type: "text_delta";
  text: string;
}

export interface AssistantEvent {
  type: "assistant";
  [key: string]: unknown;
}

export interface ToolUseEvent {
  type: "tool_use";
  [key: string]: unknown;
}

export interface ToolResultEvent {
  type: "tool_result";
  [key: string]: unknown;
}

export interface ResultEvent {
  type: "result";
  subtype: string;
  total_cost_usd?: number | undefined;
  num_turns?: number | undefined;
  duration_ms?: number | undefined;
  duration_api_ms?: number | undefined;
  usage?: {
    input_tokens?: number | undefined;
    output_tokens?: number | undefined;
    cache_read_input_tokens?: number | undefined;
    cache_creation_input_tokens?: number | undefined;
  } | undefined;
  modelUsage?: unknown | undefined;
}

export interface ErrorEvent {
  type: "error";
  error: string;
  code?: string | undefined;
  timestamp?: string | undefined;
}

export interface StreamDetachedEvent {
  type: "stream_detached";
  poll_url: string;
  timestamp: string;
}

export interface UnknownEvent {
  type: string;
  [key: string]: unknown;
}

/** Events yielded to SDK consumers. Heartbeats are filtered internally. */
export type StreamEvent =
  | RunStartedEvent
  | TextDeltaEvent
  | AssistantEvent
  | ToolUseEvent
  | ToolResultEvent
  | ResultEvent
  | ErrorEvent
  | StreamDetachedEvent
  | UnknownEvent;

/** Internal: includes heartbeat (filtered before yielding). */
export type RawStreamEvent =
  | StreamEvent
  | { type: "heartbeat"; timestamp: string };

// --- Known Event Types ---

const KNOWN_EVENT_TYPES = new Set([
  "run_started",
  "text_delta",
  "assistant",
  "tool_use",
  "tool_result",
  "result",
  "error",
  "stream_detached",
  "heartbeat",
]);

/** Narrow a parsed NDJSON object to a typed StreamEvent (or null for heartbeats). */
export function narrowStreamEvent(raw: unknown): StreamEvent | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj["type"] !== "string") return null;

  // Filter heartbeats
  if (obj["type"] === "heartbeat") return null;

  // Known types pass through as-is; unknown types get UnknownEvent treatment
  return obj as StreamEvent;
}
