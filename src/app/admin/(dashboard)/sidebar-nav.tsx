"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Users, Bot, Play, Plug, Store } from "lucide-react";

const navItems = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/tenants", label: "Tenants", icon: Users },
  { href: "/admin/agents", label: "Agents", icon: Bot },
  { href: "/admin/runs", label: "Runs", icon: Play },
  { href: "/admin/mcp-servers", label: "Custom Connectors", icon: Plug },
  { href: "/admin/plugin-marketplaces", label: "Plugins", icon: Store },
];

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav className="flex-1 p-2 space-y-1">
      {navItems.map((item) => {
        const isActive =
          item.href === "/admin"
            ? pathname === "/admin"
            : pathname.startsWith(item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
              isActive
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            }`}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
