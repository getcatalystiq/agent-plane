// Server-safe provider presets for inbound webhooks. Maps a provider key
// (linear / github / stripe / …) to the signature header it ships, and lets
// the ingress route reverse-lookup a provider id from a stored signature
// header. The admin UI re-exports these so the New Webhook dialog and the
// runtime dedupe lookup share one source of truth.

export interface ProviderPreset {
  signatureHeader: string;
}

export const PROVIDER_OPTIONS: { value: string; label: string }[] = [
  { value: "github", label: "GitHub" },
  { value: "stripe", label: "Stripe" },
  { value: "linear", label: "Linear" },
  { value: "sentry", label: "Sentry" },
  { value: "coinbase", label: "Coinbase Commerce" },
  { value: "vercel", label: "Vercel" },
  { value: "intercom", label: "Intercom" },
  { value: "custom", label: "Custom" },
];

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  github: { signatureHeader: "X-Hub-Signature-256" },
  stripe: { signatureHeader: "Stripe-Signature" },
  linear: { signatureHeader: "Linear-Signature" },
  sentry: { signatureHeader: "sentry-hook-signature" },
  coinbase: { signatureHeader: "X-CC-Webhook-Signature" },
  vercel: { signatureHeader: "x-vercel-signature" },
  intercom: { signatureHeader: "X-Hub-Signature" },
};

export const KNOWN_PROVIDER_KEYS = [
  ...Object.keys(PROVIDER_PRESETS),
  "custom",
] as const;

export function detectProvider(header: string): string {
  for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
    if (preset.signatureHeader === header) return key;
  }
  return "custom";
}
