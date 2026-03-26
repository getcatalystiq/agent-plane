"use client";

import { useState, useMemo, useCallback } from "react";
import { useAgentPlaneClient } from "../../hooks/use-client";
import { Button } from "../ui/button";
import { FileTreeEditor, type FlatFile } from "../ui/file-tree-editor";
import { ImportSkillDialog } from "./import-skill-dialog";

interface AgentSkill {
  folder: string;
  files: Array<{ path: string; content: string }>;
}

interface Props {
  agentId: string;
  initialSkills: AgentSkill[];
  onSaved?: () => void;
}

export function AgentSkillManager({ agentId, initialSkills, onSaved }: Props) {
  const client = useAgentPlaneClient();
  const [importOpen, setImportOpen] = useState(false);
  const [extraSkills, setExtraSkills] = useState<AgentSkill[]>([]);

  const allSkills = useMemo(() => [...initialSkills, ...extraSkills], [initialSkills, extraSkills]);

  const initialFiles = useMemo<FlatFile[]>(() =>
    allSkills.flatMap(s =>
      s.files.map(f => ({
        path: s.folder === "(root)" ? f.path : `${s.folder}/${f.path}`,
        content: f.content,
      })),
    ),
    [allSkills],
  );

  const existingFolders = useMemo(() => allSkills.map((s) => s.folder), [allSkills]);

  const handleImported = useCallback((skill: { folder: string; files: Array<{ path: string; content: string }> }) => {
    setExtraSkills((prev) => [...prev, skill]);
  }, []);

  const handleSave = useCallback(async (files: FlatFile[]) => {
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
    await client.agents.update(agentId, { skills });
    setExtraSkills([]);
    onSaved?.();
  }, [agentId, client, onSaved]);

  return (
    <div>
      <div className="flex items-center justify-end mb-4">
        <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
          Import from skills.sh
        </Button>
      </div>
      <FileTreeEditor
        initialFiles={initialFiles}
        onSave={handleSave}
        title="Skills"
        saveLabel="Save Skills"
        addFolderLabel="Skill"
        newFileTemplate={{
          filename: "SKILL.md",
          content: "---\nname: New Skill\ndescription: Describe when this skill should be triggered\n---\n\n# Instructions\n\nDescribe what this skill does...\n",
        }}
      />
      <ImportSkillDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={handleImported}
        existingFolders={existingFolders}
      />
    </div>
  );
}
