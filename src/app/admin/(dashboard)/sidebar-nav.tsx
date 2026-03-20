"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Bot, Play, Plug, Store, Settings, type LucideIcon } from "lucide-react";

const navItems = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/agents", label: "Agents", icon: Bot },
  { href: "/admin/mcp-servers", label: "Custom Connectors", icon: Plug },
  { href: "/admin/plugin-marketplaces", label: "Plugins", icon: Store },
  { href: "/admin/runs", label: "Runs", icon: Play },
];

const bottomItems = [
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

function NavLink({ href, label, icon: Icon, active }: { href: string; label: string; icon: LucideIcon; active: boolean }) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </Link>
  );
}

export function SidebarNav() {
  const pathname = usePathname();

  function isActive(href: string) {
    return href === "/admin"
      ? pathname === "/admin"
      : pathname.startsWith(href);
  }

  return (
    <nav className="flex-1 flex flex-col p-2">
      <div className="space-y-1 flex-1">
        {navItems.map((item) => (
          <NavLink key={item.href} {...item} active={isActive(item.href)} />
        ))}
      </div>

      {/* Divider + bottom items */}
      <div className="border-t border-border pt-2 mt-2 space-y-1">
        {bottomItems.map((item) => (
          <NavLink key={item.href} {...item} active={isActive(item.href)} />
        ))}
      </div>
    </nav>
  );
}
