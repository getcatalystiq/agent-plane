import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { NotFoundError, RateLimitError, AppError } from "@/lib/errors";

// Mock next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((data: unknown, init?: { status?: number }) => ({
      _body: data,
      _status: init?.status ?? 200,
    })),
  },
  NextRequest: vi.fn(),
}));

// Mock logger to suppress output
vi.mock("@/lib/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { jsonResponse, errorResponse, withErrorHandler } from "@/lib/api";

describe("jsonResponse", () => {
  it("defaults to status 200", () => {
    const res = jsonResponse({ ok: true }) as any;
    expect(res._status).toBe(200);
  });

  it("passes through custom status", () => {
    const res = jsonResponse({ created: true }, 201) as any;
    expect(res._status).toBe(201);
  });

  it("passes data to NextResponse.json", () => {
    const data = { foo: "bar", count: 42 };
    const res = jsonResponse(data) as any;
    expect(res._body).toEqual(data);
  });
});

describe("errorResponse", () => {
  it("handles AppError with correct statusCode and body", () => {
    const err = new AppError("custom_error", 422, "Something went wrong");
    const res = errorResponse(err) as any;
    expect(res._status).toBe(422);
    expect(res._body).toEqual({
      error: { code: "custom_error", message: "Something went wrong" },
    });
  });

  it("handles NotFoundError → 404", () => {
    const err = new NotFoundError("Agent not found");
    const res = errorResponse(err) as any;
    expect(res._status).toBe(404);
    expect(res._body.error.code).toBe("not_found");
    expect(res._body.error.message).toBe("Agent not found");
  });

  it("handles RateLimitError → 429", () => {
    const err = new RateLimitError();
    const res = errorResponse(err) as any;
    expect(res._status).toBe(429);
    expect(res._body.error.code).toBe("rate_limited");
  });

  it("handles ZodError → 400, code 'validation_error'", () => {
    const schema = z.object({ email: z.string().email() });
    let zodError: z.ZodError;
    try {
      schema.parse({ email: "bad" });
    } catch (e) {
      zodError = e as z.ZodError;
    }
    const res = errorResponse(zodError!) as any;
    expect(res._status).toBe(400);
    expect(res._body.error.code).toBe("validation_error");
  });

  it("ZodError message includes field path", () => {
    const schema = z.object({ email: z.string().email() });
    let zodError: z.ZodError;
    try {
      schema.parse({ email: "bad" });
    } catch (e) {
      zodError = e as z.ZodError;
    }
    const res = errorResponse(zodError!) as any;
    expect(res._body.error.message).toContain("email");
  });

  it("handles unknown Error → 500, code 'internal_error'", () => {
    const err = new Error("Something unexpected");
    const res = errorResponse(err) as any;
    expect(res._status).toBe(500);
    expect(res._body).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
  });

  it("handles non-Error thrown value → 500", () => {
    const res = errorResponse("string error") as any;
    expect(res._status).toBe(500);
    expect(res._body).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
  });
});

describe("withErrorHandler", () => {
  it("passes through successful handler result", async () => {
    const handler = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const wrapped = withErrorHandler(handler);
    const result = (await wrapped({} as any)) as any;
    expect(result._status).toBe(200);
    expect(result._body).toEqual({ ok: true });
  });

  it("catches thrown AppError", async () => {
    const handler = vi.fn().mockRejectedValue(new NotFoundError("Not found"));
    const wrapped = withErrorHandler(handler);
    const result = (await wrapped({} as any)) as any;
    expect(result._status).toBe(404);
    expect(result._body.error.code).toBe("not_found");
  });

  it("catches thrown ZodError → 400", async () => {
    const schema = z.object({ name: z.string() });
    let zodError: z.ZodError;
    try {
      schema.parse({ name: 123 });
    } catch (e) {
      zodError = e as z.ZodError;
    }
    const handler = vi.fn().mockRejectedValue(zodError!);
    const wrapped = withErrorHandler(handler);
    const result = (await wrapped({} as any)) as any;
    expect(result._status).toBe(400);
    expect(result._body.error.code).toBe("validation_error");
  });

  it("catches unknown error → 500", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    const wrapped = withErrorHandler(handler);
    const result = (await wrapped({} as any)) as any;
    expect(result._status).toBe(500);
    expect(result._body.error.code).toBe("internal_error");
  });

  it("calls handler with original request and context", async () => {
    const handler = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const wrapped = withErrorHandler(handler);
    const mockReq = { url: "http://test.com" } as any;
    const mockCtx = { params: Promise.resolve({ id: "123" }) } as any;
    await wrapped(mockReq, mockCtx);
    expect(handler).toHaveBeenCalledWith(mockReq, mockCtx);
  });
});
