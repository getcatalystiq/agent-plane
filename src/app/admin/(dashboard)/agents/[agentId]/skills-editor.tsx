"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface SkillFile {
  path: string;
  content: string;
}

interface AgentSkill {
  folder: string;
  files: SkillFile[];
}

function getLanguageExtension(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "md":
      return [markdown()];
    case "json":
      return [json()];
    case "js":
    case "ts":
    case "jsx":
    case "tsx":
      return [javascript({ typescript: ext === "ts" || ext === "tsx", jsx: ext === "jsx" || ext === "tsx" })];
    default:
      return [];
  }
}

export function SkillsEditor({ agentId, initialSkills }: { agentId: string; initialSkills: AgentSkill[] }) {
  const router = useRouter();
  const [skills, setSkills] = useState<AgentSkill[]>(initialSkills);
  const [selectedFolder, setSelectedFolder] = useState<number>(initialSkills.length > 0 ? 0 : -1);
  const [selectedFile, setSelectedFile] = useState<number>(initialSkills.length > 0 && initialSkills[0].files.length > 0 ? 0 : -1);
  const [saving, setSaving] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFileName, setNewFileName] = useState("");
  const [showAddFolder, setShowAddFolder] = useState(false);
  const [showAddFile, setShowAddFile] = useState(false);
  const savedSnapshot = useRef(JSON.stringify(initialSkills));

  // Sync when server data updates (after router.refresh)
  useEffect(() => {
    savedSnapshot.current = JSON.stringify(initialSkills);
    setSkills(initialSkills);
  }, [initialSkills]);

  const isDirty = useMemo(
    () => JSON.stringify(skills) !== savedSnapshot.current,
    [skills],
  );

  const activeFile = selectedFolder >= 0 && selectedFile >= 0
    ? skills[selectedFolder]?.files[selectedFile]
    : null;

  function handleEditorChange(value: string) {
    if (selectedFolder < 0 || selectedFile < 0) return;
    setSkills((prev) =>
      prev.map((skill, fi) =>
        fi === selectedFolder
          ? {
              ...skill,
              files: skill.files.map((file, si) =>
                si === selectedFile ? { ...file, content: value } : file,
              ),
            }
          : skill,
      ),
    );
  }

  function addFolder() {
    const name = newFolderName.trim();
    if (!name || skills.some((s) => s.folder === name)) return;
    const newSkill: AgentSkill = {
      folder: name,
      files: [{ path: "SKILL.md", content: `# ${name}\n\nDescribe this skill...\n` }],
    };
    setSkills((prev) => [...prev, newSkill]);
    setSelectedFolder(skills.length);
    setSelectedFile(0);
    setNewFolderName("");
    setShowAddFolder(false);
  }

  function removeFolder(index: number) {
    if (!confirm(`Remove skill folder "${skills[index].folder}" and all its files?`)) return;
    setSkills((prev) => prev.filter((_, i) => i !== index));
    if (selectedFolder === index) {
      setSelectedFolder(skills.length > 1 ? 0 : -1);
      setSelectedFile(skills.length > 1 ? 0 : -1);
    } else if (selectedFolder > index) {
      setSelectedFolder((prev) => prev - 1);
    }
  }

  function addFile() {
    const name = newFileName.trim();
    if (!name || selectedFolder < 0) return;
    if (skills[selectedFolder].files.some((f) => f.path === name)) return;
    setSkills((prev) =>
      prev.map((skill, i) =>
        i === selectedFolder
          ? { ...skill, files: [...skill.files, { path: name, content: "" }] }
          : skill,
      ),
    );
    setSelectedFile(skills[selectedFolder].files.length);
    setNewFileName("");
    setShowAddFile(false);
  }

  function removeFile(folderIndex: number, fileIndex: number) {
    const file = skills[folderIndex].files[fileIndex];
    if (!confirm(`Remove file "${file.path}"?`)) return;
    setSkills((prev) =>
      prev.map((skill, i) =>
        i === folderIndex
          ? { ...skill, files: skill.files.filter((_, fi) => fi !== fileIndex) }
          : skill,
      ),
    );
    if (selectedFolder === folderIndex && selectedFile === fileIndex) {
      setSelectedFile(skills[folderIndex].files.length > 1 ? 0 : -1);
    } else if (selectedFolder === folderIndex && selectedFile > fileIndex) {
      setSelectedFile((prev) => prev - 1);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await fetch(`/api/admin/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skills }),
      });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="flex items-center gap-3">
          <CardTitle className="text-base">Skills</CardTitle>
          {isDirty && <Badge variant="destructive" className="text-xs">Unsaved changes</Badge>}
        </div>
        <Button onClick={handleSave} disabled={saving || !isDirty} size="sm">
          {saving ? "Saving..." : "Save Skills"}
        </Button>
      </CardHeader>
      <CardContent>
        <div className="flex gap-4 min-h-[500px]">
          {/* File tree */}
          <div className="w-64 shrink-0 border border-border rounded-md overflow-hidden">
            <div className="p-2 bg-muted/50 border-b border-border flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Skills</span>
              <button
                onClick={() => setShowAddFolder(!showAddFolder)}
                className="text-xs text-primary hover:underline"
              >
                + Folder
              </button>
            </div>
            {showAddFolder && (
              <div className="p-2 border-b border-border flex gap-1">
                <Input
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="folder-name"
                  className="h-7 text-xs"
                  onKeyDown={(e) => e.key === "Enter" && addFolder()}
                />
                <Button onClick={addFolder} size="sm" className="h-7 text-xs px-2">Add</Button>
              </div>
            )}
            <div className="text-sm">
              {skills.map((skill, fi) => (
                <div key={skill.folder}>
                  <div
                    className={`flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-muted/50 ${
                      selectedFolder === fi ? "bg-muted" : ""
                    }`}
                    onClick={() => {
                      setSelectedFolder(fi);
                      setSelectedFile(skill.files.length > 0 ? 0 : -1);
                    }}
                  >
                    <span className="font-medium text-xs truncate">{skill.folder}/</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeFolder(fi); }}
                      className="text-muted-foreground hover:text-destructive text-xs ml-1"
                    >
                      &times;
                    </button>
                  </div>
                  {selectedFolder === fi && (
                    <div className="ml-3 border-l border-border">
                      {skill.files.map((file, si) => (
                        <div
                          key={file.path}
                          className={`flex items-center justify-between px-3 py-1 cursor-pointer hover:bg-muted/30 ${
                            selectedFile === si ? "bg-primary/10 text-primary" : ""
                          }`}
                          onClick={() => setSelectedFile(si)}
                        >
                          <span className="text-xs truncate">{file.path}</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); removeFile(fi, si); }}
                            className="text-muted-foreground hover:text-destructive text-xs ml-1"
                          >
                            &times;
                          </button>
                        </div>
                      ))}
                      {selectedFolder === fi && (
                        <div className="px-3 py-1">
                          {showAddFile ? (
                            <div className="flex gap-1">
                              <Input
                                value={newFileName}
                                onChange={(e) => setNewFileName(e.target.value)}
                                placeholder="file.md"
                                className="h-6 text-xs"
                                onKeyDown={(e) => e.key === "Enter" && addFile()}
                              />
                              <Button onClick={addFile} size="sm" className="h-6 text-xs px-2">+</Button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setShowAddFile(true)}
                              className="text-xs text-primary hover:underline"
                            >
                              + File
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {skills.length === 0 && (
                <p className="p-3 text-xs text-muted-foreground">No skills yet. Add a folder to get started.</p>
              )}
            </div>
          </div>

          {/* Editor */}
          <div className="flex-1 border border-border rounded-md overflow-hidden">
            {activeFile ? (
              <div className="h-full flex flex-col">
                <div className="px-3 py-1.5 bg-muted/50 border-b border-border text-xs text-muted-foreground">
                  {skills[selectedFolder].folder}/{activeFile.path}
                </div>
                <CodeMirror
                  value={activeFile.content}
                  onChange={handleEditorChange}
                  theme={oneDark}
                  extensions={getLanguageExtension(activeFile.path)}
                  height="100%"
                  className="flex-1 overflow-auto"
                  basicSetup={{
                    lineNumbers: true,
                    foldGutter: true,
                    bracketMatching: true,
                  }}
                />
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                Select a file to edit
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
