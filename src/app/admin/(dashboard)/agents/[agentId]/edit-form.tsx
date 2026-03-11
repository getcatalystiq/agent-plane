"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SectionHeader } from "@/components/ui/section-header";
import { FormField } from "@/components/ui/form-field";

const MODELS = [
  { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

interface Agent {
  id: string;
  name: string;
  description: string | null;
  model: string;
  permission_mode: string;
  max_turns: number;
  max_budget_usd: number;
  max_runtime_seconds: number;
  a2a_enabled: boolean;
}

export function AgentEditForm({ agent }: { agent: Agent }) {
  const router = useRouter();
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description ?? "");
  const [model, setModel] = useState(agent.model);
  const [permissionMode, setPermissionMode] = useState(agent.permission_mode);
  const [maxTurns, setMaxTurns] = useState(agent.max_turns.toString());
  const [maxBudget, setMaxBudget] = useState(agent.max_budget_usd.toString());
  const [maxRuntime, setMaxRuntime] = useState(Math.floor(agent.max_runtime_seconds / 60).toString());
  const [a2aEnabled, setA2aEnabled] = useState(agent.a2a_enabled);
  const [saving, setSaving] = useState(false);

  const isDirty =
    name !== agent.name ||
    description !== (agent.description ?? "") ||
    model !== agent.model ||
    permissionMode !== agent.permission_mode ||
    maxTurns !== agent.max_turns.toString() ||
    maxBudget !== agent.max_budget_usd.toString() ||
    maxRuntime !== Math.floor(agent.max_runtime_seconds / 60).toString() ||
    a2aEnabled !== agent.a2a_enabled;

  async function handleSave() {
    setSaving(true);
    try {
      await fetch(`/api/admin/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: description || null,
          model,
          permission_mode: permissionMode,
          max_turns: parseInt(maxTurns),
          max_budget_usd: parseFloat(maxBudget),
          max_runtime_seconds: parseInt(maxRuntime) * 60,
          a2a_enabled: a2aEnabled,
        }),
      });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-muted-foreground/25 p-5">
      <SectionHeader title="Details">
        <Button onClick={handleSave} disabled={saving || !isDirty} size="sm">
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </SectionHeader>
      <div>
        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-2">
            <FormField label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </FormField>
          </div>
          <div className="col-span-3">
            <FormField label="Description">
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this agent do?"
              />
            </FormField>
          </div>
          <div className="col-span-2">
            <FormField label="Model">
              <Select value={model} onChange={(e) => setModel(e.target.value)}>
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </Select>
            </FormField>
          </div>
          <div className="col-span-1">
            <FormField label="Max Turns">
              <Input type="number" min="1" max="1000" value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} />
            </FormField>
          </div>
          <div className="col-span-1">
            <FormField label="Max Budget">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <Input type="number" step="0.01" min="0.01" max="100" value={maxBudget} onChange={(e) => setMaxBudget(e.target.value)} className="pl-6" />
              </div>
            </FormField>
          </div>
          <div className="col-span-1">
            <FormField label="Max Runtime">
              <div className="relative">
                <Input type="number" min="1" max="60" value={maxRuntime} onChange={(e) => setMaxRuntime(e.target.value)} className="pr-10" />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">min</span>
              </div>
            </FormField>
          </div>
          <div className="col-span-2">
            <FormField label="Permission Mode">
              <Select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
                <option value="default">default</option>
                <option value="acceptEdits">acceptEdits</option>
                <option value="bypassPermissions">bypassPermissions</option>
                <option value="plan">plan</option>
              </Select>
            </FormField>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <label className="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              checked={a2aEnabled}
              onChange={(e) => setA2aEnabled(e.target.checked)}
              className="peer sr-only"
            />
            <div className="h-5 w-9 rounded-full bg-zinc-700 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all peer-checked:bg-indigo-500 peer-checked:after:translate-x-full" />
          </label>
          <span className="text-sm text-muted-foreground">
            A2A Protocol — expose this agent via Agent-to-Agent protocol
          </span>
        </div>
      </div>
    </div>
  );
}
