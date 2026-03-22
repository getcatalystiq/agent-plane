import { processLineAssets } from "./assets";
import { logger } from "./logger";
import { listCatalogModels } from "./model-catalog";
import type { RunId, RunStatus, TenantId } from "./types";

const MAX_TRANSCRIPT_EVENTS = 10_000;

// --- Secret Scrubbing ---
export function scrubSecrets(text: string): string {
  // Broad pattern covers all Anthropic token prefixes (oat01, api03, sid01, future versions)
  return text.replace(/sk-ant-[a-z0-9]+-[A-Za-z0-9_-]+/g, "[REDACTED]");
}

/**
 * Parse the last NDJSON line of a transcript to extract run result metadata.
 * Shared between run-executor and session-executor.
 */
export async function parseResultEvent(line: string): Promise<{
  status: RunStatus;
  updates: Record<string, unknown>;
} | null> {
  try {
    const event = JSON.parse(line);
    if (event.type === "result") {
      const status: RunStatus =
        event.subtype === "success" ? "completed" : "failed";

      // Compute cost from token usage + catalog pricing when runner doesn't provide it
      let costUsd = event.total_cost_usd ?? null;
      if ((!costUsd || costUsd === 0) && event.usage && event.model) {
        try {
          const models = await listCatalogModels();
          const modelInfo = models.find((m) => m.id === event.model);
          if (modelInfo?.pricing) {
            const inputCost = (event.usage.input_tokens || 0) * (modelInfo.pricing.inputPerMillionTokens || 0) / 1_000_000;
            const outputCost = (event.usage.output_tokens || 0) * (modelInfo.pricing.outputPerMillionTokens || 0) / 1_000_000;
            costUsd = inputCost + outputCost;
          }
        } catch {
          // Fall back to 0 if catalog lookup fails
        }
      }

      return {
        status,
        updates: {
          result_summary: event.subtype,
          cost_usd: costUsd ?? 0,
          num_turns: event.num_turns,
          duration_ms: event.duration_ms,
          duration_api_ms: event.duration_api_ms,
          total_input_tokens: event.usage?.input_tokens,
          total_output_tokens: event.usage?.output_tokens,
          cache_read_tokens: event.usage?.cache_read_input_tokens,
          cache_creation_tokens: event.usage?.cache_creation_input_tokens,
          model_usage: event.modelUsage,
          runner: event.runner ?? null,
        },
      };
    }
    if (event.type === "error") {
      return {
        status: "failed",
        updates: {
          error_type: event.code || "execution_error",
          error_messages: [event.error],
        },
      };
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

/**
 * Capture transcript events from a log stream, processing assets and
 * enforcing a max event limit. Shared between run-executor and session-executor.
 *
 * @param onEvent - Optional callback invoked for each parsed JSON event before
 *   processing. Used by sessions to capture sdk_session_id from session_info events.
 */
export async function* captureTranscript(
  source: AsyncIterable<string>,
  chunks: string[],
  tenantId: TenantId,
  runId: RunId,
  onEvent?: (parsed: Record<string, unknown>) => void,
): AsyncGenerator<string> {
  let truncated = false;
  for await (const line of source) {
    const trimmed = line.trim();
    if (!trimmed) {
      yield line;
      continue;
    }

    // Let caller inspect each parsed event (e.g. to capture session_info)
    if (onEvent) {
      try {
        onEvent(JSON.parse(trimmed));
      } catch {
        // Not JSON
      }
    }

    if (truncated) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.type === "result" || parsed.type === "error") {
          const processed = scrubSecrets(await processLineAssets(trimmed, tenantId, runId));
          chunks.push(processed);
          yield processed;
          continue;
        }
      } catch {
        // Not JSON
      }
      yield scrubSecrets(trimmed);
    } else {
      const processed = scrubSecrets(await processLineAssets(trimmed, tenantId, runId));
      const isTextDelta = (() => {
        try { return JSON.parse(processed).type === "text_delta"; } catch { return false; }
      })();
      if (isTextDelta) {
        yield processed;
        continue;
      }
      if (chunks.length < MAX_TRANSCRIPT_EVENTS) {
        chunks.push(processed);
      } else {
        truncated = true;
        chunks.push(JSON.stringify({ type: "system", message: `Transcript truncated at ${MAX_TRANSCRIPT_EVENTS} events` }));
        logger.warn("Transcript truncated", { run_id: runId, max: MAX_TRANSCRIPT_EVENTS });
      }
      yield processed;
    }
  }
}
