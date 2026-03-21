"use client";

import { useState, useCallback } from "react";
import { useApi } from "../../hooks/use-api";
import { useNavigation } from "../../hooks/use-navigation";
import { useAgentPlaneClient } from "../../hooks/use-client";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { Tabs } from "../ui/tabs";

interface PluginAgentMeta {
  filename: string;
  name: string;
  description: string | null;
}

interface PluginDetailData {
  name: string;
  displayName: string;
  description: string | null;
  version: string | null;
  agents: PluginAgentMeta[];
  skills: string[];
  hasMcpJson: boolean;
}

interface PluginFileData {
  path: string;
  content: string;
}

interface PluginFilesData {
  skills: PluginFileData[];
  agents: PluginFileData[];
  mcpJson: string | null;
  isOwned: boolean;
}

export interface PluginDetailPageProps {
  marketplaceId: string;
  pluginName: string;
}

function AgentsTab({
  agents,
  onSelectAgent,
  selectedFilename,
}: {
  agents: PluginAgentMeta[];
  onSelectAgent: (filename: string) => void;
  selectedFilename: string | null;
}) {
  if (agents.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">No agents defined in this plugin.</p>;
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {agents.map((agent) => (
        <Card
          key={agent.filename}
          className={`cursor-pointer transition-colors hover:border-primary/50 ${
            selectedFilename === agent.filename ? "border-primary ring-1 ring-primary/30" : ""
          }`}
          onClick={() => onSelectAgent(agent.filename)}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{agent.name}</CardTitle>
          </CardHeader>
          <CardContent>
            {agent.description ? (
              <p className="text-xs text-muted-foreground">{agent.description}</p>
            ) : (
              <p className="text-xs text-muted-foreground italic">No description</p>
            )}
            <p className="text-xs text-muted-foreground/60 mt-2 font-mono">{agent.filename}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function SkillsTab({
  skills,
  onSelectSkill,
  selectedSkill,
}: {
  skills: string[];
  onSelectSkill: (skill: string) => void;
  selectedSkill: string | null;
}) {
  if (skills.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">No skills defined in this plugin.</p>;
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {skills.map((skill) => (
        <Card
          key={skill}
          className={`cursor-pointer transition-colors hover:border-primary/50 ${
            selectedSkill === skill ? "border-primary ring-1 ring-primary/30" : ""
          }`}
          onClick={() => onSelectSkill(skill)}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{skill}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground font-mono">skills/{skill}/</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ConnectorsTab({
  hasMcpJson,
  mcpJsonContent,
  onSelectConnector,
  selected,
}: {
  hasMcpJson: boolean;
  mcpJsonContent: string | null;
  onSelectConnector: () => void;
  selected: boolean;
}) {
  if (!hasMcpJson) {
    return <p className="text-sm text-muted-foreground py-4">No connectors defined in this plugin.</p>;
  }
  return (
    <Card
      className={`cursor-pointer transition-colors hover:border-primary/50 ${
        selected ? "border-primary ring-1 ring-primary/30" : ""
      }`}
      onClick={onSelectConnector}
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">.mcp.json</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">
          This plugin includes an MCP connector configuration that will be suggested to agents using it.
        </p>
      </CardContent>
    </Card>
  );
}

interface FileEditorInlineProps {
  filePath: string;
  content: string;
  onChange: (content: string) => void;
  onSave: () => void;
  onClose: () => void;
  saving: boolean;
  saveError: string;
  saveSuccess: string;
  readOnly: boolean;
}

function FileEditorInline({
  filePath,
  content,
  onChange,
  onSave,
  onClose,
  saving,
  saveError,
  saveSuccess,
  readOnly,
}: FileEditorInlineProps) {
  return (
    <div className="mt-4 border border-border rounded-md overflow-hidden">
      <div className="px-3 py-2 bg-muted/50 border-b border-border flex items-center justify-between">
        <span className="text-xs text-muted-foreground font-mono">{filePath}</span>
        <div className="flex items-center gap-2">
          {saveError && <span className="text-xs text-destructive">{saveError}</span>}
          {saveSuccess && <span className="text-xs text-green-500">{saveSuccess}</span>}
          {!readOnly && (
            <Button size="sm" onClick={onSave} disabled={saving} className="h-7 text-xs">
              {saving ? "Saving..." : "Save"}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose} className="h-7 text-xs">
            Close
          </Button>
        </div>
      </div>
      <textarea
        value={content}
        onChange={(e) => onChange(e.target.value)}
        readOnly={readOnly}
        className="w-full min-h-[400px] p-3 bg-background text-foreground text-sm font-mono resize-y focus:outline-none"
        spellCheck={false}
      />
    </div>
  );
}

export function PluginDetailPage({ marketplaceId, pluginName }: PluginDetailPageProps) {
  const { LinkComponent, basePath } = useNavigation();
  const client = useAgentPlaneClient();

  const { data: plugin, error, isLoading } = useApi<PluginDetailData>(
    `marketplace-${marketplaceId}-plugin-${pluginName}`,
    (c) => c.pluginMarketplaces.getPlugin(marketplaceId, pluginName) as Promise<PluginDetailData>,
  );

  // Editor state
  const [editorState, setEditorState] = useState<{
    type: "agent" | "skill" | "connector";
    identifier: string; // filename for agent, folder for skill, ".mcp.json" for connector
  } | null>(null);

  const [pluginFiles, setPluginFiles] = useState<PluginFilesData | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState("");
  const [editedContent, setEditedContent] = useState<Map<string, string>>(new Map());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveSuccess, setSaveSuccess] = useState("");

  const fetchFiles = useCallback(async () => {
    if (pluginFiles) return pluginFiles;
    setFilesLoading(true);
    setFilesError("");
    try {
      const files = await client.pluginMarketplaces.getPluginFiles(marketplaceId, pluginName) as PluginFilesData;
      setPluginFiles(files);
      return files;
    } catch (err) {
      setFilesError(err instanceof Error ? err.message : "Failed to load files");
      return null;
    } finally {
      setFilesLoading(false);
    }
  }, [client, marketplaceId, pluginName, pluginFiles]);

  const handleSelectAgent = useCallback(async (filename: string) => {
    if (editorState?.type === "agent" && editorState.identifier === filename) {
      setEditorState(null);
      return;
    }
    setSaveError("");
    setSaveSuccess("");
    const files = await fetchFiles();
    if (files) {
      setEditorState({ type: "agent", identifier: filename });
    }
  }, [editorState, fetchFiles]);

  const handleSelectSkill = useCallback(async (skill: string) => {
    if (editorState?.type === "skill" && editorState.identifier === skill) {
      setEditorState(null);
      return;
    }
    setSaveError("");
    setSaveSuccess("");
    const files = await fetchFiles();
    if (files) {
      setEditorState({ type: "skill", identifier: skill });
    }
  }, [editorState, fetchFiles]);

  const handleSelectConnector = useCallback(async () => {
    if (editorState?.type === "connector") {
      setEditorState(null);
      return;
    }
    setSaveError("");
    setSaveSuccess("");
    const files = await fetchFiles();
    if (files) {
      setEditorState({ type: "connector", identifier: ".mcp.json" });
    }
  }, [editorState, fetchFiles]);

  // Get the currently edited file path and content
  function getEditorFile(): { path: string; content: string } | null {
    if (!editorState || !pluginFiles) return null;

    if (editorState.type === "agent") {
      const file = pluginFiles.agents.find(f => f.path === editorState.identifier);
      if (!file) return null;
      const editedKey = `agents/${file.path}`;
      return {
        path: `agents/${file.path}`,
        content: editedContent.has(editedKey) ? editedContent.get(editedKey)! : file.content,
      };
    }

    if (editorState.type === "skill") {
      // Find all files in this skill folder
      const skillFiles = pluginFiles.skills.filter(f => f.path.startsWith(editorState.identifier + "/") || f.path === editorState.identifier);
      // Use the first file (usually SKILL.md)
      const file = skillFiles.length > 0 ? skillFiles[0] : null;
      if (!file) return null;
      const editedKey = `skills/${file.path}`;
      return {
        path: `skills/${file.path}`,
        content: editedContent.has(editedKey) ? editedContent.get(editedKey)! : file.content,
      };
    }

    if (editorState.type === "connector") {
      const editedKey = ".mcp.json";
      return {
        path: ".mcp.json",
        content: editedContent.has(editedKey) ? editedContent.get(editedKey)! : (pluginFiles.mcpJson ?? ""),
      };
    }

    return null;
  }

  function handleContentChange(content: string) {
    const file = getEditorFile();
    if (!file) return;
    setEditedContent(prev => new Map(prev).set(file.path, content));
  }

  async function handleSave() {
    if (!pluginFiles) return;
    setSaving(true);
    setSaveError("");
    setSaveSuccess("");

    // Apply edited content back to pluginFiles
    const updatedSkills = pluginFiles.skills.map(f => {
      const key = `skills/${f.path}`;
      return editedContent.has(key) ? { ...f, content: editedContent.get(key)! } : f;
    });
    const updatedAgents = pluginFiles.agents.map(f => {
      const key = `agents/${f.path}`;
      return editedContent.has(key) ? { ...f, content: editedContent.get(key)! } : f;
    });
    const updatedMcpJson = editedContent.has(".mcp.json")
      ? editedContent.get(".mcp.json")!
      : pluginFiles.mcpJson;

    try {
      const result = await client.pluginMarketplaces.savePluginFiles(
        marketplaceId,
        pluginName,
        {
          skills: updatedSkills,
          agents: updatedAgents,
          mcpJson: updatedMcpJson || null,
        },
      ) as { commitSha: string };

      // Update the cached files
      setPluginFiles({
        ...pluginFiles,
        skills: updatedSkills,
        agents: updatedAgents,
        mcpJson: updatedMcpJson ?? null,
      });
      setEditedContent(new Map());
      setSaveSuccess(`Saved (commit ${result.commitSha.slice(0, 7)})`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <p className="text-destructive">Failed to load plugin: {error.message}</p>
      </div>
    );
  }

  if (isLoading || !plugin) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  const readOnly = pluginFiles ? !pluginFiles.isOwned : true;
  const editorFile = getEditorFile();

  const tabs = [
    {
      label: `Agents (${plugin.agents.length})`,
      content: (
        <>
          <AgentsTab
            agents={plugin.agents}
            onSelectAgent={handleSelectAgent}
            selectedFilename={editorState?.type === "agent" ? editorState.identifier : null}
          />
          {editorState?.type === "agent" && editorFile && (
            filesLoading ? (
              <div className="mt-4"><Skeleton className="h-[400px] rounded-md" /></div>
            ) : filesError ? (
              <p className="mt-4 text-sm text-destructive">{filesError}</p>
            ) : (
              <FileEditorInline
                filePath={editorFile.path}
                content={editorFile.content}
                onChange={handleContentChange}
                onSave={handleSave}
                onClose={() => setEditorState(null)}
                saving={saving}
                saveError={saveError}
                saveSuccess={saveSuccess}
                readOnly={readOnly}
              />
            )
          )}
        </>
      ),
    },
    {
      label: `Skills (${plugin.skills.length})`,
      content: (
        <>
          <SkillsTab
            skills={plugin.skills}
            onSelectSkill={handleSelectSkill}
            selectedSkill={editorState?.type === "skill" ? editorState.identifier : null}
          />
          {editorState?.type === "skill" && editorFile && (
            filesLoading ? (
              <div className="mt-4"><Skeleton className="h-[400px] rounded-md" /></div>
            ) : filesError ? (
              <p className="mt-4 text-sm text-destructive">{filesError}</p>
            ) : (
              <FileEditorInline
                filePath={editorFile.path}
                content={editorFile.content}
                onChange={handleContentChange}
                onSave={handleSave}
                onClose={() => setEditorState(null)}
                saving={saving}
                saveError={saveError}
                saveSuccess={saveSuccess}
                readOnly={readOnly}
              />
            )
          )}
        </>
      ),
    },
    {
      label: `Connectors (${plugin.hasMcpJson ? 1 : 0})`,
      content: (
        <>
          <ConnectorsTab
            hasMcpJson={plugin.hasMcpJson}
            mcpJsonContent={pluginFiles?.mcpJson ?? null}
            onSelectConnector={handleSelectConnector}
            selected={editorState?.type === "connector"}
          />
          {editorState?.type === "connector" && editorFile && (
            filesLoading ? (
              <div className="mt-4"><Skeleton className="h-[400px] rounded-md" /></div>
            ) : filesError ? (
              <p className="mt-4 text-sm text-destructive">{filesError}</p>
            ) : (
              <FileEditorInline
                filePath={editorFile.path}
                content={editorFile.content}
                onChange={handleContentChange}
                onSave={handleSave}
                onClose={() => setEditorState(null)}
                saving={saving}
                saveError={saveError}
                saveSuccess={saveSuccess}
                readOnly={readOnly}
              />
            )
          )}
        </>
      ),
    },
  ];

  return (
    <div className="space-y-6">
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
          <h1 className="text-2xl font-semibold">{plugin.displayName}</h1>
          {plugin.version && (
            <Badge variant="outline">v{plugin.version}</Badge>
          )}
          {pluginFiles && (
            pluginFiles.isOwned ? (
              <Badge variant="secondary">Editable</Badge>
            ) : (
              <Badge variant="outline">Read-only</Badge>
            )
          )}
        </div>
        {plugin.description && (
          <p className="text-sm text-muted-foreground mt-1">{plugin.description}</p>
        )}
      </div>

      <Tabs tabs={tabs} />
    </div>
  );
}
