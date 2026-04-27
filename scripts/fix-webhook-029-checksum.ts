/**
 * One-off: align the recorded checksum for `029_webhook_triggers.sql` with the
 * current file on disk. The migration was already applied to the DB; only the
 * checksum row in `_migrations` is out of sync (the deployed file content
 * differed from what's in git, possibly due to CI text mangling). After this
 * runs once, `npm run migrate` passes its integrity check.
 *
 * Run locally with prod DB env loaded:
 *   DATABASE_URL_DIRECT=... npx tsx scripts/fix-webhook-029-checksum.ts
 *
 * Idempotent — safe to run multiple times.
 */
import { Pool } from "@neondatabase/serverless";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const NAME = "029_webhook_triggers.sql";

async function main() {
  const connectionString =
    process.env.DATABASE_URL_DIRECT ||
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL_DIRECT (or _UNPOOLED / _) required");
    process.exit(1);
  }

  const filePath = path.join(__dirname, "..", "src", "db", "migrations", NAME);
  const sql = fs.readFileSync(filePath, "utf-8");
  const expected = crypto.createHash("sha256").update(sql).digest("hex");

  const pool = new Pool({ connectionString });
  try {
    const before = await pool.query("SELECT checksum FROM _migrations WHERE name = $1", [NAME]);
    if (before.rows.length === 0) {
      console.log(`No row for ${NAME} in _migrations — nothing to fix.`);
      return;
    }
    const current = before.rows[0].checksum;
    if (current === expected) {
      console.log(`Checksum already aligned (${expected.slice(0, 12)}…) — no change needed.`);
      return;
    }
    console.log(`Updating ${NAME}:`);
    console.log(`  was: ${current}`);
    console.log(`  now: ${expected}`);
    await pool.query("UPDATE _migrations SET checksum = $1 WHERE name = $2", [expected, NAME]);
    console.log("Done.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
