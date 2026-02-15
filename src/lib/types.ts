// Branded types to prevent parameter swaps at compile time
export type TenantId = string & { readonly __brand: "TenantId" };
export type AgentId = string & { readonly __brand: "AgentId" };
export type RunId = string & { readonly __brand: "RunId" };
export type ApiKeyId = string & { readonly __brand: "ApiKeyId" };

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type TenantStatus = "active" | "suspended";

export type LlmProvider = "anthropic" | "bedrock";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

export const VALID_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  pending: ["running", "failed"],
  running: ["completed", "failed", "cancelled", "timed_out"],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export interface Tenant {
  id: TenantId;
  name: string;
  slug: string;
  settings: Record<string, unknown>;
  monthly_budget_usd: number;
  status: TenantStatus;
  current_month_spend: number;
  spend_period_start: string;
  created_at: string;
}

export interface ApiKey {
  id: ApiKeyId;
  tenant_id: TenantId;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface Agent {
  id: AgentId;
  tenant_id: TenantId;
  name: string;
  description: string | null;
  git_repo_url: string | null;
  git_branch: string;
  composio_toolkits: string[];
  model: string;
  allowed_tools: string[];
  permission_mode: PermissionMode;
  max_turns: number;
  max_budget_usd: number;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: RunId;
  agent_id: AgentId;
  tenant_id: TenantId;
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
  model_usage: Record<string, unknown> | null;
  transcript_blob_url: string | null;
  error_type: string | null;
  error_messages: string[];
  sandbox_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export type StreamEvent =
  | {
      type: "run_started";
      run_id: string;
      agent_id: string;
      model: string;
      timestamp: string;
    }
  | {
      type: "system";
      session_id: string;
      tools: string[];
      mcp_servers: string[];
    }
  | {
      type: "assistant";
      message: { id: string; content: unknown[]; usage: unknown };
      uuid: string;
    }
  | {
      type: "tool_use";
      tool_name: string;
      tool_input: unknown;
      uuid: string;
      timestamp: string;
    }
  | {
      type: "tool_result";
      tool_name: string;
      output: string;
      uuid: string;
      timestamp: string;
    }
  | { type: "heartbeat"; timestamp: string }
  | {
      type: "error";
      error: string;
      code?: string;
      recoverable?: boolean;
      timestamp: string;
    }
  | {
      type: "result";
      subtype:
        | "success"
        | "error_max_turns"
        | "error_max_budget_usd"
        | "error_during_execution";
      cost_usd: number;
      duration_ms: number;
      num_turns: number;
      usage: unknown;
      model_usage: unknown;
    }
  | { type: "stream_detached"; poll_url: string; timestamp: string };
