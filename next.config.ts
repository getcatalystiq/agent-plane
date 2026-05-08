import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // discord.js (and its dep @discordjs/ws) lazy-imports `zlib-sync`, an
  // optional native dep that's NOT in our package.json. Runtime gracefully
  // falls back when it can't resolve (`.catch(() => null)`), but Turbopack's
  // static analysis fails the build trying to resolve the dynamic import.
  // Marking it as a server-external package leaves it as a runtime require
  // and skips the bundle-time resolution.
  serverExternalPackages: ["discord.js", "@discordjs/ws", "@chat-adapter/discord"],
  async redirects() {
    return [
      {
        source: "/admin/tenants/:path*",
        destination: "/admin/settings",
        permanent: false,
      },
    ];
  },
  async rewrites() {
    return [
      // WDK queue-callback proxy: route the framework's POST traffic
      // through wrappers that translate the framework's own
      // MessageNotAvailableError 500 (queue dedup, expected) to a 200.
      // See `src/app/api/internal/wdk-step-proxy/route.ts` for full
      // rationale. Sits under `/api/internal/` so middleware's public-
      // path bypass leaves it open to the external WDK queue.
      {
        source: "/.well-known/workflow/v1/step",
        destination: "/api/internal/wdk-step-proxy",
      },
      {
        source: "/.well-known/workflow/v1/flow",
        destination: "/api/internal/wdk-flow-proxy",
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

// Vercel Workflow DevKit (`workflow` package). The plugin transforms
// `"use workflow"` and `"use step"` directives at build time, generates the
// `/.well-known/workflow/v1/*` routes, and wires up filesystem-backed dev
// streams during `next dev`.
export default withWorkflow(nextConfig);
