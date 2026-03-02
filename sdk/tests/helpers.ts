import { vi } from "vitest";
import { AgentPlane } from "../src/index";

export function createClient(mockFetch: ReturnType<typeof vi.fn>) {
  return new AgentPlane({
    apiKey: "ap_live_test1234567890abcdef12345678",
    baseUrl: "http://localhost:3000",
    fetch: mockFetch as unknown as typeof fetch,
  });
}

export function jsonOk(data: unknown, status = 200) {
  return { ok: true, status, json: () => Promise.resolve(data) };
}

export function jsonError(status: number, error: { code: string; message: string }) {
  return {
    ok: false,
    status,
    headers: new Headers({ "content-length": "100" }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ error })),
        );
        controller.close();
      },
    }),
  };
}
