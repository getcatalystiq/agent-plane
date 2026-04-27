export type { RunnerType } from "./models";

// Branded types to prevent parameter swaps at compile time
export type TenantId = string & { readonly __brand: "TenantId" };
export type AgentId = string & { readonly __brand: "AgentId" };
export type AgentSlug = string & { readonly __brand: "AgentSlug" };
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

// Mirrors the SDK's published auth-scheme enum
// (node_modules/@composio/client/resources/auth-configs.d.ts).
export type AuthScheme =
  | "OAUTH2"
  | "OAUTH1"
  | "API_KEY"
  | "BEARER_TOKEN"
  | "NO_AUTH"
  | "BASIC"
  | "BASIC_WITH_JWT"
  | "BILLCOM_AUTH"
  | "CALCOM_AUTH"
  | "GOOGLE_SERVICE_ACCOUNT"
  | "SERVICE_ACCOUNT"
  | "SAML"
  | "DCR_OAUTH"
  | "OTHER";

// User's chosen connect mode. Independent of AuthScheme: OAUTH2 covers both
// Composio-managed and bring-your-own-app flows; the distinction lives here.
export type AuthMethod = "composio_oauth" | "byoa_oauth" | "custom_token";

// The set of methods we render in the picker. Other methods (BASIC, JWT
// variants, vendor-specific) are detected but hidden from the UI.
export const SUPPORTED_AUTH_METHODS: readonly AuthMethod[] = [
  "composio_oauth",
  "byoa_oauth",
  "custom_token",
] as const;

// Per-toolkit connection metadata persisted in agents.composio_connection_metadata.
export interface ConnectionMetadata {
  auth_method: AuthMethod;
  auth_scheme: AuthScheme;
  bot_user_id: string | null;
  display_name: string | null;
  captured_at: string | null;
  capture_deferred?: boolean;
}

export interface WhoamiResult {
  bot_user_id: string;
  display_name: string;
}

export interface TenantConnectorInfo {
  slug: string;
  name: string;
  logo: string;
  /** @deprecated Use `available_schemes` + `selected_method`. Retained one release for SDK consumers. */
  auth_scheme: AuthScheme;
  available_schemes: AuthScheme[];
  selected_method: AuthMethod | null;
  bot_user_id: string | null;
  display_name: string | null;
  capture_deferred: boolean;
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

export type { AgentIdentity } from "@/lib/identity";

