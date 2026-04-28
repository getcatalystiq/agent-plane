"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

const ROUTE_LABELS: Record<string, string> = {
  "/admin": "Dashboard",
  "/admin/agents": "Agents",
  "/admin/mcp-servers": "Custom Connectors",
  "/admin/plugin-marketplaces": "Plugins",
  "/admin/sessions": "Runs",
  "/admin/tenants": "Tenants",
  "/admin/settings": "Settings",
};

// Resolve a detail-page ID to a human-readable name
function useEntityName(parentRoute: string, entityId: string | undefined): string | null {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    if (!entityId) return;

    const apiMap: Record<string, string> = {
      "/admin/agents": `/api/admin/agents/${entityId}`,
      "/admin/sessions": `/api/admin/sessions/${entityId}`,
      "/admin/plugin-marketplaces": `/api/admin/plugin-marketplaces/${entityId}`,
      "/admin/tenants": `/api/admin/tenants/${entityId}`,
    };

    const url = apiMap[parentRoute];
    if (!url) return;

    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data) return;
        // Agents API returns { agent, ... }, sessions returns flat session row.
        const entity = data.agent ?? data.session ?? data.marketplace ?? data.tenant ?? data;
        const resolved = entity?.name ?? entity?.slug;
        if (resolved) {
          setName(resolved);
        } else if (entity?.id) {
          // For sessions, show short ID
          setName(entity.id.slice(0, 8) + "...");
        }
      })
      .catch(() => {});

    return () => controller.abort();
  }, [parentRoute, entityId]);

  return name;
}

export function TopBar() {
  const pathname = usePathname();

  // Build breadcrumb segments from pathname
  const segments = pathname.split("/").filter(Boolean); // ["admin", "agents", "abc123"]
  const crumbs: { label: string; href: string; isEntityId: boolean }[] = [];

  let parentRoute = "";
  let entityId: string | undefined;

  for (let i = 1; i < segments.length; i++) {
    const href = "/" + segments.slice(0, i + 1).join("/");
    const label = ROUTE_LABELS[href];
    if (label) {
      crumbs.push({ label, href, isEntityId: false });
      parentRoute = href;
    } else {
      // Check if this is a known sub-page name (e.g. "playground")
      const subPageLabels: Record<string, string> = {
        playground: "Playground",
        plugins: "Plugins",
        connectors: "Connectors",
        schedule: "Schedule",
      };
      const subLabel = subPageLabels[segments[i]];
      if (subLabel) {
        crumbs.push({ label: subLabel, href, isEntityId: false });
      } else {
        // Detail page — will resolve name
        entityId = segments[i];
        crumbs.push({
          label: segments[i].length > 12 ? segments[i].slice(0, 8) + "..." : segments[i],
          href,
          isEntityId: true,
        });
      }
    }
  }

  // If on /admin exactly, show "Dashboard"
  if (crumbs.length === 0) {
    crumbs.push({ label: "Dashboard", href: "/admin", isEntityId: false });
  }

  const resolvedName = useEntityName(parentRoute, entityId);

  return (
    <div className="flex items-center h-12 px-6 border-b border-border shrink-0">
      {crumbs.map((crumb, i) => {
        const displayLabel = crumb.isEntityId && resolvedName ? resolvedName : crumb.label;
        return (
          <div key={crumb.href} className="flex items-center">
            {i > 0 && (
              <ChevronRight className="size-3.5 text-muted-foreground mx-2" />
            )}
            {i === crumbs.length - 1 ? (
              <span className="text-sm font-medium text-foreground">
                {displayLabel}
              </span>
            ) : (
              <Link
                href={crumb.href}
                className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                {displayLabel}
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
}
