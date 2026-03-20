/**
 * Model catalog: types, fetch/cache logic for Vercel AI Gateway models.
 *
 * Shared between /api/admin/models and /api/models routes.
 */

import { z } from "zod";
import { logger } from "@/lib/logger";
import { defaultRunnerForModel, supportsClaudeRunner, type RunnerType } from "@/lib/models";

// --- Model Tags ---

export const MODEL_TAGS = [
  "reasoning",
  "tool-use",
  "vision",
  "file-input",
  "implicit-caching",
  "image-generation",
] as const;

export type ModelTag = (typeof MODEL_TAGS)[number];

// --- Catalog Model ---

export interface CatalogModel {
  id: string;
  name: string;
  provider: string;
  context_window: number | null;
  max_tokens: number | null;
  tags: string[];
  pricing: {
    inputPerMillionTokens: number | null;
    outputPerMillionTokens: number | null;
  };
  default_runner: RunnerType;
  supports_claude_runner: boolean;
}

export const DEFAULT_MODEL = "claude-sonnet-4-6";

// --- Gateway Response Validation ---

const GatewayModelSchema = z.object({
  id: z.string(),
  name: z.string().max(500).default(""),
  owned_by: z.string().default("unknown"),
  context_window: z.number().nullable().default(null),
  max_tokens: z.number().nullable().default(null),
  type: z.string().default("language"),
  tags: z.array(z.string().max(100)).default([]),
  pricing: z
    .object({
      input: z.string().nullable().default(null),
      output: z.string().nullable().default(null),
    })
    .default({ input: null, output: null }),
});

const GatewayResponseSchema = z.object({
  data: z.array(GatewayModelSchema),
});

// --- Fallback Models ---

const FALLBACK_MODELS: CatalogModel[] = [
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic", context_window: 1_000_000, max_tokens: 64_000, tags: ["reasoning", "tool-use", "vision"], pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 15 }, default_runner: "claude-agent-sdk", supports_claude_runner: true },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic", context_window: 1_000_000, max_tokens: 64_000, tags: ["reasoning", "tool-use", "vision"], pricing: { inputPerMillionTokens: 5, outputPerMillionTokens: 25 }, default_runner: "claude-agent-sdk", supports_claude_runner: true },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic", context_window: 200_000, max_tokens: 8_192, tags: ["tool-use"], pricing: { inputPerMillionTokens: 0.25, outputPerMillionTokens: 1.25 }, default_runner: "claude-agent-sdk", supports_claude_runner: true },
  { id: "openai/gpt-4o", name: "GPT-4o", provider: "openai", context_window: 128_000, max_tokens: 16_384, tags: ["tool-use", "vision"], pricing: { inputPerMillionTokens: 2.5, outputPerMillionTokens: 10 }, default_runner: "vercel-ai-sdk", supports_claude_runner: false },
  { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", provider: "openai", context_window: 128_000, max_tokens: 16_384, tags: ["tool-use"], pricing: { inputPerMillionTokens: 0.15, outputPerMillionTokens: 0.6 }, default_runner: "vercel-ai-sdk", supports_claude_runner: false },
  { id: "openai/o3", name: "o3", provider: "openai", context_window: 200_000, max_tokens: 100_000, tags: ["reasoning", "tool-use"], pricing: { inputPerMillionTokens: 2, outputPerMillionTokens: 8 }, default_runner: "vercel-ai-sdk", supports_claude_runner: false },
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google", context_window: 1_000_000, max_tokens: 65_536, tags: ["reasoning", "tool-use", "vision"], pricing: { inputPerMillionTokens: 1.25, outputPerMillionTokens: 10 }, default_runner: "vercel-ai-sdk", supports_claude_runner: false },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "google", context_window: 1_000_000, max_tokens: 65_536, tags: ["tool-use", "vision"], pricing: { inputPerMillionTokens: 0.15, outputPerMillionTokens: 0.6 }, default_runner: "vercel-ai-sdk", supports_claude_runner: false },
  { id: "mistral/mistral-large", name: "Mistral Large", provider: "mistral", context_window: 128_000, max_tokens: null, tags: ["tool-use"], pricing: { inputPerMillionTokens: 2, outputPerMillionTokens: 6 }, default_runner: "vercel-ai-sdk", supports_claude_runner: false },
  { id: "xai/grok-3", name: "Grok 3", provider: "xai", context_window: 131_072, max_tokens: null, tags: ["reasoning", "tool-use"], pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 15 }, default_runner: "vercel-ai-sdk", supports_claude_runner: false },
  { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", provider: "deepseek", context_window: 64_000, max_tokens: null, tags: ["tool-use"], pricing: { inputPerMillionTokens: 0.14, outputPerMillionTokens: 0.28 }, default_runner: "vercel-ai-sdk", supports_claude_runner: false },
];

// --- Process-Level Cache ---

let cachedModels: CatalogModel[] | null = null;
let lastKnownGood: CatalogModel[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function parsePrice(value: string | null): number | null {
  if (!value) return null;
  const num = parseFloat(value);
  return isNaN(num) ? null : num;
}

function deriveProvider(id: string, ownedBy: string): string {
  if (id.includes("/")) return id.split("/")[0];
  return ownedBy || "unknown";
}

function toApiId(id: string, provider: string): string {
  // Anthropic models: the gateway returns "anthropic/claude-sonnet-4-6" but
  // our platform uses the bare "claude-sonnet-4-6" format for Anthropic.
  if (provider === "anthropic" && id.startsWith("anthropic/")) {
    return id.slice("anthropic/".length);
  }
  return id;
}

function toCatalogModel(raw: z.infer<typeof GatewayModelSchema>): CatalogModel {
  const provider = deriveProvider(raw.id, raw.owned_by);
  const id = toApiId(raw.id, provider);
  return {
    id,
    name: raw.name || id,
    provider,
    context_window: raw.context_window,
    max_tokens: raw.max_tokens,
    tags: raw.tags,
    pricing: {
      inputPerMillionTokens: parsePrice(raw.pricing.input),
      outputPerMillionTokens: parsePrice(raw.pricing.output),
    },
    default_runner: defaultRunnerForModel(id),
    supports_claude_runner: supportsClaudeRunner(id),
  };
}

/**
 * Fetch and cache the model catalog from Vercel AI Gateway.
 * Returns only language models (filters out embedding/image/video types).
 * Falls back to stale cache or hardcoded models on failure.
 */
export async function listCatalogModels(): Promise<CatalogModel[]> {
  if (cachedModels && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch("https://ai-gateway.vercel.sh/v1/models", {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      logger.warn("AI Gateway models endpoint returned non-200", { status: res.status });
      return lastKnownGood ?? FALLBACK_MODELS;
    }

    const json = await res.json();
    const parsed = GatewayResponseSchema.safeParse(json);

    if (!parsed.success) {
      logger.warn("AI Gateway response failed validation", { error: parsed.error.message });
      return lastKnownGood ?? FALLBACK_MODELS;
    }

    const models = parsed.data.data
      .filter((m) => m.type === "language")
      .map(toCatalogModel);

    cachedModels = models;
    lastKnownGood = models;
    cacheTimestamp = Date.now();
    return models;
  } catch (err) {
    logger.warn("Failed to fetch AI Gateway models, using fallback", {
      error: err instanceof Error ? err.message : String(err),
    });
    return lastKnownGood ?? FALLBACK_MODELS;
  }
}
