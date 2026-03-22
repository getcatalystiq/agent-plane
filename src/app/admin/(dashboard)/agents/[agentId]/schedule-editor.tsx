"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SectionHeader } from "@/components/ui/section-header";
import { FormField } from "@/components/ui/form-field";
import { FormError } from "@/components/ui/form-error";
import { LocalDate } from "@/components/local-date";
import type { Schedule } from "@/lib/validation";
import type { ScheduleFrequency } from "@/lib/types";
import { adminFetch } from "@/app/admin/lib/api";

interface ScheduleListProps {
  agentId: string;
  initialSchedules: Schedule[];
  timezone: string;
}

type ScheduleOp = "idle" | "saving" | "deleting";

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
  return time.slice(0, 5);
}

export function ScheduleEditor({ agentId, initialSchedules, timezone }: ScheduleListProps) {
  const [schedules, setSchedules] = useState<Schedule[]>(initialSchedules);
  const [generation, setGeneration] = useState(0);
  const [ops, setOps] = useState<Record<string, ScheduleOp>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [adding, setAdding] = useState(false);

  const refetch = useCallback(async () => {
    try {
      const data = await adminFetch<Schedule[]>(`/agents/${agentId}/schedules`);
      setSchedules(data);
      setGeneration((g) => g + 1);
    } catch (err) {
      setErrors((prev) => ({ ...prev, _refetch: err instanceof Error ? err.message : "Failed to refresh schedules" }));
    }
  }, [agentId]);

  const setOp = (id: string, op: ScheduleOp) =>
    setOps((prev) => ({ ...prev, [id]: op }));

  const setErr = (id: string, err: string | null) =>
    setErrors((prev) => ({ ...prev, [id]: err }));

  async function handleAdd() {
    setAdding(true);
    try {
      await adminFetch(`/agents/${agentId}/schedules`, {
        method: "POST",
        body: JSON.stringify({
          frequency: "manual",
          time: null,
          day_of_week: null,
          prompt: null,
          enabled: false,
        }),
      });
      setErr("_add", null);
      await refetch();
    } catch (err) {
      setErr("_add", err instanceof Error ? err.message : "Network error");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: string) {
    setOp(id, "deleting");
    setErr(id, null);
    try {
      await adminFetch(`/agents/${agentId}/schedules/${id}`, { method: "DELETE" });
      await refetch();
    } catch (err) {
      setErr(id, err instanceof Error ? err.message : "Network error");
    } finally {
      setOp(id, "idle");
    }
  }

  return (
    <div className="rounded-lg border border-muted-foreground/25 p-5">
      <SectionHeader title="Schedules">
        <Button onClick={handleAdd} disabled={adding} size="sm">
          {adding ? "Adding..." : "Add Schedule"}
        </Button>
      </SectionHeader>
      <FormError error={errors["_add"] ?? null} />
      <FormError error={errors["_refetch"] ?? null} />

      {schedules.length === 0 && (
        <p className="text-sm text-muted-foreground py-4">No schedules configured. Click &quot;Add Schedule&quot; to create one.</p>
      )}

      <div className="space-y-4">
        {schedules.map((schedule) => (
          <ScheduleCard
            key={`${schedule.id}-${generation}`}
            agentId={agentId}
            schedule={schedule}
            timezone={timezone}
            op={ops[schedule.id] ?? "idle"}
            error={errors[schedule.id] ?? null}
            setOp={(op) => setOp(schedule.id, op)}
            setError={(err) => setErr(schedule.id, err)}
            onDelete={() => handleDelete(schedule.id)}
            onSaved={refetch}
          />
        ))}
      </div>
    </div>
  );
}

interface ScheduleCardProps {
  agentId: string;
  schedule: Schedule;
  timezone: string;
  op: ScheduleOp;
  error: string | null;
  setOp: (op: ScheduleOp) => void;
  setError: (err: string | null) => void;
  onDelete: () => void;
  onSaved: () => Promise<void>;
}

function ScheduleCard({
  agentId,
  schedule,
  timezone,
  op,
  error,
  setOp,
  setError,
  onDelete,
  onSaved,
}: ScheduleCardProps) {
  const [frequency, setFrequency] = useState(schedule.frequency);
  const [time, setTime] = useState(formatTimeForInput(schedule.time));
  const [dayOfWeek, setDayOfWeek] = useState(schedule.day_of_week ?? 1);
  const [prompt, setPrompt] = useState(schedule.prompt ?? "");
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [name, setName] = useState(schedule.name ?? "");

  const showTimePicker = ["daily", "weekdays", "weekly"].includes(frequency);
  const showDayPicker = frequency === "weekly";
  const canEnable = frequency !== "manual";
  const busy = op !== "idle";

  async function handleSave() {
    setOp("saving");
    setError(null);
    try {
      await adminFetch(`/agents/${agentId}/schedules/${schedule.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: name.trim() || null,
          frequency,
          time: showTimePicker ? time : null,
          day_of_week: showDayPicker ? dayOfWeek : null,
          prompt: prompt.trim() || null,
          enabled: canEnable ? enabled : false,
        }),
      });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setOp("idle");
    }
  }

  return (
    <div className="rounded border border-muted-foreground/15 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Schedule name (optional)"
          className="max-w-xs text-sm"
        />
        <div className="flex items-center gap-3">
          {canEnable && (
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-sm text-muted-foreground">{enabled ? "Enabled" : "Disabled"}</span>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                onClick={() => setEnabled(!enabled)}
                disabled={busy}
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
          <Button onClick={handleSave} disabled={busy} size="sm">
            {op === "saving" ? "Saving..." : "Save"}
          </Button>
          <Button onClick={onDelete} disabled={busy} size="sm" variant="destructive">
            {op === "deleting" ? "Deleting..." : "Delete"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <FormField label="Frequency">
          <Select
            value={frequency}
            onChange={(e) => {
              const newFreq = e.target.value as ScheduleFrequency;
              setFrequency(newFreq);
              if (newFreq === "manual") setEnabled(false);
              else setEnabled(true);
            }}
            disabled={busy}
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
              disabled={busy}
            />
          </FormField>
        )}

        {showDayPicker && (
          <FormField label="Day of Week">
            <Select
              value={dayOfWeek.toString()}
              onChange={(e) => setDayOfWeek(parseInt(e.target.value))}
              disabled={busy}
            >
              {DAYS_OF_WEEK.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </Select>
          </FormField>
        )}
      </div>

      {frequency !== "manual" && (
        <FormField label="Prompt">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="Enter the prompt to send on each scheduled run..."
            className="resize-y min-h-[60px]"
            disabled={busy}
          />
        </FormField>
      )}

      {(schedule.last_run_at || schedule.next_run_at) && (
        <div className="flex gap-6 text-sm text-muted-foreground pt-1">
          {schedule.last_run_at && (
            <div>
              <span className="font-medium">Last run:</span>{" "}
              <LocalDate value={schedule.last_run_at} />
            </div>
          )}
          {schedule.next_run_at && (
            <div>
              <span className="font-medium">Next run:</span>{" "}
              <LocalDate value={schedule.next_run_at} />
            </div>
          )}
        </div>
      )}

      <FormError error={error} />
    </div>
  );
}
