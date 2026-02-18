import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { put } from "@vercel/blob";
import { processLineAssets } from "@/lib/assets";

vi.mock("@vercel/blob", () => ({
  put: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

const VALID_COMPOSIO_URL =
  "https://temp.abc123def456.r2.cloudflarestorage.com/path/to/file.png";
const tenantId = "tenant-1";
const runId = "run-1";

function makeFetchResponse(
  ok: boolean,
  contentType = "image/png",
  body = Buffer.from("fakedata"),
) {
  return {
    ok,
    status: ok ? 200 : 404,
    headers: {
      get: vi.fn((name: string) => (name === "content-type" ? contentType : null)),
    },
    arrayBuffer: vi.fn().mockResolvedValue(body.buffer),
  };
}

describe("processLineAssets - fast path", () => {
  it("returns line unchanged when no r2.cloudflarestorage.com domain", async () => {
    global.fetch = vi.fn();
    const line = '{"type":"result","message":"no URLs here"}';
    const result = await processLineAssets(line, tenantId, runId);
    expect(result).toBe(line);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns line unchanged when r2 domain present but regex doesn't match (no temp. prefix)", async () => {
    global.fetch = vi.fn();
    const line = '{"url":"https://bucket.r2.cloudflarestorage.com/file.png"}';
    const result = await processLineAssets(line, tenantId, runId);
    expect(result).toBe(line);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("processLineAssets - URL replacement", () => {
  beforeEach(() => {
    vi.mocked(put).mockResolvedValue({
      url: "https://blob.vercel.com/stored-file.png",
    } as any);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("replaces a composio URL with blob URL", async () => {
    global.fetch = vi.fn().mockResolvedValue(makeFetchResponse(true, "image/png"));
    const line = `{"url":"${VALID_COMPOSIO_URL}"}`;
    const result = await processLineAssets(line, tenantId, runId);
    expect(result).toContain("https://blob.vercel.com/stored-file.png");
    expect(result).not.toContain(VALID_COMPOSIO_URL);
  });

  it("preserves original URL when fetch returns non-200", async () => {
    global.fetch = vi.fn().mockResolvedValue(makeFetchResponse(false, "image/png"));
    const line = `{"url":"${VALID_COMPOSIO_URL}"}`;
    const result = await processLineAssets(line, tenantId, runId);
    expect(result).toContain(VALID_COMPOSIO_URL);
  });

  it("preserves original URL when put throws", async () => {
    global.fetch = vi.fn().mockResolvedValue(makeFetchResponse(true, "image/png"));
    vi.mocked(put).mockRejectedValue(new Error("blob error"));
    const line = `{"url":"${VALID_COMPOSIO_URL}"}`;
    const result = await processLineAssets(line, tenantId, runId);
    expect(result).toContain(VALID_COMPOSIO_URL);
  });

  it("deduplicates URLs and fetches each once", async () => {
    global.fetch = vi.fn().mockResolvedValue(makeFetchResponse(true, "image/png"));
    const line = `{"a":"${VALID_COMPOSIO_URL}","b":"${VALID_COMPOSIO_URL}"}`;
    const result = await processLineAssets(line, tenantId, runId);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // Both occurrences should be replaced
    expect(result.match(/blob\.vercel\.com/g)).toHaveLength(2);
  });
});

describe("MIME type to extension mapping", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  async function getExtForMime(mime: string): Promise<string> {
    global.fetch = vi.fn().mockResolvedValue(makeFetchResponse(true, mime));
    vi.mocked(put).mockResolvedValue({ url: "https://blob.vercel.com/file" } as any);
    const line = `"${VALID_COMPOSIO_URL}"`;
    await processLineAssets(line, tenantId, runId);
    const putCall = vi.mocked(put).mock.calls[0];
    const path = putCall[0] as string;
    return path.split(".").pop()!;
  }

  it("image/png -> .png", async () => {
    expect(await getExtForMime("image/png")).toBe("png");
  });

  it("image/jpeg -> .jpg", async () => {
    expect(await getExtForMime("image/jpeg")).toBe("jpg");
  });

  it("image/gif -> .gif", async () => {
    expect(await getExtForMime("image/gif")).toBe("gif");
  });

  it("image/webp -> .webp", async () => {
    expect(await getExtForMime("image/webp")).toBe("webp");
  });

  it("image/svg+xml -> .svg", async () => {
    expect(await getExtForMime("image/svg+xml")).toBe("svg");
  });

  it("application/pdf -> .pdf", async () => {
    expect(await getExtForMime("application/pdf")).toBe("pdf");
  });

  it("unknown mime type -> .bin", async () => {
    expect(await getExtForMime("text/plain")).toBe("bin");
  });

  it("missing content-type -> .bin", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: vi.fn().mockReturnValue(null) },
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from("data").buffer),
    });
    vi.mocked(put).mockResolvedValue({ url: "https://blob.vercel.com/file" } as any);
    const line = `"${VALID_COMPOSIO_URL}"`;
    await processLineAssets(line, tenantId, runId);
    const path = vi.mocked(put).mock.calls[0][0] as string;
    expect(path.split(".").pop()).toBe("bin");
  });
});

describe("blob path format", () => {
  it("stores at assets/{tenantId}/{runId}/{uuid}.{ext}", async () => {
    global.fetch = vi.fn().mockResolvedValue(makeFetchResponse(true, "image/png"));
    vi.mocked(put).mockResolvedValue({ url: "https://blob.vercel.com/file.png" } as any);
    const line = `"${VALID_COMPOSIO_URL}"`;
    await processLineAssets(line, "my-tenant", "my-run");
    const putCall = vi.mocked(put).mock.calls[0];
    expect(putCall[0]).toMatch(/^assets\/my-tenant\/my-run\/.+\.png$/);
    expect(putCall[2]).toMatchObject({ access: "public", addRandomSuffix: true });
  });
});
