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

  // --- Chat platform bots (U3-U8) ---
  // Native Redis URL — Chat SDK shared state across all per-agent bot
  // instances. The Chat SDK's @chat-adapter/state-redis uses native Redis
  // protocol (redis:// or rediss://), not the REST API. Provisioned by
  // the Vercel Upstash/KV integration as REDIS_URL. Optional at boot;
  // the platform module fail-closes when chat ingress tries to
  // instantiate without it.
  REDIS_URL: z.string().optional(),
  // Discord forwarder shared secret — distinct from any bot token. Signs
  // forwarded gateway events so anyone who has a leaked bot token still
  // can't forge events at the public webhook URL. PREVIOUS supports
  // zero-downtime rotation (mirrors ENCRYPTION_KEY_PREVIOUS).
  GATEWAY_FORWARDER_SECRET: z.string().optional(),
  GATEWAY_FORWARDER_SECRET_PREVIOUS: z.string().optional(),
  // Discord global fallbacks for single-bot deploys; per-bot values stored
  // in platform_bot_configs.credentials_enc are authoritative.
  DISCORD_PUBLIC_KEY: z.string().optional(),
  DISCORD_APPLICATION_ID: z.string().optional(),
  // Slack global signing secret fallback. Two roles: (1) used during
  // first-time portal handshake when no per-bot row exists yet (A5);
  // (2) used as a dual-accept verification fallback during rotation
  // alongside SLACK_SIGNING_SECRET_PREVIOUS for single-bot deploys
  // where per-bot rotation is too cumbersome. Per-bot value in
  // platform_bot_configs.credentials_enc is the authoritative value
  // for steady-state event verification.
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_SIGNING_SECRET_PREVIOUS: z.string().optional(),
  // Public-app URL — the gateway cron forwards events to
  // ${NEXT_PUBLIC_APP_URL}/api/webhooks/discord. Already used elsewhere.
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
  // Per-attachment cap (R7). Default 25 MB.
  PLATFORM_ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),

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
