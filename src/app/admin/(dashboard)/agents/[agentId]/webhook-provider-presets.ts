// Provider presets for the New Webhook dialog. The data lives in
// src/lib/webhook-providers.ts so server code (ingress route, dedupe
// resolver) and client code (this admin form) share one definition.

export {
  PROVIDER_OPTIONS,
  PROVIDER_PRESETS,
  detectProvider,
  type ProviderPreset,
} from "@/lib/webhook-providers";
