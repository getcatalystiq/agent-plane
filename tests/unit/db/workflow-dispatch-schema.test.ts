import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  SessionRow,
  SessionMessageRow,
  ScheduleRow,
  TenantRow,
} from "@/lib/validation";
import {
  WORKFLOW_RUN_ID_PREFIX,
  requireWorkflowRunId,
} from "@/lib/types";

// Static-analysis tests over migration 034 plus Zod round-trip tests for the
// new columns. Real Postgres is not running in the unit suite, so this guards
// the migration SQL text and the validation schemas against drift. Cross-tenant
// RLS behavior is integration-tested elsewhere.
//
// Plan reference: U1 in docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../src/db/migrations/034_workflow_dispatch_columns.sql",
);

function loadMigration(): string {
  return fs.readFileSync(MIGRATION_PATH, "utf-8");
}

describe("034_workflow_dispatch_columns migration", () => {
  const sql = loadMigration();

  describe("sessions.workflow_run_id", () => {
    it("adds the column nullable", () => {
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+sessions\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+workflow_run_id\s+TEXT/i,
      );
      // Ensure the column declaration does NOT carry NOT NULL — coexistence
      // requires legacy-path rows to be writable without a value.
      const sessionsLine = sql.match(
        /ALTER\s+TABLE\s+sessions\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+workflow_run_id[^;]*;/i,
      );
      expect(sessionsLine?.[0]).toBeDefined();
      expect(sessionsLine?.[0]).not.toMatch(/NOT\s+NULL/i);
    });
  });

  describe("session_messages.runner_started_at", () => {
    it("adds the timestamp column nullable", () => {
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+session_messages\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+runner_started_at\s+TIMESTAMPTZ/i,
      );
      const line = sql.match(
        /ALTER\s+TABLE\s+session_messages\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+runner_started_at[^;]*;/i,
      );
      expect(line?.[0]).toBeDefined();
      expect(line?.[0]).not.toMatch(/NOT\s+NULL/i);
    });
  });

  describe("schedules.last_fired_dispatch_key", () => {
    it("adds the dispatch-key column nullable", () => {
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+schedules\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+last_fired_dispatch_key\s+TEXT/i,
      );
    });

    it("does NOT create a UNIQUE index — dedup is a CAS pattern in U7's cron handler", () => {
      // The plan originally called for a UNIQUE constraint, but with one row
      // per schedule and a single column storing the most recent fire's key,
      // such a constraint would be redundant against the existing primary
      // key. Dedup is a `WHERE last_fired_dispatch_key IS DISTINCT FROM $newKey`
      // CAS in the schedule cron's /execute handler (U7).
      expect(sql).not.toMatch(
        /CREATE\s+UNIQUE\s+INDEX[\s\S]*?ON\s+schedules[\s\S]*?last_fired_dispatch_key/i,
      );
    });
  });

  // (Removed: `tenants.workflow_dispatch_overrides` schema tests. The
  //  column exists on the migration text but no application code reads
  //  it any more — the workflow-vs-legacy toggle was retired. The
  //  column itself is harmless to keep; cleaning it up would require
  //  a separate DROP COLUMN migration.)

  describe("idempotency", () => {
    it("uses ADD COLUMN IF NOT EXISTS for every column", () => {
      const addColumns = sql.match(/ADD\s+COLUMN/gi) ?? [];
      const addColumnIfNotExists = sql.match(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/gi) ?? [];
      expect(addColumnIfNotExists.length).toBe(addColumns.length);
    });

    it("guards ADD CONSTRAINT in a DO block (Postgres lacks ADD CONSTRAINT IF NOT EXISTS)", () => {
      expect(sql).toMatch(/DO\s+\$\$[\s\S]*?pg_constraint[\s\S]*?ALTER\s+TABLE\s+tenants\s+ADD\s+CONSTRAINT/i);
    });
  });
});

describe("workflow_run_id branded type", () => {
  it("rejects values without the wdk_v1_ prefix", () => {
    expect(() => requireWorkflowRunId("raw-id")).toThrow();
    expect(() => requireWorkflowRunId("v2_abc")).toThrow();
    expect(() => requireWorkflowRunId("")).toThrow();
  });

  it("accepts values with the wdk_v1_ prefix", () => {
    expect(() => requireWorkflowRunId(`${WORKFLOW_RUN_ID_PREFIX}abc-123`)).not.toThrow();
    const branded = requireWorkflowRunId(`${WORKFLOW_RUN_ID_PREFIX}xyz`);
    expect(typeof branded).toBe("string");
    expect(branded.startsWith(WORKFLOW_RUN_ID_PREFIX)).toBe(true);
  });
});

describe("validation schema round-trips", () => {
  // Build a minimal valid base for each schema once, then round-trip the new
  // fields. Field shapes mirror what the DB returns; we don't exercise every
  // existing field — separate tests cover those.

  const baseSession = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    tenant_id: "550e8400-e29b-41d4-a716-446655440001",
    agent_id: "550e8400-e29b-41d4-a716-446655440002",
    sandbox_id: null,
    sdk_session_id: null,
    session_blob_url: null,
    status: "creating" as const,
    ephemeral: false,
    idle_ttl_seconds: 600,
    expires_at: "2026-05-05T10:00:00.000Z",
    context_id: null,
    message_count: 0,
    idle_since: null,
    last_backup_at: null,
    mcp_refreshed_at: null,
    created_at: "2026-05-05T08:00:00.000Z",
    updated_at: "2026-05-05T08:00:00.000Z",
  };

  describe("SessionRow.workflow_run_id", () => {
    it("defaults to null when absent", () => {
      const parsed = SessionRow.parse(baseSession);
      expect(parsed.workflow_run_id).toBeNull();
    });

    it("accepts a wdk_v1_-prefixed value", () => {
      const parsed = SessionRow.parse({
        ...baseSession,
        workflow_run_id: `${WORKFLOW_RUN_ID_PREFIX}run-abc`,
      });
      expect(parsed.workflow_run_id).toBe(`${WORKFLOW_RUN_ID_PREFIX}run-abc`);
    });

    it("preserves null on explicit null", () => {
      const parsed = SessionRow.parse({ ...baseSession, workflow_run_id: null });
      expect(parsed.workflow_run_id).toBeNull();
    });
  });

  const baseMessage = {
    id: "550e8400-e29b-41d4-a716-446655440010",
    session_id: "550e8400-e29b-41d4-a716-446655440011",
    tenant_id: "550e8400-e29b-41d4-a716-446655440012",
    prompt: "test",
    status: "running" as const,
    triggered_by: "api" as const,
    runner: null,
    cost_usd: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    num_turns: 0,
    duration_ms: 0,
    duration_api_ms: 0,
    model_usage: null,
    transcript_blob_url: null,
    result_summary: null,
    error_type: null,
    error_messages: [] as string[],
    started_at: null,
    completed_at: null,
    created_at: "2026-05-05T08:00:00.000Z",
  };

  describe("SessionMessageRow.runner_started_at", () => {
    it("defaults to null when absent", () => {
      const parsed = SessionMessageRow.parse(baseMessage);
      expect(parsed.runner_started_at).toBeNull();
    });

    it("accepts an ISO timestamp string", () => {
      const ts = "2026-05-05T08:30:00.000Z";
      const parsed = SessionMessageRow.parse({
        ...baseMessage,
        runner_started_at: ts,
      });
      expect(parsed.runner_started_at).toBe(ts);
    });
  });

  const baseSchedule = {
    id: "550e8400-e29b-41d4-a716-446655440020",
    tenant_id: "550e8400-e29b-41d4-a716-446655440021",
    agent_id: "550e8400-e29b-41d4-a716-446655440022",
    name: null,
    frequency: "manual" as const,
    time: null,
    day_of_week: null,
    prompt: null,
    enabled: false,
    last_run_at: null,
    next_run_at: null,
    created_at: "2026-05-05T08:00:00.000Z",
    updated_at: "2026-05-05T08:00:00.000Z",
  };

  describe("ScheduleRow.last_fired_dispatch_key", () => {
    it("defaults to null when absent", () => {
      const parsed = ScheduleRow.parse(baseSchedule);
      expect(parsed.last_fired_dispatch_key).toBeNull();
    });

    it("accepts a string key", () => {
      const parsed = ScheduleRow.parse({
        ...baseSchedule,
        last_fired_dispatch_key: "schedule-x:2026-05-05T08:00:00Z",
      });
      expect(parsed.last_fired_dispatch_key).toBe(
        "schedule-x:2026-05-05T08:00:00Z",
      );
    });
  });

  const baseTenant = {
    id: "550e8400-e29b-41d4-a716-446655440030",
    name: "Acme",
    slug: "acme",
    settings: {},
    monthly_budget_usd: 100,
    status: "active" as const,
    current_month_spend: 0,
    timezone: "UTC",
    logo_url: null,
    clawsouls_api_token_enc: null,
    subscription_base_url: null,
    subscription_token_expires_at: null,
    spend_period_start: "2026-05-01T00:00:00.000Z",
    created_at: "2026-05-05T08:00:00.000Z",
  };

  // (Removed: `TenantRow.workflow_dispatch_overrides` round-trip tests.
  //  The validation field was retired alongside the toggle infra.)
});
