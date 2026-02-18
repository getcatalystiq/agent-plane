// Branded types to prevent parameter swaps at compile time
export type TenantId = string & { readonly __brand: "TenantId" };
export type AgentId = string & { readonly __brand: "AgentId" };
export type RunId = string & { readonly __brand: "RunId" };

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

export const VALID_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  pending: ["running", "failed", "cancelled"],
  running: ["completed", "failed", "cancelled", "timed_out"],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

