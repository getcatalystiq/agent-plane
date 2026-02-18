import { Pool } from "@neondatabase/serverless";
import { generateApiKey, hashApiKey } from "../src/lib/crypto";

async function main() {
  const args = process.argv.slice(2);
  const nameIdx = args.indexOf("--name");
  const slugIdx = args.indexOf("--slug");
  const budgetIdx = args.indexOf("--budget");

  const name = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
  const slug = slugIdx >= 0 ? args[slugIdx + 1] : undefined;
  const budget = budgetIdx >= 0 ? parseFloat(args[budgetIdx + 1]) : 100.0;

  if (!name || !slug) {
    console.error("Usage: npx tsx scripts/create-tenant.ts --name <name> --slug <slug> [--budget <usd>]");
    process.exit(1);
  }

  if (!/^[a-z0-9-]+$/.test(slug)) {
    console.error("Slug must be lowercase alphanumeric with hyphens only");
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL_DIRECT or DATABASE_URL required");
    process.exit(1);
  }

  const pool = new Pool({ connectionString });

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Create tenant
      const { rows: [tenant] } = await client.query(
        `INSERT INTO tenants (name, slug, monthly_budget_usd)
         VALUES ($1, $2, $3) RETURNING id`,
        [name, slug, budget],
      );

      // Generate API key
      const { raw, prefix } = generateApiKey();
      const keyHash = await hashApiKey(raw);

      await client.query(
        `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash)
         VALUES ($1, $2, $3, $4)`,
        [tenant.id, "default", prefix, keyHash],
      );

      await client.query("COMMIT");

      console.log(`\nTenant created: ${slug} (id: ${tenant.id})`);
      console.log(`Monthly budget: $${budget}`);
      console.log(`\nAPI Key: ${raw}`);
      console.log("⚠️  Save this key - it cannot be shown again\n");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Failed to create tenant:", err.message || err);
  process.exit(1);
});
