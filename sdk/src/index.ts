// Client
export { AgentPlane } from "./client";

// Types
export type {
  AgentPlaneOptions,
  Agent,
  AgentSkill,
  AgentSkillFile,
  AgentPlugin,
  PermissionMode,
  CreateAgentParams,
  UpdateAgentParams,
  Run,
  RunStatus,
  CreateRunParams,
  ListRunsParams,
  PaginationParams,
  PaginatedResponse,
  // Connectors (Composio)
  ConnectorInfo,
  SaveConnectorApiKeyParams,
  ConnectorOauthResult,
  ComposioToolkit,
  ComposioTool,
  // Custom Connectors (MCP)
  CustomConnectorServer,
  CustomConnectorConnection,
  CustomConnectorTool,
  CustomConnectorOauthResult,
  // Plugin Marketplaces
  PluginMarketplace,
  PluginListItem,
  // Stream Events
  StreamEvent,
  RunStartedEvent,
  TextDeltaEvent,
  AssistantEvent,
  ToolUseEvent,
  ToolResultEvent,
  ResultEvent,
  ErrorEvent,
  StreamDetachedEvent,
  UnknownEvent,
} from "./types";

// Errors
export { AgentPlaneError, StreamDisconnectedError } from "./errors";

// Streaming
export { RunStream } from "./streaming";
