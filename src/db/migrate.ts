import { Pool } from "@neondatabase/serverless";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function migrate() {
  const connectionString = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL_DIRECT or DATABASE_URL required");
    process.exit(1);
  }

  const pool = new Pool({ connectionString });

  try {
    // Ensure migration tracking table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        checksum VARCHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Get already-applied migrations
    const { rows: applied } = await pool.query(
      "SELECT name, checksum FROM _migrations ORDER BY id",
    );
    const appliedMap = new Map(
      applied.map((r: { name: string; checksum: string }) => [r.name, r.checksum]),
    );

    // Find migration files
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    if (files.length === 0) {
      console.log("No migration files found");
      return;
    }

    let appliedCount = 0;

    for (const file of files) {
      const filePath = path.join(MIGRATIONS_DIR, file);
      const sql = fs.readFileSync(filePath, "utf-8");
      const checksum = crypto.createHash("sha256").update(sql).digest("hex");

      const existingChecksum = appliedMap.get(file);
      if (existingChecksum) {
        if (existingChecksum !== checksum) {
          if (process.env.MIGRATIONS_RECONCILE_CHECKSUMS === "true") {
            await pool.query(
              "UPDATE _migrations SET checksum = $1 WHERE name = $2",
              [checksum, file],
            );
            console.log(
              `  reconciled ${file} checksum (old=${existingChecksum.slice(0, 12)}, new=${checksum.slice(0, 12)})`,
            );
            continue;
          }
          console.error(
            `Migration ${file} has been modified after application! Expected checksum ${existingChecksum}, got ${checksum}.\n` +
            `Set MIGRATIONS_RECONCILE_CHECKSUMS=true for one deploy to update the stored checksum if the SQL is idempotent.`,
          );
          process.exit(1);
        }
        console.log(`  skip  ${file} (already applied)`);
        continue;
      }

      console.log(`  apply ${file}...`);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO _migrations (name, checksum) VALUES ($1, $2)",
          [file, checksum],
        );
        await client.query("COMMIT");
        console.log(`  done  ${file}`);
        appliedCount++;
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`  FAIL  ${file}:`, err);
        process.exit(1);
      } finally {
        client.release();
      }
    }

    if (appliedCount === 0) {
      console.log("All migrations already applied");
    } else {
      console.log(`Applied ${appliedCount} migration(s)`);
    }
  } finally {
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
