"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FileTreeEditor } from "@/components/file-tree-editor";
import type { FileTreeFolder } from "@/components/file-tree-editor";

interface PluginEditorClientProps {
  marketplaceId: string;
  pluginName: string;
  initialSkills: FileTreeFolder[];
  initialCommands: FileTreeFolder[];
  initialMcpJson: string | null;
  readOnly: boolean;
}

export function PluginEditorClient({
  marketplaceId,
  pluginName,
  initialSkills,
  initialCommands,
  initialMcpJson,
  readOnly,
}: PluginEditorClientProps) {
  const router = useRouter();
  const [skills, setSkills] = useState(initialSkills);
  const [commands, setCommands] = useState(initialCommands);
  const [mcpJson, setMcpJson] = useState(initialMcpJson ?? "");
  const [activeTab, setActiveTab] = useState<"skills" | "commands" | "connectors">("skills");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const handleSkillsChange = useCallback((updated: FileTreeFolder[]) => {
    setSkills(updated);
  }, []);

  const handleCommandsChange = useCallback((updated: FileTreeFolder[]) => {
    setCommands(updated);
  }, []);

  // No-op save handlers since we use hideSave + onChange
  const noopSave = useCallback(async () => {}, []);

  async function handleSaveAll() {
    setSaving(true);
    setError("");
    setSuccess("");

    // Flatten folder structure back to flat file list
    const skillFiles = skills.flatMap(folder =>
      folder.files.map(f => ({
        path: folder.folder === "(root)" ? f.path : `${folder.folder}/${f.path}`,
        content: f.content,
      })),
    );
    const commandFiles = commands.flatMap(folder =>
      folder.files.map(f => ({
        path: folder.folder === "(root)" ? f.path : `${folder.folder}/${f.path}`,
        content: f.content,
      })),
    );

    try {
      const res = await fetch(`/api/admin/plugin-marketplaces/${marketplaceId}/plugins/${pluginName}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skills: skillFiles,
          commands: commandFiles,
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
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  const tabs = [
    { id: "skills" as const, label: "Skills", count: skills.reduce((n, f) => n + f.files.length, 0) },
    { id: "commands" as const, label: "Commands", count: commands.reduce((n, f) => n + f.files.length, 0) },
    { id: "connectors" as const, label: "Connectors", count: mcpJson ? 1 : 0 },
  ];
  return (
    <div className="space-y-4">
      {/* Save All button for owned plugins */}
      {!readOnly && (
        <div className="flex items-center gap-3">
          <Button onClick={handleSaveAll} disabled={saving}>
            {saving ? "Pushing to GitHub..." : "Save All to GitHub"}
          </Button>
          {error && <span className="text-xs text-red-500">{error}</span>}
          {success && <span className="text-xs text-green-500">{success}</span>}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border">
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

      {/* Tab content */}
      {activeTab === "skills" && (
        <FileTreeEditor
          initialFiles={initialSkills}
          onSave={noopSave}
          onChange={readOnly ? undefined : handleSkillsChange}
          readOnly={readOnly}
          hideSave={!readOnly}
          title="Skills"
          addFolderLabel="Skill"
          newFolderTemplate={{ path: "SKILL.md", content: "# New\n\nDescribe this skill...\n" }}
        />
      )}

      {activeTab === "commands" && (
        <FileTreeEditor
          initialFiles={initialCommands}
          onSave={noopSave}
          onChange={readOnly ? undefined : handleCommandsChange}
          readOnly={readOnly}
          hideSave={!readOnly}
          title="Commands"
          addFolderLabel="Command"
          newFolderTemplate={{ path: "command.md", content: "# New Command\n\nDescribe this command...\n" }}
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
