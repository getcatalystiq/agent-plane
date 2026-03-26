import type { AgentPlane } from "../client";
import type { SkillDirectoryEntry, SkillDirectoryTab, ImportedSkill } from "../types";

export class SkillsDirectoryResource {
  constructor(private readonly _client: AgentPlane) {}

  /** List skills from the skills.sh directory. */
  async list(tab: SkillDirectoryTab = "all"): Promise<SkillDirectoryEntry[]> {
    const resp = await this._client._request<{ data: SkillDirectoryEntry[] }>(
      "GET",
      "/api/skills-directory",
      { query: { tab } },
    );
    return resp.data;
  }

  /** Preview a skill's SKILL.md content (lightweight CDN call). */
  async preview(owner: string, repo: string, skill: string): Promise<string> {
    const resp = await this._client._request<{ data: { content: string } }>(
      "GET",
      "/api/skills-directory/preview",
      { query: { owner, repo, skill } },
    );
    return resp.data.content;
  }

  /** Import a skill's full content from GitHub. */
  async import(params: { owner: string; repo: string; skill_name: string } | { url: string }): Promise<ImportedSkill> {
    const resp = await this._client._request<{ data: ImportedSkill }>(
      "POST",
      "/api/skills-directory/import",
      { body: params },
    );
    return resp.data;
  }
}
