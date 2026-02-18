import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "@/lib/crypto";
import { createAdminSession, setAdminCookie, clearAdminCookie } from "@/lib/admin-auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(async (request: NextRequest) => {
  // Rate limit: 5 attempts per minute per IP
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rl = checkRateLimit(`admin-login:${ip}`, 5, 60_000);
  if (!rl.allowed) {
    return jsonResponse(
      { error: { code: "rate_limited", message: "Too many login attempts" } },
      429,
    );
  }

  const body = await request.json();
  const { password } = body;

  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey || !password || !timingSafeEqual(password, adminKey)) {
    return jsonResponse({ error: { code: "unauthorized", message: "Invalid credentials" } }, 401);
  }

  const sessionToken = await createAdminSession();
  const response = NextResponse.json({ ok: true });
  setAdminCookie(response, sessionToken);
  return response;
});

export const DELETE = withErrorHandler(async () => {
  const response = NextResponse.json({ ok: true });
  clearAdminCookie(response);
  return response;
});
