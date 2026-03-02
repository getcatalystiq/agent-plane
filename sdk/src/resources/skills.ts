import type { AgentPlane } from "../client";
import type { AgentSkill, AgentSkillFile } from "../types";

export class SkillsResource {
  constructor(private readonly _client: AgentPlane) {}

  /** List all skills for an agent. */
  async list(agentId: string): Promise<AgentSkill[]> {
    const resp = await this._client._request<{ data: AgentSkill[] }>(
      "GET",
      `/api/agents/${agentId}/skills`,
    );
    return resp.data;
  }

  /** Get a single skill by folder name. */
  async get(agentId: string, folder: string): Promise<AgentSkill> {
    return this._client._request<AgentSkill>(
      "GET",
      `/api/agents/${agentId}/skills/${encodeURIComponent(folder)}`,
    );
  }

  /** Create a new skill. */
  async create(agentId: string, skill: AgentSkill): Promise<AgentSkill> {
    return this._client._request<AgentSkill>("POST", `/api/agents/${agentId}/skills`, {
      body: skill,
    });
  }

  /** Update a skill's files. */
  async update(
    agentId: string,
    folder: string,
    params: { files: AgentSkillFile[] },
  ): Promise<AgentSkill> {
    return this._client._request<AgentSkill>(
      "PUT",
      `/api/agents/${agentId}/skills/${encodeURIComponent(folder)}`,
      { body: params },
    );
  }

  /** Delete a skill. */
  async delete(agentId: string, folder: string): Promise<void> {
    await this._client._request<unknown>(
      "DELETE",
      `/api/agents/${agentId}/skills/${encodeURIComponent(folder)}`,
    );
  }
}
