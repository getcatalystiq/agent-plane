"use client";

import { useState, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Download, Upload, Sparkles, Globe } from "lucide-react";
import { FileTreeEditor } from "@/components/file-tree-editor";
import type { FlatFile } from "@/components/file-tree-editor";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { adminFetch } from "@/app/admin/lib/api";
import { ImportSoulDialog } from "./import-soul-dialog";

interface Agent {
  id: string;
  soul_md: string | null;
  identity_md: string | null;
  style_md: string | null;
  agents_md: string | null;
  heartbeat_md: string | null;
  user_template_md: string | null;
  examples_good_md: string | null;
  examples_bad_md: string | null;
}

const FILE_MAP: Array<{ path: string; field: keyof Agent }> = [
  { path: "SOUL.md", field: "soul_md" },
  { path: "IDENTITY.md", field: "identity_md" },
  { path: "STYLE.md", field: "style_md" },
  { path: "AGENTS.md", field: "agents_md" },
  { path: "HEARTBEAT.md", field: "heartbeat_md" },
  { path: "USER_TEMPLATE.md", field: "user_template_md" },
  { path: "examples/good-outputs.md", field: "examples_good_md" },
  { path: "examples/bad-outputs.md", field: "examples_bad_md" },
];

function agentToFiles(agent: Agent): FlatFile[] {
  const files: FlatFile[] = [];
  for (const { path, field } of FILE_MAP) {
    const value = agent[field];
    if (typeof value === "string" && value.length > 0) {
      files.push({ path, content: value });
    }
  }
  return files;
}

function filesToPayload(files: FlatFile[]): Record<string, string | null> {
  const payload: Record<string, string | null> = {};
  for (const { path, field } of FILE_MAP) {
    const file = files.find((f) => f.path === path);
    payload[field] = file ? file.content : null;
  }
  return payload;
}

export function IdentityTab({ agent }: { agent: Agent }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [generating, setGenerating] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [savedVersion, setSavedVersion] = useState(0);
  const [overrideFiles, setOverrideFiles] = useState<FlatFile[] | null>(null);

  const initialFiles = useMemo(() => agentToFiles(agent), [agent]);

  // Use override files when generated/imported, otherwise use agent data
  const editorFiles = overrideFiles ?? initialFiles;

  const handleSave = useCallback(async (files: FlatFile[]) => {
    setSaving(true);
    setError("");
    try {
      const payload = filesToPayload(files);
      await adminFetch(`/agents/${agent.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setOverrideFiles(null);
      setSavedVersion((v) => v + 1);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
      throw err; // Let FileTreeEditor know the save failed
    } finally {
      setSaving(false);
    }
  }, [agent.id, router]);

  async function handleGenerate() {
    setGenerating(true);
    setError("");
    try {
      const data = await adminFetch<{ files: Record<string, string> }>(
        `/agents/${agent.id}/generate-soul`,
        { method: "POST" },
      );
      applyFilesFromResponse(data.files);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate");
    } finally {
      setGenerating(false);
    }
  }

  function applyFilesFromResponse(responseFiles: Record<string, string>) {
    const newFiles: FlatFile[] = [];
    for (const { path, field } of FILE_MAP) {
      const content = responseFiles[field] ?? responseFiles[path];
      if (content) {
        newFiles.push({ path, content });
      }
    }
    if (newFiles.length > 0) {
      setOverrideFiles(newFiles);
    }
  }

  function handleImported(responseFiles: Record<string, string>) {
    applyFilesFromResponse(responseFiles);
  }

  async function handleExport() {
    setError("");
    try {
      const data = await adminFetch<{ files: Record<string, string>; name: string }>(
        `/agents/${agent.id}/export-soul`,
      );
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${data.name || "soulspec"}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to export");
    }
  }

  async function handlePublish() {
    const owner = prompt("Enter owner name for publishing:");
    if (!owner?.trim()) return;
    setPublishing(true);
    setError("");
    try {
      await adminFetch(`/agents/${agent.id}/publish-soul`, {
        method: "POST",
        body: JSON.stringify({ owner: owner.trim() }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to publish");
    } finally {
      setPublishing(false);
    }
  }

  // Validation warnings
  const warnings: string[] = [];
  const hasSoul = editorFiles.some((f) => f.path === "SOUL.md" && f.content.trim().length > 0);
  const hasIdentity = editorFiles.some((f) => f.path === "IDENTITY.md" && f.content.trim().length > 0);
  if (!hasSoul) warnings.push("SOUL.md is empty -- this is the core identity file");
  if (!hasIdentity) warnings.push("IDENTITY.md is empty -- consider adding behavioral traits");

  return (
    <div className="space-y-4">
      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleGenerate}
          disabled={generating}
        >
          <Sparkles className="size-4 mr-1.5" />
          {generating ? "Generating..." : "Generate Soul"}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
          <Upload className="size-4 mr-1.5" />
          Import
        </Button>
        <Button variant="outline" size="sm" onClick={handleExport}>
          <Download className="size-4 mr-1.5" />
          Export
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handlePublish}
          disabled={publishing}
        >
          <Globe className="size-4 mr-1.5" />
          {publishing ? "Publishing..." : "Publish"}
        </Button>
        {overrideFiles && (
          <Badge variant="destructive" className="text-xs">
            Unsaved generated content
          </Badge>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* File editor */}
      <div className="rounded-lg border border-muted-foreground/25 p-5">
        <FileTreeEditor
          initialFiles={editorFiles}
          onSave={handleSave}
          title="SoulSpec"
          saveLabel={saving ? "Saving..." : "Save Identity"}
          addFolderLabel="Folder"
          newFileTemplate={{ filename: "CUSTOM.md", content: "# Custom\n\nAdd custom identity content...\n" }}
          savedVersion={savedVersion}
        />
      </div>

      {/* Validation warnings */}
      {warnings.length > 0 && (
        <div className="rounded-md border border-amber-600/30 bg-amber-950/20 p-3">
          <p className="text-xs font-medium text-amber-500 mb-1">Validation Warnings</p>
          <ul className="text-xs text-amber-400/80 space-y-0.5">
            {warnings.map((w) => (
              <li key={w}>- {w}</li>
            ))}
          </ul>
        </div>
      )}

      <ImportSoulDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        agentId={agent.id}
        onImported={handleImported}
      />
    </div>
  );
}
