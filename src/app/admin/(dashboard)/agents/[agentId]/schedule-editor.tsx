"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SectionHeader } from "@/components/ui/section-header";
import { FormField } from "@/components/ui/form-field";
import { FormError } from "@/components/ui/form-error";
import { LocalDate } from "@/components/local-date";

interface ScheduleEditorProps {
  agentId: string;
  initialSchedule: {
    frequency: string;
    time: string | null;
    dayOfWeek: number | null;
    prompt: string | null;
    enabled: boolean;
    lastRunAt: string | null;
    nextRunAt: string | null;
  };
  timezone: string;
}

const FREQUENCIES = [
  { value: "manual", label: "Manual (no schedule)" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays (Mon-Fri)" },
  { value: "weekly", label: "Weekly" },
];

const DAYS_OF_WEEK = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

function formatTimeForInput(time: string | null): string {
  if (!time) return "09:00";
  // DB stores HH:MM:SS, input needs HH:MM
  return time.slice(0, 5);
}

export function ScheduleEditor({ agentId, initialSchedule, timezone }: ScheduleEditorProps) {
  const router = useRouter();
  const [frequency, setFrequency] = useState(initialSchedule.frequency);
  const [time, setTime] = useState(formatTimeForInput(initialSchedule.time));
  const [dayOfWeek, setDayOfWeek] = useState(initialSchedule.dayOfWeek ?? 1);
  const [prompt, setPrompt] = useState(initialSchedule.prompt ?? "");
  const [enabled, setEnabled] = useState(initialSchedule.enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showTimePicker = ["daily", "weekdays", "weekly"].includes(frequency);
  const showDayPicker = frequency === "weekly";
  const canEnable = frequency !== "manual";

  const isDirty =
    frequency !== initialSchedule.frequency ||
    (showTimePicker && time !== formatTimeForInput(initialSchedule.time)) ||
    (showDayPicker && dayOfWeek !== (initialSchedule.dayOfWeek ?? 1)) ||
    prompt !== (initialSchedule.prompt ?? "") ||
    enabled !== initialSchedule.enabled;

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schedule_frequency: frequency,
          schedule_time: showTimePicker ? time : null,
          schedule_day_of_week: showDayPicker ? dayOfWeek : null,
          schedule_prompt: prompt.trim() || null,
          schedule_enabled: canEnable ? enabled : false,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error?.message ?? data?.error ?? `Save failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SectionHeader title="Schedule">
        {canEnable && (
          <label className="flex items-center gap-2 cursor-pointer">
            <span className="text-sm text-muted-foreground">{enabled ? "Enabled" : "Disabled"}</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => setEnabled(!enabled)}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                enabled ? "bg-primary" : "bg-muted"
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-background shadow-lg ring-0 transition-transform ${
                  enabled ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          </label>
        )}
      </SectionHeader>
      <div className="space-y-4">
        <FormField label="Frequency">
          <Select
            value={frequency}
            onChange={(e) => {
              const newFreq = e.target.value;
              setFrequency(newFreq);
              if (newFreq === "manual") setEnabled(false);
              else setEnabled(true);
            }}
          >
            {FREQUENCIES.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </Select>
        </FormField>

        {showTimePicker && (
          <FormField label={`Time (${timezone})`}>
            <Input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </FormField>
        )}

        {showDayPicker && (
          <FormField label="Day of Week">
            <Select
              value={dayOfWeek.toString()}
              onChange={(e) => setDayOfWeek(parseInt(e.target.value))}
            >
              {DAYS_OF_WEEK.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </Select>
          </FormField>
        )}

        {frequency !== "manual" && (
          <FormField label="Prompt">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="Enter the prompt to send on each scheduled run..."
              className="resize-y min-h-[80px]"
            />
          </FormField>
        )}

        {(initialSchedule.lastRunAt || initialSchedule.nextRunAt) && (
          <div className="flex gap-6 text-sm text-muted-foreground pt-1">
            {initialSchedule.lastRunAt && (
              <div>
                <span className="font-medium">Last run:</span>{" "}
                <LocalDate value={initialSchedule.lastRunAt} />
              </div>
            )}
            {initialSchedule.nextRunAt && (
              <div>
                <span className="font-medium">Next run:</span>{" "}
                <LocalDate value={initialSchedule.nextRunAt} />
              </div>
            )}
          </div>
        )}

        <FormError error={error} />
        <div className="flex justify-end pt-2">
          <Button onClick={handleSave} disabled={saving || !isDirty} size="sm">
            {saving ? "Saving..." : "Save Schedule"}
          </Button>
        </div>
      </div>
    </div>
  );
}
