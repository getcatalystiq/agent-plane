"use client";

import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export interface FlatFile {
  path: string;
  content: string;
}

interface TreeNode {
  name: string;
  fullPath: string;
  children: TreeNode[];
  files: FlatFile[];
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

function buildTree(files: FlatFile[]): { rootFiles: FlatFile[]; rootDirs: TreeNode[] } {
  const rootFiles: FlatFile[] = [];
  const dirMap = new Map<string, TreeNode>();

  function ensureDir(dirPath: string): TreeNode {
    const existing = dirMap.get(dirPath);
    if (existing) return existing;

    const parts = dirPath.split("/");
    const node: TreeNode = {
      name: parts[parts.length - 1],
      fullPath: dirPath,
      children: [],
      files: [],
    };
    dirMap.set(dirPath, node);

    if (parts.length > 1) {
      const parentPath = parts.slice(0, -1).join("/");
      const parent = ensureDir(parentPath);
      if (!parent.children.some(c => c.fullPath === dirPath)) {
        parent.children.push(node);
      }
    }

    return node;
  }

  for (const file of files) {
    const slashIdx = file.path.lastIndexOf("/");
    if (slashIdx === -1) {
      rootFiles.push(file);
    } else {
      const dirPath = file.path.slice(0, slashIdx);
      const dir = ensureDir(dirPath);
      dir.files.push(file);
    }
  }

  // Collect only top-level dirs
  const rootDirs: TreeNode[] = [];
  for (const node of dirMap.values()) {
    if (!node.fullPath.includes("/") || !dirMap.has(node.fullPath.slice(0, node.fullPath.lastIndexOf("/")))) {
      // This is a root-level directory (no parent in the map, or no slash)
      if (!node.fullPath.includes("/")) {
        rootDirs.push(node);
      }
    }
  }
  // Actually, let's just find nodes whose fullPath has no "/" (they are top-level)
  // But we also need to handle the case where intermediate dirs were created
  // Let's simplify: root dirs are those whose fullPath doesn't contain "/"
  const topLevel: TreeNode[] = [];
  for (const node of dirMap.values()) {
    if (!node.fullPath.includes("/")) {
      topLevel.push(node);
    }
  }

  // Sort children recursively
  function sortNode(node: TreeNode) {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.files.sort((a, b) => a.path.localeCompare(b.path));
    node.children.forEach(sortNode);
  }
  topLevel.forEach(sortNode);
  topLevel.sort((a, b) => a.name.localeCompare(b.name));
  rootFiles.sort((a, b) => a.path.localeCompare(b.path));

  return { rootFiles, rootDirs: topLevel };
}

function collectAllDirPaths(nodes: TreeNode[]): Set<string> {
  const paths = new Set<string>();
  function walk(node: TreeNode) {
    paths.add(node.fullPath);
    node.children.forEach(walk);
  }
  nodes.forEach(walk);
  return paths;
}

interface FileTreeEditorProps {
  initialFiles: FlatFile[];
  onChange?: (files: FlatFile[]) => void;
  onSave: (files: FlatFile[]) => Promise<void>;
  readOnly?: boolean;
  hideSave?: boolean;
  title?: string;
  saveLabel?: string;
  addFolderLabel?: string;
  newFileTemplate?: { filename: string; content: string };
}

export function FileTreeEditor({
  initialFiles,
  onSave,
  onChange,
  readOnly = false,
  hideSave = false,
  title = "Files",
  saveLabel = "Save",
  addFolderLabel = "Folder",
  newFileTemplate = { filename: "SKILL.md", content: "# New\n\nDescribe this...\n" },
}: FileTreeEditorProps) {
  const [files, setFiles] = useState<FlatFile[]>(initialFiles);
  const [selectedPath, setSelectedPath] = useState<string | null>(
    initialFiles.length > 0 ? initialFiles[0].path : null,
  );
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const { rootDirs } = buildTree(initialFiles);
    return collectAllDirPaths(rootDirs);
  });
  const [showAddFolder, setShowAddFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [addingFileInDir, setAddingFileInDir] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState("");
  const savedSnapshot = useRef(JSON.stringify(initialFiles));

  useEffect(() => {
    savedSnapshot.current = JSON.stringify(initialFiles);
    setFiles(initialFiles);
    // Expand all dirs when initialFiles changes
    const { rootDirs } = buildTree(initialFiles);
    setExpanded(collectAllDirPaths(rootDirs));
  }, [initialFiles]);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (onChangeRef.current && JSON.stringify(files) !== savedSnapshot.current) {
      onChangeRef.current(files);
    }
  }, [files]);

  const isDirty = useMemo(
    () => JSON.stringify(files) !== savedSnapshot.current,
    [files],
  );

  const tree = useMemo(() => buildTree(files), [files]);

  const activeFile = useMemo(
    () => (selectedPath ? files.find(f => f.path === selectedPath) ?? null : null),
    [files, selectedPath],
  );

  const handleEditorChange = useCallback((value: string) => {
    if (readOnly || !selectedPath) return;
    setFiles(prev => prev.map(f => f.path === selectedPath ? { ...f, content: value } : f));
  }, [readOnly, selectedPath]);

  function toggleExpand(dirPath: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  }

  function addFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    const filePath = `${name}/${newFileTemplate.filename}`;
    if (files.some(f => f.path === filePath)) return;
    const content = newFileTemplate.content.replace("# New", `# ${name}`);
    setFiles(prev => [...prev, { path: filePath, content }]);
    setSelectedPath(filePath);
    setExpanded(prev => new Set([...prev, name]));
    setNewFolderName("");
    setShowAddFolder(false);
  }

  function removeDir(dirPath: string) {
    const prefix = dirPath + "/";
    const affectedFiles = files.filter(f => f.path.startsWith(prefix));
    if (affectedFiles.length === 0) return;
    if (!confirm(`Remove "${dirPath}" and all ${affectedFiles.length} file(s)?`)) return;
    setFiles(prev => prev.filter(f => !f.path.startsWith(prefix)));
    if (selectedPath && selectedPath.startsWith(prefix)) {
      setSelectedPath(null);
    }
  }

  function removeFile(filePath: string) {
    const fileName = filePath.split("/").pop() ?? filePath;
    if (!confirm(`Remove file "${fileName}"?`)) return;
    setFiles(prev => prev.filter(f => f.path !== filePath));
    if (selectedPath === filePath) {
      setSelectedPath(null);
    }
  }

  function addFileInDir(dirPath: string) {
    const name = newFileName.trim();
    if (!name) return;
    const filePath = dirPath ? `${dirPath}/${name}` : name;
    if (files.some(f => f.path === filePath)) return;
    setFiles(prev => [...prev, { path: filePath, content: "" }]);
    setSelectedPath(filePath);
    setNewFileName("");
    setAddingFileInDir(null);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(files);
    } finally {
      setSaving(false);
    }
  }

  function renderTreeNode(node: TreeNode, depth: number) {
    const isExpanded = expanded.has(node.fullPath);
    return (
      <div key={node.fullPath}>
        <div
          className={`flex items-center justify-between cursor-pointer hover:bg-muted/50 py-1 pr-2`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => toggleExpand(node.fullPath)}
        >
          <span className="font-medium text-xs truncate flex items-center gap-1">
            <span className="text-muted-foreground">{isExpanded ? "▾" : "▸"}</span>
            {node.name}/
          </span>
          {!readOnly && (
            <button
              onClick={(e) => { e.stopPropagation(); removeDir(node.fullPath); }}
              className="text-muted-foreground hover:text-destructive text-xs ml-1 shrink-0"
            >
              &times;
            </button>
          )}
        </div>
        {isExpanded && (
          <>
            {node.children.map(child => renderTreeNode(child, depth + 1))}
            {node.files.map(file => {
              const fileName = file.path.split("/").pop() ?? file.path;
              return (
                <div
                  key={file.path}
                  className={`flex items-center justify-between cursor-pointer hover:bg-muted/30 py-1 pr-2 ${
                    selectedPath === file.path ? "bg-primary/10 text-primary" : ""
                  }`}
                  style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
                  onClick={() => setSelectedPath(file.path)}
                >
                  <span className="text-xs truncate">{fileName}</span>
                  {!readOnly && (
                    <button
                      onClick={(e) => { e.stopPropagation(); removeFile(file.path); }}
                      className="text-muted-foreground hover:text-destructive text-xs ml-1 shrink-0"
                    >
                      &times;
                    </button>
                  )}
                </div>
              );
            })}
            {!readOnly && (
              <div style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }} className="py-1 pr-2">
                {addingFileInDir === node.fullPath ? (
                  <div className="flex gap-1">
                    <Input
                      value={newFileName}
                      onChange={(e) => setNewFileName(e.target.value)}
                      placeholder="file.md"
                      className="h-6 text-xs"
                      onKeyDown={(e) => e.key === "Enter" && addFileInDir(node.fullPath)}
                      autoFocus
                    />
                    <Button onClick={() => addFileInDir(node.fullPath)} size="sm" className="h-6 text-xs px-2">+</Button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setAddingFileInDir(node.fullPath); setNewFileName(""); }}
                    className="text-xs text-primary hover:underline"
                  >
                    + File
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="flex items-center gap-3">
          <CardTitle className="text-base">{title}</CardTitle>
          {isDirty && !readOnly && <Badge variant="destructive" className="text-xs">Unsaved changes</Badge>}
          {readOnly && <Badge variant="secondary" className="text-xs">Read-only</Badge>}
        </div>
        {!readOnly && !hideSave && (
          <Button onClick={handleSave} disabled={saving || !isDirty} size="sm">
            {saving ? "Saving..." : saveLabel}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <div className="flex gap-4 min-h-[500px]">
          {/* File tree */}
          <div className="w-64 shrink-0 border border-border rounded-md overflow-hidden">
            <div className="p-2 bg-muted/50 border-b border-border flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">{title}</span>
              {!readOnly && (
                <button
                  onClick={() => setShowAddFolder(!showAddFolder)}
                  className="text-xs text-primary hover:underline"
                >
                  + {addFolderLabel}
                </button>
              )}
            </div>
            {showAddFolder && !readOnly && (
              <div className="p-2 border-b border-border flex gap-1">
                <Input
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="folder-name"
                  className="h-7 text-xs"
                  onKeyDown={(e) => e.key === "Enter" && addFolder()}
                  autoFocus
                />
                <Button onClick={addFolder} size="sm" className="h-7 text-xs px-2">Add</Button>
              </div>
            )}
            <div className="text-sm overflow-y-auto">
              {/* Root-level files */}
              {tree.rootFiles.map(file => (
                <div
                  key={file.path}
                  className={`flex items-center justify-between cursor-pointer hover:bg-muted/30 py-1 pr-2 ${
                    selectedPath === file.path ? "bg-primary/10 text-primary" : ""
                  }`}
                  style={{ paddingLeft: "8px" }}
                  onClick={() => setSelectedPath(file.path)}
                >
                  <span className="text-xs truncate">{file.path}</span>
                  {!readOnly && (
                    <button
                      onClick={(e) => { e.stopPropagation(); removeFile(file.path); }}
                      className="text-muted-foreground hover:text-destructive text-xs ml-1 shrink-0"
                    >
                      &times;
                    </button>
                  )}
                </div>
              ))}
              {/* Directory tree */}
              {tree.rootDirs.map(node => renderTreeNode(node, 0))}
              {files.length === 0 && (
                <p className="p-3 text-xs text-muted-foreground">
                  {readOnly ? "No files." : `No ${title.toLowerCase()} yet. Add a ${addFolderLabel.toLowerCase()} to get started.`}
                </p>
              )}
            </div>
          </div>

          {/* Editor */}
          <div className="flex-1 border border-border rounded-md overflow-hidden">
            {activeFile ? (
              <div className="h-full flex flex-col">
                <div className="px-3 py-1.5 bg-muted/50 border-b border-border text-xs text-muted-foreground">
                  {activeFile.path}
                </div>
                <CodeMirror
                  value={activeFile.content}
                  onChange={handleEditorChange}
                  readOnly={readOnly}
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
                Select a file to {readOnly ? "view" : "edit"}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
