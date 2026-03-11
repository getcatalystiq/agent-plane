// Branded types to prevent parameter swaps at compile time
export type TenantId = string & { readonly __brand: "TenantId" };
export type AgentId = string & { readonly __brand: "AgentId" };
export type RunId = string & { readonly __brand: "RunId" };
export type McpServerId = string & { readonly __brand: "McpServerId" };
export type McpConnectionId = string & { readonly __brand: "McpConnectionId" };
export type PluginMarketplaceId = string & { readonly __brand: "PluginMarketplaceId" };
export type ScheduleId = string & { readonly __brand: "ScheduleId" };
export type SessionId = string & { readonly __brand: "SessionId" };

export interface AgentPlugin {
  marketplace_id: PluginMarketplaceId;
  plugin_name: string;
}

export type ScheduleFrequency = "manual" | "hourly" | "daily" | "weekdays" | "weekly";
export type RunTriggeredBy = "api" | "schedule" | "playground" | "chat" | "a2a";

export type SessionStatus = "creating" | "active" | "idle" | "stopped";

export type ScheduleConfig =
  | { frequency: "manual" }
  | { frequency: "hourly" }
  | { frequency: "daily"; time: string }
  | { frequency: "weekdays"; time: string }
  | { frequency: "weekly"; time: string; dayOfWeek: number };

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type AuthScheme = "OAUTH2" | "OAUTH1" | "API_KEY" | "NO_AUTH" | "OTHER";

export interface TenantConnectorInfo {
  slug: string;
  name: string;
  logo: string;
  auth_scheme: AuthScheme;
  connected: boolean;
}

export type McpConnectionStatus = "initiated" | "active" | "expired" | "failed";

export interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface ClientRegistrationMetadata {
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
}

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
}

export const VALID_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  pending: ["running", "failed", "cancelled"],
  running: ["completed", "failed", "cancelled", "timed_out"],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export const SESSION_VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  creating: ["active", "idle", "stopped"],
  active: ["idle", "stopped"],
  idle: ["active", "stopped"],
  stopped: [],
};

