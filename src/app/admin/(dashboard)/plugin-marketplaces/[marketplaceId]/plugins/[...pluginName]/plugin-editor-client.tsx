"use client";

import { useState, useCallback } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FileTreeEditor } from "@/components/file-tree-editor";
import type { FlatFile } from "@/components/file-tree-editor";

interface PluginEditorClientProps {
  marketplaceId: string;
  pluginName: string;
  initialSkills: FlatFile[];
  initialAgents: FlatFile[];
  initialMcpJson: string | null;
  readOnly: boolean;
}

export function PluginEditorClient({
  marketplaceId,
  pluginName,
  initialSkills,
  initialAgents,
  initialMcpJson,
  readOnly,
}: PluginEditorClientProps) {
  const [skills, setSkills] = useState(initialSkills);
  const [agents, setAgents] = useState(initialAgents);
  const [mcpJson, setMcpJson] = useState(initialMcpJson ?? "");
  const [activeTab, setActiveTab] = useState<"agents" | "skills" | "connectors">("agents");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [savedVersion, setSavedVersion] = useState(0);

  const handleSkillsChange = useCallback((updated: FlatFile[]) => {
    setSkills(updated);
  }, []);

  const handleAgentsChange = useCallback((updated: FlatFile[]) => {
    setAgents(updated);
  }, []);

  // No-op save handlers since we use hideSave + onChange
  const noopSave = useCallback(async () => {}, []);

  async function handleSaveAll() {
    setSaving(true);
    setError("");
    setSuccess("");

    try {
      const res = await fetch(`/api/admin/plugin-marketplaces/${marketplaceId}/plugins/${pluginName}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skills,
          agents,
          mcpJson: mcpJson || null,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error?.message ?? `Error ${res.status}`);
        return;
      }

      const data = await res.json();
      setSuccess(`Saved (commit ${data.commitSha.slice(0, 7)})`);
      setSavedVersion((v) => v + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  const tabs = [
    { id: "agents" as const, label: "Agents", count: agents.length },
    { id: "skills" as const, label: "Skills", count: skills.length },
    { id: "connectors" as const, label: "Connectors", count: mcpJson ? 1 : 0 },
  ];
  return (
    <div className="space-y-4">
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
            {error && <span className="text-xs text-destructive">{error}</span>}
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
          initialFiles={initialAgents}
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
          initialFiles={initialSkills}
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
