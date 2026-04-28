import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/assets", () => ({
  processLineAssets: vi.fn(async (line: string) => line),
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/model-catalog", () => ({
  listCatalogModels: vi.fn(async () => []),
}));

import { parseResultEvent, captureTranscript } from "@/lib/transcript-utils";
import type { TenantId } from "@/lib/types";

const tenantId = "tenant-1" as TenantId;
// captureTranscript's `messageId` param accepts any string (asset path key + log
// correlation only). Naming it `runId` here preserves the historical test
// vocabulary while exercising the new signature.
const runId = "run-1";

// ── Helpers ──────────────────────────────────────────────────────────────

async function* asyncLines(lines: string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}

async function collectAll(gen: AsyncGenerator<string>): Promise<string[]> {
  const result: string[] = [];
  for await (const line of gen) result.push(line);
  return result;
}

// ── parseResultEvent ─────────────────────────────────────────────────────

describe("parseResultEvent", () => {
  it("parses a success result event", async () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.05,
      num_turns: 3,
      duration_ms: 1000,
      duration_api_ms: 900,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
      modelUsage: { "claude-sonnet-4-6": { inputTokens: 100 } },
    });

    const result = await parseResultEvent(line);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("completed");
    expect(result!.updates.cost_usd).toBe(0.05);
    expect(result!.updates.num_turns).toBe(3);
    expect(result!.updates.total_input_tokens).toBe(100);
    expect(result!.updates.cache_read_tokens).toBe(10);
    expect(result!.updates.model_usage).toEqual({ "claude-sonnet-4-6": { inputTokens: 100 } });
  });

  it("parses a failed result event", async () => {
    const line = JSON.stringify({ type: "result", subtype: "error" });
    const result = await parseResultEvent(line);
    expect(result!.status).toBe("failed");
  });

  it("parses an error event", async () => {
    const line = JSON.stringify({ type: "error", code: "timeout", error: "Run timed out" });
    const result = await parseResultEvent(line);
    expect(result!.status).toBe("failed");
    expect(result!.updates.error_type).toBe("timeout");
    expect(result!.updates.error_messages).toEqual(["Run timed out"]);
  });

  it("returns null for non-result events", async () => {
    expect(await parseResultEvent(JSON.stringify({ type: "assistant" }))).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    expect(await parseResultEvent("not json")).toBeNull();
  });
});

// ── captureTranscript ────────────────────────────────────────────────────

describe("captureTranscript", () => {
  beforeEach(() => vi.clearAllMocks());

  it("captures non-text_delta events into chunks", async () => {
    const chunks: string[] = [];
    const source = asyncLines([
      JSON.stringify({ type: "assistant", text: "hi" }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ]);

    await collectAll(captureTranscript(source, chunks, tenantId, runId));
    expect(chunks).toHaveLength(2);
  });

  it("yields text_delta events but does not store them in chunks", async () => {
    const chunks: string[] = [];
    const source = asyncLines([
      JSON.stringify({ type: "text_delta", text: "hello" }),
      JSON.stringify({ type: "text_delta", text: " world" }),
      JSON.stringify({ type: "assistant", text: "hello world" }),
    ]);

    const yielded = await collectAll(captureTranscript(source, chunks, tenantId, runId));
    expect(yielded).toHaveLength(3); // all yielded for streaming
    expect(chunks).toHaveLength(1);  // only assistant stored
    expect(JSON.parse(chunks[0]).type).toBe("assistant");
  });

  it("invokes onEvent callback with parsed JSON for each event", async () => {
    const chunks: string[] = [];
    const onEvent = vi.fn();
    const source = asyncLines([
      JSON.stringify({ type: "session_info", sdk_session_id: "abc-123" }),
      JSON.stringify({ type: "assistant", text: "hi" }),
    ]);

    await collectAll(captureTranscript(source, chunks, tenantId, runId, onEvent));

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session_info", sdk_session_id: "abc-123" }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "assistant" }),
    );
  });

  it("captures sdk_session_id from session_info event via onEvent", async () => {
    const chunks: string[] = [];
    const sdkSessionIdRef = { value: null as string | null };

    const source = asyncLines([
      JSON.stringify({ type: "session_info", sdk_session_id: "sdk-sess-42" }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ]);

    await collectAll(
      captureTranscript(source, chunks, tenantId, runId, (event) => {
        if (event.type === "session_info" && event.sdk_session_id) {
          sdkSessionIdRef.value = event.sdk_session_id as string;
        }
      }),
    );

    expect(sdkSessionIdRef.value).toBe("sdk-sess-42");
  });

  it("onEvent callback does not crash on non-JSON lines", async () => {
    const chunks: string[] = [];
    const onEvent = vi.fn();
    const source = asyncLines(["not-json", JSON.stringify({ type: "assistant" })]);

    // Should not throw
    await collectAll(captureTranscript(source, chunks, tenantId, runId, onEvent));
    // Only called for the valid JSON line
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("passes through empty lines without storing", async () => {
    const chunks: string[] = [];
    const source = asyncLines(["", "  ", JSON.stringify({ type: "assistant" })]);

    const yielded = await collectAll(captureTranscript(source, chunks, tenantId, runId));
    expect(yielded).toHaveLength(3); // all yielded
    expect(chunks).toHaveLength(1);  // only non-empty stored
  });
});
