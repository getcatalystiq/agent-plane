"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { FileTreeEditor } from "@/components/file-tree-editor";
import type { FlatFile } from "@/components/file-tree-editor";

interface AgentSkill {
  folder: string;
  files: Array<{ path: string; content: string }>;
}

export function SkillsEditor({ agentId, initialSkills }: { agentId: string; initialSkills: AgentSkill[] }) {
  const router = useRouter();

  const flatFiles = useMemo<FlatFile[]>(() =>
    initialSkills.flatMap(s =>
      s.files.map(f => ({
        path: s.folder === "(root)" ? f.path : `${s.folder}/${f.path}`,
        content: f.content,
      })),
    ),
    [initialSkills],
  );

  async function handleSave(files: FlatFile[]) {
    // Convert flat files back to grouped { folder, files }[] for the API
    const folderMap = new Map<string, Array<{ path: string; content: string }>>();
    for (const file of files) {
      const slashIdx = file.path.lastIndexOf("/");
      if (slashIdx === -1) {
        const existing = folderMap.get("(root)") ?? [];
        existing.push({ path: file.path, content: file.content });
        folderMap.set("(root)", existing);
      } else {
        const folder = file.path.slice(0, slashIdx);
        const fileName = file.path.slice(slashIdx + 1);
        const existing = folderMap.get(folder) ?? [];
        existing.push({ path: fileName, content: file.content });
        folderMap.set(folder, existing);
      }
    }
    const skills = Array.from(folderMap.entries()).map(([folder, files]) => ({ folder, files }));

    await fetch(`/api/admin/agents/${agentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skills }),
    });
    router.refresh();
  }

  return (
    <FileTreeEditor
      initialFiles={flatFiles}
      onSave={handleSave}
      title="Skills"
      saveLabel="Save Skills"
      addFolderLabel="Folder"
      newFileTemplate={{ filename: "SKILL.md", content: "# New\n\nDescribe this skill...\n" }}
    />
  );
}
