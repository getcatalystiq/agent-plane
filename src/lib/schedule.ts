import { Cron } from "croner";
import type { ScheduleConfig, ScheduleFrequency } from "@/lib/types";

export function scheduleConfigToCron(config: ScheduleConfig): string | null {
  switch (config.frequency) {
    case "manual":
      return null;
    case "hourly":
      return "0 * * * *";
    case "daily": {
      const [h, m] = parseTime(config.time);
      return `${m} ${h} * * *`;
    }
    case "weekdays": {
      const [h, m] = parseTime(config.time);
      return `${m} ${h} * * 1-5`;
    }
    case "weekly": {
      const [h, m] = parseTime(config.time);
      return `${m} ${h} * * ${config.dayOfWeek}`;
    }
  }
}

export function computeNextRunAt(
  config: ScheduleConfig,
  timezone: string,
  fromDate?: Date,
): Date | null {
  const cronExpr = scheduleConfigToCron(config);
  if (!cronExpr) return null;
  const job = new Cron(cronExpr, { timezone });
  return job.nextRun(fromDate) ?? null;
}

// Re-export from timezone.ts so existing server imports still work
export { isValidTimezone } from "@/lib/timezone";

function parseTime(time: string): [number, number] {
  const [h, m] = time.split(":").map(Number);
  return [h, m];
}

/**
 * Batch-compute next_run_at for an array of schedule-like objects.
 * Returns parallel arrays of IDs and ISO timestamps (or null).
 * Used by the cron dispatcher for both stuck-job recovery and claimed-schedule recomputation.
 */
export function batchComputeNextRuns(
  schedules: Array<{ id: string; frequency: ScheduleFrequency; time: string | null; day_of_week: number | null; timezone: string }>,
  options?: { fromDate?: Date; onError?: (scheduleId: string, err: unknown) => void },
): { ids: string[]; nextRunAts: (string | null)[] } {
  const ids: string[] = [];
  const nextRunAts: (string | null)[] = [];
  for (const sched of schedules) {
    try {
      const config = buildScheduleConfig(sched.frequency, sched.time, sched.day_of_week);
      const nextRun = computeNextRunAt(config, sched.timezone, options?.fromDate);
      ids.push(sched.id);
      nextRunAts.push(nextRun?.toISOString() ?? null);
    } catch (err) {
      if (options?.onError) {
        options.onError(sched.id, err);
      } else {
        ids.push(sched.id);
        nextRunAts.push(null);
      }
    }
  }
  return { ids, nextRunAts };
}

/**
 * Build a ScheduleConfig discriminated union from flat DB columns.
 * Shared by the cron dispatcher and PATCH handler.
 */
export function buildScheduleConfig(
  frequency: ScheduleFrequency,
  time: string | null,
  dayOfWeek: number | null,
): ScheduleConfig {
  switch (frequency) {
    case "manual":
      return { frequency: "manual" };
    case "hourly":
      return { frequency: "hourly" };
    case "daily":
      if (!time) return { frequency: "manual" };
      return { frequency: "daily", time };
    case "weekdays":
      if (!time) return { frequency: "manual" };
      return { frequency: "weekdays", time };
    case "weekly":
      if (!time || dayOfWeek === null) return { frequency: "manual" };
      return { frequency: "weekly", time, dayOfWeek };
  }
}
