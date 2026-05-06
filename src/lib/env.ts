import { z } from "zod";

const EnvSchema = z.object({
  // Neon
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_URL_DIRECT: z.string().optional(),

  // Vercel Blob
  BLOB_READ_WRITE_TOKEN: z.string().optional(),
  // Separate private store for session files (conversation history). Falls
  // back to BLOB_READ_WRITE_TOKEN when unset (which only works if that
  // store is configured for private access).
  BLOB_PRIVATE_READ_WRITE_TOKEN: z.string().optional(),

  // Vercel Cron
  CRON_SECRET: z.string().min(1, "CRON_SECRET is required"),

  // Platform security
  ENCRYPTION_KEY: z.string().length(64, "ENCRYPTION_KEY must be 64 hex chars (32 bytes)"),
  ENCRYPTION_KEY_PREVIOUS: z.string().length(64).optional(),
  ADMIN_API_KEY: z.string().min(1, "ADMIN_API_KEY is required"),

  // Composio
  COMPOSIO_API_KEY: z.string().optional(),

  // Vercel AI Gateway
  AI_GATEWAY_API_KEY: z.string().min(1, "AI_GATEWAY_API_KEY is required"),

  // Braintrust (observability)
  BRAINTRUST_API_KEY: z.string().optional(),

  // U0 spike: gates the /api/internal/wdk-spike/* driver routes. Set on
  // preview deployments only; production should have it unset so the spike
  // routes 404. The shared secret is required so the spike isn't an open
  // workflow-run-creation endpoint accessible to anyone who finds the
  // preview URL.
  WDK_SPIKE_TOKEN: z.string().optional(),

  // --- U4 dispatch toggles (per-trigger; default off until each entry
  //     point's migration unit ships and its 48h soak passes).
  //
  // Strict on/off — Zod rejects unknown values at parse time so a typo
  // at deploy fails the build rather than silently disabling. Per-tenant
  // override via tenants.workflow_dispatch_overrides JSONB is read by
  // shouldUseWorkflow() and wins over the global toggle. ---
  WORKFLOW_DISPATCH_API: z.enum(["on", "off"]).default("off"),
  WORKFLOW_DISPATCH_SCHEDULE: z.enum(["on", "off"]).default("off"),
  WORKFLOW_DISPATCH_WEBHOOK: z.enum(["on", "off"]).default("off"),
  WORKFLOW_DISPATCH_A2A: z.enum(["on", "off"]).default("off"),
  WORKFLOW_DISPATCH_CLEANUP: z.enum(["on", "off"]).default("off"),
  WORKFLOW_DISPATCH_ADMIN: z.enum(["on", "off"]).default("off"),

  // U10a glass-break: when set to 'on', forces the legacy dispatcher path
  // even when the matching WORKFLOW_DISPATCH_* toggle is on. One-deploy
  // revert lever for long-tail workflow regressions discovered after
  // U10a's retirement merge. Removed in a follow-up cleanup PR roughly
  // 2 weeks after U10a ships.
  LEGACY_DISPATCH_GLASS_BREAK: z.enum(["on", "off"]).default("off"),

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
