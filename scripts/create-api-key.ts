import { Pool } from "@neondatabase/serverless";
import { generateApiKey, hashApiKey } from "../src/lib/crypto";

async function main() {
  const tenantId = process.argv[2];
  if (!tenantId) {
    console.error("Usage: npx tsx scripts/create-api-key.ts <tenant-id>");
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL_DIRECT or DATABASE_URL required");
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  const { raw, prefix } = generateApiKey();
  const keyHash = await hashApiKey(raw);

  await pool.query(
    "INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4)",
    [tenantId, "cli-generated", prefix, keyHash],
  );

  console.log(`\nAPI Key: ${raw}`);
  console.log("⚠️  Save this key - it cannot be shown again\n");
  await pool.end();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
