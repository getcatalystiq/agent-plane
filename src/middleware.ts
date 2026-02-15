import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticateAdminFromCookie } from "@/lib/admin-auth";

// Paths that don't require authentication
const PUBLIC_PATHS = ["/api/health", "/api/cron/"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname.startsWith(p));
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // --- Admin UI pages ---
  if (pathname.startsWith("/admin")) {
    // Login page is always accessible
    if (pathname === "/admin/login") {
      return NextResponse.next();
    }
    // All other admin pages require cookie auth
    if (!authenticateAdminFromCookie(request)) {
      const loginUrl = new URL("/admin/login", request.url);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next();
  }

  // --- Admin API routes ---
  if (pathname.startsWith("/api/admin")) {
    // Login API is public
    if (pathname === "/api/admin/login") {
      return NextResponse.next();
    }
    if (!authenticateAdminFromCookie(request)) {
      return NextResponse.json(
        { error: { code: "unauthorized", message: "Admin authentication required" } },
        { status: 401 },
      );
    }
    return NextResponse.next();
  }

  // --- Tenant API routes ---
  if (!pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // Skip auth for public paths
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Check for Authorization header
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Missing Authorization header" } },
      { status: 401 },
    );
  }

  const token = authHeader.slice(7);

  // O(1) prefix validation -- no DB call in middleware
  if (
    !token.startsWith("ap_live_") &&
    !token.startsWith("ap_test_") &&
    !token.startsWith("ap_admin_") &&
    token !== process.env.ADMIN_API_KEY
  ) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Invalid API key format" } },
      { status: 401 },
    );
  }

  // Token format is valid -- pass to route handler for full DB verification
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*", "/admin/:path*"],
};
