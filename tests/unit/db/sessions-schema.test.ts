import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// Static-analysis tests over the U1 migration. We cannot run real Postgres
// inside the Vitest unit suite, so we assert the migration SQL contains the
// load-bearing constructs the plan requires: RLS policies on BOTH tables,
// cascade delete from sessions to session_messages, FK retargets on
// webhook_deliveries, and the unique partial-index predicate that mirrors
// migration 027.
//
// Integration coverage of the actual SQL semantics (cross-tenant SELECT,
// cascade delete behaviour) lives in the orchestrator's DB integration suite;
// this file guards the migration text itself against drift.

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../src/db/migrations/033_runs_sessions_unify.sql",
);

function loadMigration(): string {
  return fs.readFileSync(MIGRATION_PATH, "utf-8");
}

describe("033_runs_sessions_unify migration", () => {
  const sql = loadMigration();
  const sqlLower = sql.toLowerCase();

  describe("legacy table teardown", () => {
    it("drops the runs table without CASCADE", () => {
      expect(sql).toMatch(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?runs\s*;/i);
      expect(sql).not.toMatch(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?runs\s+CASCADE/i);
    });

    it("drops the sessions table without CASCADE", () => {
      expect(sql).toMatch(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?sessions\s*;/i);
      expect(sql).not.toMatch(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?sessions\s+CASCADE/i);
    });

    it("explicitly drops every FK pointing into runs(id) before DROP TABLE", () => {
      // The dynamic loop catches both webhook_deliveries.run_id and
      // webhook_deliveries.suppressed_by_run_id. We assert the loop exists
      // and references confrelid = 'runs' before either DROP TABLE.
      const dropFkLoopIdx = sql.search(/confrelid\s*=\s*'runs'::regclass/i);
      const dropRunsIdx = sql.search(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?runs\s*;/i);
      expect(dropFkLoopIdx).toBeGreaterThan(0);
      expect(dropFkLoopIdx).toBeLessThan(dropRunsIdx);
    });
  });

  describe("sessions table", () => {
    it("creates the sessions table with required columns", () => {
      expect(sql).toMatch(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?sessions\s*\(/i);
      // Required column set per the plan.
      const required = [
        "id",
        "tenant_id",
        "agent_id",
        "sandbox_id",
        "sdk_session_id",
        "session_blob_url",
        "status",
        "ephemeral",
        "idle_ttl_seconds",
        "expires_at",
        "context_id",
        "message_count",
        "idle_since",
      ];
      for (const col of required) {
        // Each column declaration appears at the start of a line in our migration.
        expect(sqlLower).toMatch(new RegExp(`\\b${col}\\b`));
      }
    });

    it("constrains idle_ttl_seconds at 3600 seconds", () => {
      expect(sql).toMatch(/idle_ttl_seconds\s+INTEGER[^,]*<=\s*3600/i);
    });

    it("requires expires_at NOT NULL", () => {
      expect(sql).toMatch(/expires_at\s+TIMESTAMPTZ\s+NOT\s+NULL/i);
    });

    it("constrains status to creating/active/idle/stopped", () => {
      expect(sql).toMatch(
        /status[^()]*CHECK\s*\(\s*status\s+IN\s*\(\s*'creating',\s*'active',\s*'idle',\s*'stopped'\s*\)\s*\)/i,
      );
    });

    it("ephemeral defaults to false", () => {
      expect(sql).toMatch(/ephemeral\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/i);
    });

    it("composite FK pins agent_id+tenant_id and cascades on agent delete", () => {
      expect(sql).toMatch(
        /FOREIGN\s+KEY\s*\(\s*agent_id,\s*tenant_id\s*\)\s*REFERENCES\s+agents\s*\(\s*id,\s*tenant_id\s*\)\s+ON\s+DELETE\s+CASCADE/i,
      );
    });

    it("enables and forces RLS on sessions", () => {
      expect(sql).toMatch(/ALTER\s+TABLE\s+sessions\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
      expect(sql).toMatch(/ALTER\s+TABLE\s+sessions\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
    });

    it("creates a tenant_isolation policy on sessions using current_tenant_id", () => {
      expect(sql).toMatch(
        /CREATE\s+POLICY\s+tenant_isolation\s+ON\s+sessions[\s\S]*?app\.current_tenant_id/i,
      );
    });

    it("creates the partial unique context_id index mirroring migration 027", () => {
      // Mirror predicate exactly: status NOT IN ('stopped') AND context_id IS NOT NULL.
      expect(sql).toMatch(
        /UNIQUE\s+INDEX[^;]+ON\s+sessions[^;]+\(\s*tenant_id,\s*agent_id,\s*context_id\s*\)[^;]+WHERE\s+status\s+NOT\s+IN\s*\(\s*'stopped'\s*\)\s+AND\s+context_id\s+IS\s+NOT\s+NULL/i,
      );
    });

    it("creates the cleanup-cron index on (tenant_id, status, expires_at)", () => {
      expect(sql).toMatch(
        /INDEX[^;]+ON\s+sessions\s*\(\s*tenant_id,\s*status,\s*expires_at\s*\)/i,
      );
    });

    it("creates the tenant_status and tenant_agent_created indexes", () => {
      expect(sql).toMatch(/INDEX[^;]+ON\s+sessions\s*\(\s*tenant_id,\s*status\s*\)\s*;/i);
      expect(sql).toMatch(
        /INDEX[^;]+ON\s+sessions\s*\(\s*tenant_id,\s*agent_id,\s*created_at\s+DESC\s*\)/i,
      );
    });
  });

  describe("session_messages table", () => {
    it("creates the session_messages table", () => {
      expect(sql).toMatch(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?session_messages\s*\(/i);
    });

    it("cascades from sessions on delete", () => {
      expect(sql).toMatch(
        /session_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+sessions\s*\(\s*id\s*\)\s+ON\s+DELETE\s+CASCADE/i,
      );
    });

    it("constrains status to the queued/running/completed/failed/cancelled/timed_out enum", () => {
      expect(sql).toMatch(
        /status[^()]*CHECK\s*\(\s*status\s+IN\s*\(\s*'queued',\s*'running',\s*'completed',\s*'failed',\s*'cancelled',\s*'timed_out'\s*\)\s*\)/i,
      );
    });

    it("constrains triggered_by to the api/schedule/playground/chat/a2a/webhook enum", () => {
      expect(sql).toMatch(
        /triggered_by[^()]*CHECK\s*\(\s*triggered_by\s+IN\s*\(\s*'api',\s*'schedule',\s*'playground',\s*'chat',\s*'a2a',\s*'webhook'\s*\)\s*\)/i,
      );
    });

    it("constrains runner to claude-agent-sdk or vercel-ai-sdk when set", () => {
      expect(sql).toMatch(/runner\s+TEXT[\s\S]*?'claude-agent-sdk'[\s\S]*?'vercel-ai-sdk'/i);
    });

    it("includes billing-grade fields", () => {
      const required = [
        "cost_usd",
        "total_input_tokens",
        "total_output_tokens",
        "cache_read_tokens",
        "cache_creation_tokens",
        "num_turns",
        "duration_ms",
        "duration_api_ms",
        "transcript_blob_url",
        "started_at",
        "completed_at",
      ];
      for (const col of required) {
        expect(sqlLower).toMatch(new RegExp(`\\b${col}\\b`));
      }
    });

    it("references api_keys(id) on created_by_key_id", () => {
      expect(sql).toMatch(
        /created_by_key_id\s+UUID\s+REFERENCES\s+api_keys\s*\(\s*id\s*\)\s+ON\s+DELETE\s+SET\s+NULL/i,
      );
    });

    it("references webhook_sources(id) on webhook_source_id", () => {
      expect(sql).toMatch(
        /webhook_source_id\s+UUID\s+REFERENCES\s+webhook_sources\s*\(\s*id\s*\)\s+ON\s+DELETE\s+SET\s+NULL/i,
      );
    });

    it("enables and forces RLS on session_messages (separate from sessions policy)", () => {
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+session_messages\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i,
      );
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+session_messages\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i,
      );
    });

    it("creates a tenant_isolation policy on session_messages explicitly", () => {
      expect(sql).toMatch(
        /CREATE\s+POLICY\s+tenant_isolation\s+ON\s+session_messages[\s\S]*?app\.current_tenant_id/i,
      );
    });

    it("creates the index on (session_id, created_at)", () => {
      expect(sql).toMatch(
        /INDEX[^;]+ON\s+session_messages\s*\(\s*session_id,\s*created_at\s*\)/i,
      );
    });

    it("creates the index on (tenant_id, created_at DESC)", () => {
      expect(sql).toMatch(
        /INDEX[^;]+ON\s+session_messages\s*\(\s*tenant_id,\s*created_at\s+DESC\s*\)/i,
      );
    });

    it("creates the index on (tenant_id, status)", () => {
      expect(sql).toMatch(
        /INDEX[^;]+ON\s+session_messages\s*\(\s*tenant_id,\s*status\s*\)/i,
      );
    });
  });

  describe("webhook_deliveries FK retarget", () => {
    it("renames run_id to message_id", () => {
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+webhook_deliveries\s+RENAME\s+COLUMN\s+run_id\s+TO\s+message_id/i,
      );
    });

    it("renames suppressed_by_run_id to suppressed_by_message_id", () => {
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+webhook_deliveries\s+RENAME\s+COLUMN\s+suppressed_by_run_id\s+TO\s+suppressed_by_message_id/i,
      );
    });

    it("nulls retained values before rename so the new FK is satisfiable", () => {
      // The old run_ids point at rows in the dropped runs table — they must be
      // cleared before adding the new FK or the constraint addition will fail.
      const updateIdx = sql.search(
        /UPDATE\s+webhook_deliveries\s+SET\s+run_id\s*=\s*NULL/i,
      );
      const renameIdx = sql.search(
        /RENAME\s+COLUMN\s+run_id\s+TO\s+message_id/i,
      );
      expect(updateIdx).toBeGreaterThan(0);
      expect(updateIdx).toBeLessThan(renameIdx);
    });

    it("re-adds the FK pointing at session_messages(id)", () => {
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+webhook_deliveries\s+ADD\s+CONSTRAINT[^;]+FOREIGN\s+KEY\s*\(\s*message_id\s*\)\s+REFERENCES\s+session_messages\s*\(\s*id\s*\)/i,
      );
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+webhook_deliveries\s+ADD\s+CONSTRAINT[^;]+FOREIGN\s+KEY\s*\(\s*suppressed_by_message_id\s*\)\s+REFERENCES\s+session_messages\s*\(\s*id\s*\)/i,
      );
    });
  });

  describe("permissions", () => {
    it("grants CRUD to app_user on both tables", () => {
      expect(sql).toMatch(
        /GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON\s+sessions\s+TO\s+app_user/i,
      );
      expect(sql).toMatch(
        /GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON\s+session_messages\s+TO\s+app_user/i,
      );
    });
  });
});

describe("session state machine (SESSION_VALID_TRANSITIONS)", () => {
  // Re-imported here to keep this test file self-contained and to assert the
  // application-level state machine matches what the migration constrains via
  // CHECK on sessions.status.
  it("covers every transition the dispatcher relies on", async () => {
    const { SESSION_VALID_TRANSITIONS } = await import("@/lib/types");
    expect(SESSION_VALID_TRANSITIONS.creating).toEqual(
      expect.arrayContaining(["active", "idle", "stopped"]),
    );
    expect(SESSION_VALID_TRANSITIONS.active).toEqual(
      expect.arrayContaining(["idle", "stopped"]),
    );
    expect(SESSION_VALID_TRANSITIONS.idle).toEqual(
      expect.arrayContaining(["active", "stopped"]),
    );
    // Terminal: no outgoing transitions.
    expect(SESSION_VALID_TRANSITIONS.stopped).toEqual([]);
  });
});
