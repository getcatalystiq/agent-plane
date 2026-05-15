import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// Static-analysis tests over migration 035. We cannot run real Postgres inside
// the Vitest unit suite, so we assert the migration SQL contains the
// load-bearing constructs the plan requires: audit columns on the four
// scan-target tables, the tenants.injection_enforce_mode column with its
// CHECK constraint, and idempotency guards on each addition.
//
// Runtime semantics (default values, CHECK rejection, RLS coverage on the new
// columns) live in the orchestrator's DB integration suite; this file guards
// the migration text against drift.

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../src/db/migrations/035_injection_scan_columns.sql",
);

function loadMigration(): string {
  return fs.readFileSync(MIGRATION_PATH, "utf-8");
}

describe("035_injection_scan_columns migration", () => {
  const sql = loadMigration();

  describe("session_messages audit columns", () => {
    it("adds injection_detected with NOT NULL DEFAULT false", () => {
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+session_messages\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+injection_detected\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/i,
      );
    });

    it("adds injection_confidence as nullable text", () => {
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+session_messages\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+injection_confidence\s+TEXT\s*;/i,
      );
    });

    it("adds injection_patterns as nullable text array", () => {
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+session_messages\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+injection_patterns\s+TEXT\[\]\s*;/i,
      );
    });
  });

  describe("agents audit columns", () => {
    it("adds the same triple to agents", () => {
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+agents\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+injection_detected\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/i,
      );
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+agents\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+injection_confidence\s+TEXT/i,
      );
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+agents\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+injection_patterns\s+TEXT\[\]/i,
      );
    });
  });

  describe("schedules audit columns", () => {
    it("adds the same triple to schedules", () => {
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+schedules\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+injection_detected\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/i,
      );
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+schedules\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+injection_confidence\s+TEXT/i,
      );
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+schedules\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+injection_patterns\s+TEXT\[\]/i,
      );
    });
  });

  describe("tenants.injection_enforce_mode", () => {
    it("adds the column with NOT NULL DEFAULT 'log_only'", () => {
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+tenants\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+injection_enforce_mode\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'log_only'/i,
      );
    });

    it("constrains injection_enforce_mode via a named CHECK in a DO block", () => {
      expect(sql).toMatch(
        /chk_tenants_injection_enforce_mode/,
      );
      expect(sql).toMatch(
        /CHECK\s*\(\s*injection_enforce_mode\s+IN\s*\(\s*'log_only',\s*'enforce'\s*\)\s*\)/i,
      );
    });

    it("wraps the CHECK in a pg_constraint lookup for idempotency", () => {
      // Mirror the 034 idiom: SELECT 1 FROM pg_constraint WHERE conname = ...
      expect(sql).toMatch(
        /pg_constraint[\s\S]*?conname\s*=\s*'chk_tenants_injection_enforce_mode'/i,
      );
    });
  });

  describe("idempotency", () => {
    it("every column add uses IF NOT EXISTS", () => {
      // Count ADD COLUMN occurrences vs ADD COLUMN IF NOT EXISTS occurrences;
      // they must match (no bare ADD COLUMN allowed).
      const addColumns = (sql.match(/ADD\s+COLUMN/gi) ?? []).length;
      const idempotent = (sql.match(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/gi) ?? [])
        .length;
      expect(addColumns).toBeGreaterThan(0);
      expect(idempotent).toBe(addColumns);
    });
  });
});
