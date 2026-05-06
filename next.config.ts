import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      {
        source: "/admin/tenants/:path*",
        destination: "/admin/settings",
        permanent: false,
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
