import type { AgentPlane } from "../client";
import type {
  Agent,
  CreateAgentParams,
  UpdateAgentParams,
  PaginationParams,
  PaginatedResponse,
} from "../types";

export class AgentsResource {
  constructor(private readonly _client: AgentPlane) {}

  /** Create a new agent. */
  async create(params: CreateAgentParams): Promise<Agent> {
    return this._client._request<Agent>("POST", "/api/agents", { body: params });
  }

  /** Get an agent by ID. */
  async get(agentId: string): Promise<Agent> {
    return this._client._request<Agent>("GET", `/api/agents/${agentId}`);
  }

  /** List agents with optional pagination. */
  async list(params?: PaginationParams): Promise<PaginatedResponse<Agent>> {
    const query: Record<string, string | number | undefined> = {
      limit: params?.limit,
      offset: params?.offset,
    };

    const response = await this._client._request<{ data: Agent[]; limit: number; offset: number }>(
      "GET",
      "/api/agents",
      { query },
    );

    return {
      ...response,
      has_more: response.data.length === response.limit,
    };
  }

  /** Update an agent (partial update). */
  async update(agentId: string, params: UpdateAgentParams): Promise<Agent> {
    return this._client._request<Agent>("PUT", `/api/agents/${agentId}`, { body: params });
  }

  /** Delete an agent. */
  async delete(agentId: string): Promise<void> {
    await this._client._request<unknown>("DELETE", `/api/agents/${agentId}`);
  }
}
