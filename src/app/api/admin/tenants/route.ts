import { NextRequest, NextResponse } from "next/server";
import { query, queryOne, getPool } from "@/db";
import { PaginationSchema } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { generateApiKey, hashApiKey } from "@/lib/crypto";
import { ValidationError } from "@/lib/errors";
import { z } from "zod";

export const dynamic = "force-dynamic";

const TenantWithStats = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: z.string(),
  logo_url: z.string().nullable().default(null),
  monthly_budget_usd: z.coerce.number(),
  current_month_spend: z.coerce.number(),
  created_at: z.coerce.string(),
  agent_count: z.coerce.number(),
  message_count: z.coerce.number(),
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  const url = new URL(request.url);
  const { limit, offset } = PaginationSchema.parse({
    limit: url.searchParams.get("limit") ?? "50",
    offset: url.searchParams.get("offset") ?? "0",
  });

  const tenants = await query(
    TenantWithStats,
    `SELECT t.*,
       COUNT(DISTINCT a.id)::int AS agent_count,
       COUNT(DISTINCT m.id)::int AS message_count
     FROM tenants t
     LEFT JOIN agents a ON a.tenant_id = t.id
     LEFT JOIN session_messages m ON m.tenant_id = t.id
     GROUP BY t.id
     ORDER BY t.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );

  return NextResponse.json({ data: tenants, limit, offset });
});

const CreateTenantBody = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens"),
  monthly_budget_usd: z.number().min(0).default(100),
});

const TenantRow = z.object({ id: z.string() });

export const POST = withErrorHandler(async (request: NextRequest) => {
  const body = CreateTenantBody.parse(await request.json());

  const existing = await queryOne(TenantRow, `SELECT id FROM tenants WHERE slug = $1`, [body.slug]);
  if (existing) {
    throw new ValidationError(`Tenant with slug "${body.slug}" already exists`);
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: [tenant] } = await client.query(
      `INSERT INTO tenants (name, slug, monthly_budget_usd) VALUES ($1, $2, $3) RETURNING id`,
      [body.name, body.slug, body.monthly_budget_usd],
    );

    const { raw, prefix } = generateApiKey();
    const keyHash = await hashApiKey(raw);

    await client.query(
      `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4)`,
      [tenant.id, "default", prefix, keyHash],
    );

    await client.query("COMMIT");

    return NextResponse.json({ id: tenant.id, api_key: raw }, { status: 201 });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});
