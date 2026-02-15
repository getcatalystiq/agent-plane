import { z } from "zod";

const EnvSchema = z.object({
  // Neon
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_URL_DIRECT: z.string().optional(),

  // Vercel Blob
  BLOB_READ_WRITE_TOKEN: z.string().optional(),

  // Vercel KV (optional, for rate limiting)
  KV_REST_API_URL: z.string().optional(),
  KV_REST_API_TOKEN: z.string().optional(),

  // Vercel Cron
  CRON_SECRET: z.string().optional(),

  // Platform security
  ENCRYPTION_KEY: z.string().length(64, "ENCRYPTION_KEY must be 64 hex chars (32 bytes)").optional(),
  ENCRYPTION_KEY_PREVIOUS: z.string().length(64).optional(),
  ADMIN_API_KEY: z.string().min(1, "ADMIN_API_KEY is required"),

  // Composio
  COMPOSIO_API_KEY: z.string().optional(),

  // Vercel AI Gateway
  AI_GATEWAY_API_KEY: z.string().min(1, "AI_GATEWAY_API_KEY is required"),

  // Runtime
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type Env = z.infer<typeof EnvSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (_env) return _env;
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Environment validation failed:\n${formatted}`);
  }
  _env = result.data;
  return _env;
}

export function resetEnvCache() {
  _env = null;
}
