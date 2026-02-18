import { Pool, neon } from "@neondatabase/serverless";
import { ZodSchema } from "zod";
import { logger } from "@/lib/logger";

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL not set");

  _pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });

  return _pool;
}

// HTTP driver for stateless queries (health checks, simple lookups)
export function getHttpClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL not set");
  return neon(connectionString);
}

// Typed query helper with Zod runtime validation
export async function query<T>(
  schema: ZodSchema<T>,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const pool = getPool();
  const { rows } = await pool.query(sql, params);
  return rows.map((row: unknown) => schema.parse(row));
}

// Single-row typed query
export async function queryOne<T>(
  schema: ZodSchema<T>,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query(schema, sql, params);
  return rows[0] ?? null;
}

// Execute a query without parsing results (for INSERT/UPDATE/DELETE)
export async function execute(
  sql: string,
  params: unknown[] = [],
): Promise<{ rowCount: number }> {
  const pool = getPool();
  const result = await pool.query(sql, params);
  return { rowCount: result.rowCount ?? 0 };
}

// Tenant-scoped transaction with RLS context
export async function withTenantTransaction<T>(
  tenantId: string,
  fn: (client: TxClient) => Promise<T>,
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.current_tenant_id', $1, true)",
      [tenantId],
    );
    const result = await fn({
      query: async <R>(schema: ZodSchema<R>, sql: string, params: unknown[] = []) => {
        const { rows } = await client.query(sql, params);
        return rows.map((row: unknown) => schema.parse(row));
      },
      queryOne: async <R>(schema: ZodSchema<R>, sql: string, params: unknown[] = []) => {
        const { rows } = await client.query(sql, params);
        const parsed = rows.map((row: unknown) => schema.parse(row));
        return parsed[0] ?? null;
      },
      execute: async (sql: string, params: unknown[] = []) => {
        const result = await client.query(sql, params);
        return { rowCount: result.rowCount ?? 0 };
      },
    });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface TxClient {
  query: <T>(schema: ZodSchema<T>, sql: string, params?: unknown[]) => Promise<T[]>;
  queryOne: <T>(schema: ZodSchema<T>, sql: string, params?: unknown[]) => Promise<T | null>;
  execute: (sql: string, params?: unknown[]) => Promise<{ rowCount: number }>;
}

// Health check using HTTP driver (no transaction needed)
export async function checkConnection(): Promise<boolean> {
  try {
    const sql = getHttpClient();
    await sql`SELECT 1`;
    return true;
  } catch (err) {
    logger.error("Database connection check failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
