import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createAdminSession,
  authenticateAdminFromCookie,
  setAdminCookie,
  clearAdminCookie,
} from "@/lib/admin-auth";

// Mock next/server minimally
vi.mock("next/server", () => ({
  NextRequest: vi.fn(),
  NextResponse: vi.fn(),
}));

describe("createAdminSession", () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = "test-admin-key-12345";
  });
  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  it("returns string with single dot separator", async () => {
    const token = await createAdminSession();
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  it("produces unique tokens on repeated calls", async () => {
    const t1 = await createAdminSession();
    const t2 = await createAdminSession();
    expect(t1).not.toBe(t2);
  });

  it("throws when ADMIN_API_KEY is not set", async () => {
    delete process.env.ADMIN_API_KEY;
    await expect(createAdminSession()).rejects.toThrow("ADMIN_API_KEY not set");
  });
});

describe("authenticateAdminFromCookie", () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = "test-admin-key-12345";
  });
  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
    vi.restoreAllMocks();
  });

  function makeRequest(cookieValue?: string) {
    return {
      cookies: {
        get: vi.fn((name: string) =>
          cookieValue ? { value: cookieValue } : undefined,
        ),
      },
    } as any;
  }

  it("returns true for a fresh valid token", async () => {
    const token = await createAdminSession();
    const req = makeRequest(token);
    expect(await authenticateAdminFromCookie(req)).toBe(true);
  });

  it("returns false when cookie is missing", async () => {
    const req = makeRequest(undefined);
    expect(await authenticateAdminFromCookie(req)).toBe(false);
  });

  it("returns false for tampered payload", async () => {
    const token = await createAdminSession();
    const [, sig] = token.split(".");
    const fakePayload = btoa(
      JSON.stringify({ iat: Date.now(), exp: Date.now() + 999999999 }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const tamperedToken = `${fakePayload}.${sig}`;
    const req = makeRequest(tamperedToken);
    expect(await authenticateAdminFromCookie(req)).toBe(false);
  });

  it("returns false for tampered signature", async () => {
    const token = await createAdminSession();
    const [payload] = token.split(".");
    const tamperedToken = `${payload}.invalidsignature`;
    const req = makeRequest(tamperedToken);
    expect(await authenticateAdminFromCookie(req)).toBe(false);
  });

  it("returns false for token without dot separator", async () => {
    const req = makeRequest("notadottoken");
    expect(await authenticateAdminFromCookie(req)).toBe(false);
  });

  it("returns false for expired token", async () => {
    const token = await createAdminSession();
    // Stub Date.now to return a time 8 days in the future
    const futureTime = Date.now() + 8 * 24 * 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(futureTime);
    const req = makeRequest(token);
    expect(await authenticateAdminFromCookie(req)).toBe(false);
  });
});

describe("setAdminCookie", () => {
  it("sets httpOnly cookie with correct options", () => {
    const setCookieSpy = vi.fn();
    const mockResponse = { cookies: { set: setCookieSpy } } as any;
    setAdminCookie(mockResponse, "mytoken");
    expect(setCookieSpy).toHaveBeenCalledWith(
      "admin_session",
      "mytoken",
      expect.objectContaining({
        httpOnly: true,
        path: "/",
        maxAge: 60 * 60 * 24 * 7,
      }),
    );
  });
});

describe("clearAdminCookie", () => {
  it("deletes the admin_session cookie", () => {
    const deleteCookieSpy = vi.fn();
    const mockResponse = { cookies: { delete: deleteCookieSpy } } as any;
    clearAdminCookie(mockResponse);
    expect(deleteCookieSpy).toHaveBeenCalledWith("admin_session");
  });
});
