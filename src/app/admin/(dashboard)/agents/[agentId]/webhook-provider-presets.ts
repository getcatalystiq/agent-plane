// Provider presets for the New Webhook dialog. Picking a provider auto-fills
// the signature_header field; users can still override and the picker flips
// to "Custom" when they do. Ported from agent-co's webhook UI; we only carry
// the signature header here (our schema doesn't store signature_format /
// hmac_algorithm yet — verification uses a fixed sha256_hex in src/lib/webhooks).

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

export function detectProvider(header: string): string {
  for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
    if (preset.signatureHeader === header) return key;
  }
  return "custom";
}
