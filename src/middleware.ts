import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticateAdminFromCookie } from "@/lib/admin-auth";

// Paths that don't require authentication.
// NOTE: Uses prefix matching via startsWith — any new routes under these
// prefixes will also bypass auth. Cron routes use CRON_SECRET verification instead.
const PUBLIC_PATHS = ["/api/health", "/api/cron/", "/api/internal/"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname.startsWith(p));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // --- Admin UI pages ---
  if (pathname.startsWith("/admin")) {
    // Login page is always accessible
    if (pathname === "/admin/login") {
      return NextResponse.next();
    }
    // All other admin pages require cookie auth
    if (!(await authenticateAdminFromCookie(request))) {
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
    if (!(await authenticateAdminFromCookie(request))) {
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

  // A2A Agent Card is public (specific regex — NOT prefix match)
  if (/^\/api\/a2a\/[^/]+\/\.well-known\/agent-card\.json$/.test(pathname)) {
    return NextResponse.next();
  }

  // OAuth callbacks are unauthenticated (redirect from external provider)
  if (/^\/api\/agents\/[^/]+\/connectors\/[^/]+\/callback$/.test(pathname)) {
    return NextResponse.next();
  }

  // MCP OAuth callbacks are unauthenticated (redirect from external MCP server)
  if (/^\/api\/mcp-servers\/[^/]+\/callback$/.test(pathname)) {
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
    !token.startsWith("ap_admin_")
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
