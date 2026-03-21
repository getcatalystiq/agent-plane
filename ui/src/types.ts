/**
 * Structural interface for the AgentPlane SDK client.
 * Declares all methods the UI actually uses, avoiding a hard compile-time
 * dependency on `@getcatalystiq/agent-plane` (which is a peer dependency and
 * may not be installed in all development environments).
 */
export interface AgentPlaneClient {
  agents: {
    list(params?: { limit?: number; offset?: number }): Promise<unknown>;
    get(agentId: string): Promise<unknown>;
    create(params: Record<string, unknown>): Promise<unknown>;
    update(agentId: string, params: Record<string, unknown>): Promise<unknown>;
    delete(agentId: string): Promise<void>;
    skills: {
      list(agentId: string): Promise<unknown[]>;
      get(agentId: string, folder: string): Promise<unknown>;
      create(agentId: string, skill: Record<string, unknown>): Promise<unknown>;
      update(agentId: string, folder: string, params: Record<string, unknown>): Promise<unknown>;
      delete(agentId: string, folder: string): Promise<void>;
    };
    plugins: {
      list(agentId: string): Promise<unknown[]>;
      add(agentId: string, plugin: Record<string, unknown>): Promise<unknown>;
      remove(agentId: string, marketplaceId: string, pluginName: string): Promise<void>;
    };
  };
  runs: {
    list(params?: Record<string, unknown>): Promise<unknown>;
    get(runId: string): Promise<unknown>;
    cancel(runId: string): Promise<unknown>;
    transcript(runId: string): Promise<unknown>;
    transcriptArray(runId: string): Promise<unknown[]>;
  };
  sessions: {
    list(params?: Record<string, unknown>): Promise<unknown>;
    get(sessionId: string): Promise<unknown>;
    stop(sessionId: string): Promise<unknown>;
  };
  connectors: {
    list(agentId: string): Promise<unknown[]>;
    saveApiKey(agentId: string, params: { toolkit: string; api_key: string }): Promise<unknown>;
    initiateOauth(agentId: string, toolkit: string): Promise<{ redirect_url: string }>;
    availableToolkits(): Promise<unknown[]>;
    availableTools(toolkit: string): Promise<unknown[]>;
  };
  customConnectors: {
    listServers(): Promise<unknown[]>;
    createServer(params: Record<string, unknown>): Promise<unknown>;
    updateServer(serverId: string, params: Record<string, unknown>): Promise<unknown>;
    deleteServer(serverId: string): Promise<void>;
    list(agentId: string): Promise<unknown[]>;
    delete(agentId: string, serverId: string): Promise<void>;
    updateAllowedTools(agentId: string, serverId: string, allowedTools: string[]): Promise<void>;
    listTools(agentId: string, serverId: string): Promise<unknown[]>;
    initiateOauth(agentId: string, serverId: string): Promise<{ redirectUrl: string }>;
  };
  models: {
    list(): Promise<unknown[]>;
  };
  dashboard: {
    stats(): Promise<unknown>;
    charts(params?: { days?: number }): Promise<unknown[]>;
  };
  tenants: {
    getMe(): Promise<unknown>;
    updateMe(params: Record<string, unknown>): Promise<unknown>;
    deleteMe?(): Promise<void>;
  };
  keys: {
    list?(): Promise<unknown[]>;
    create?(params: { name: string }): Promise<unknown>;
    revoke?(keyId: string): Promise<void>;
  };
  composio: {
    toolkits(): Promise<unknown[]>;
    tools(toolkit: string): Promise<unknown[]>;
  };
  pluginMarketplaces: {
    list(): Promise<unknown[]>;
    get(marketplaceId: string): Promise<unknown>;
    listPlugins(marketplaceId: string): Promise<unknown[]>;
    getPlugin(marketplaceId: string, pluginName: string): Promise<unknown>;
    create(params: Record<string, unknown>): Promise<unknown>;
    delete(marketplaceId: string): Promise<void>;
    updateToken(marketplaceId: string, params: Record<string, unknown>): Promise<unknown>;
  };
}

export interface LinkComponentProps {
  href: string;
  children: React.ReactNode;
  className?: string;
}

export interface NavigationProps {
  onNavigate: (path: string) => void;
  LinkComponent?: React.ComponentType<LinkComponentProps>;
  basePath?: string;
}

export interface AgentPlaneProviderProps extends NavigationProps {
  client: AgentPlaneClient;
  onAuthError?: ((error: Error) => void) | undefined;
  children: React.ReactNode;
}
