"use client";

import { useState, useCallback } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import { useApi } from "../../hooks/use-api";
import { useNavigation } from "../../hooks/use-navigation";
import { useAgentPlaneClient } from "../../hooks/use-client";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { FileTreeEditor } from "./file-tree-editor";
import type { FlatFile } from "./file-tree-editor";

interface PluginFilesData {
  skills: FlatFile[];
  agents: FlatFile[];
  mcpJson: string | null;
  isOwned: boolean;
}

export interface PluginEditorPageProps {
  marketplaceId: string;
  pluginName: string;
}

export function PluginEditorPage({ marketplaceId, pluginName }: PluginEditorPageProps) {
  const { LinkComponent, basePath } = useNavigation();
  const client = useAgentPlaneClient();

  const { data: pluginFiles, error, isLoading } = useApi<PluginFilesData>(
    `marketplace-${marketplaceId}-plugin-files-${pluginName}`,
    (c) => c.pluginMarketplaces.getPluginFiles(marketplaceId, pluginName) as Promise<PluginFilesData>,
  );

  const [skills, setSkills] = useState<FlatFile[]>([]);
  const [agents, setAgents] = useState<FlatFile[]>([]);
  const [mcpJson, setMcpJson] = useState("");
  const [activeTab, setActiveTab] = useState<"agents" | "skills" | "connectors">("agents");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [success, setSuccess] = useState("");
  const [savedVersion, setSavedVersion] = useState(0);
  const [initialized, setInitialized] = useState(false);

  // Initialize state from fetched data (once)
  if (pluginFiles && !initialized) {
    setSkills(pluginFiles.skills);
    setAgents(pluginFiles.agents);
    setMcpJson(pluginFiles.mcpJson ?? "");
    setInitialized(true);
  }

  const readOnly = pluginFiles ? !pluginFiles.isOwned : true;

  const handleSkillsChange = useCallback((updated: FlatFile[]) => {
    setSkills(updated);
  }, []);

  const handleAgentsChange = useCallback((updated: FlatFile[]) => {
    setAgents(updated);
  }, []);

  const noopSave = useCallback(async () => {}, []);

  async function handleSaveAll() {
    setSaving(true);
    setSaveError("");
    setSuccess("");

    try {
      const result = await client.pluginMarketplaces.savePluginFiles(
        marketplaceId,
        pluginName,
        {
          skills,
          agents,
          mcpJson: mcpJson || null,
        },
      ) as { commitSha: string };

      setSuccess(`Saved (commit ${result.commitSha.slice(0, 7)})`);
      setSavedVersion((v) => v + 1);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <p className="text-destructive">Failed to load plugin files: {error.message}</p>
      </div>
    );
  }

  if (isLoading || !pluginFiles) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-[500px] rounded-lg" />
      </div>
    );
  }

  const tabs = [
    { id: "agents" as const, label: "Agents", count: agents.length },
    { id: "skills" as const, label: "Skills", count: skills.length },
    { id: "connectors" as const, label: "Connectors", count: mcpJson ? 1 : 0 },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-1">
          <LinkComponent
            href={`${basePath}/plugin-marketplaces/${marketplaceId}`}
            className="text-muted-foreground hover:text-foreground text-sm"
          >
            &larr; Back to marketplace
          </LinkComponent>
        </div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{pluginName}</h1>
          {readOnly ? (
            <Badge variant="outline">Read-only</Badge>
          ) : (
            <Badge variant="secondary">Editable</Badge>
          )}
        </div>
      </div>

      {/* Tab bar + Save button */}
      <div className="flex items-end border-b border-border">
        <div className="flex gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/50"
              }`}
            >
              {tab.label}
              {tab.count > 0 && (
                <span className="ml-1.5 text-xs text-muted-foreground">({tab.count})</span>
              )}
            </button>
          ))}
        </div>
        {!readOnly && (
          <div className="flex items-center gap-3 ml-auto pb-2">
            {saveError && <span className="text-xs text-destructive">{saveError}</span>}
            {success && <span className="text-xs text-green-500">{success}</span>}
            <Button size="sm" onClick={handleSaveAll} disabled={saving}>
              {saving ? "Pushing to GitHub..." : "Save All to GitHub"}
            </Button>
          </div>
        )}
      </div>

      {/* Tab content */}
      {activeTab === "agents" && (
        <FileTreeEditor
          initialFiles={pluginFiles.agents}
          onSave={noopSave}
          onChange={readOnly ? undefined : handleAgentsChange}
          readOnly={readOnly}
          hideSave={!readOnly}
          title="Agents"
          addFolderLabel="Agent"
          newFileTemplate={{ filename: "agent.md", content: "---\nname: new-agent\ndescription: Describe what this agent does\n---\n\nYou are a specialized agent.\n" }}
          savedVersion={savedVersion}
        />
      )}

      {activeTab === "skills" && (
        <FileTreeEditor
          initialFiles={pluginFiles.skills}
          onSave={noopSave}
          onChange={readOnly ? undefined : handleSkillsChange}
          readOnly={readOnly}
          hideSave={!readOnly}
          title="Skills"
          addFolderLabel="Skill"
          newFileTemplate={{ filename: "SKILL.md", content: "# New\n\nDescribe this skill...\n" }}
          savedVersion={savedVersion}
        />
      )}

      {activeTab === "connectors" && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="flex items-center gap-3">
              <CardTitle className="text-base">Connectors (.mcp.json)</CardTitle>
              {readOnly && <Badge variant="secondary" className="text-xs">Read-only</Badge>}
            </div>
          </CardHeader>
          <CardContent>
            <div className="border border-border rounded-md overflow-hidden">
              <div className="px-3 py-1.5 bg-muted/50 border-b border-border text-xs text-muted-foreground">
                .mcp.json
              </div>
              <CodeMirror
                value={mcpJson}
                onChange={(val) => !readOnly && setMcpJson(val)}
                readOnly={readOnly}
                theme={oneDark}
                extensions={[json()]}
                height="200px"
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: true,
                  bracketMatching: true,
                }}
              />
            </div>
            {!mcpJson && !readOnly && (
              <p className="text-xs text-muted-foreground mt-2">
                No .mcp.json found. Add connector definitions to suggest MCP servers for agents using this plugin.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
