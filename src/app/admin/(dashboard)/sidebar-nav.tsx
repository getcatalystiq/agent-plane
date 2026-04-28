"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Bot, Plug, Store, Settings, Activity, type LucideIcon } from "lucide-react";

const navItems = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/agents", label: "Agents", icon: Bot },
  { href: "/admin/mcp-servers", label: "Custom Connectors", icon: Plug },
  { href: "/admin/plugin-marketplaces", label: "Plugins", icon: Store },
  { href: "/admin/sessions", label: "Runs", icon: Activity },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

function NavLink({ href, label, icon: Icon, active }: { href: string; label: string; icon: LucideIcon; active: boolean }) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      }`}
    >
      <Icon className="size-4 shrink-0" />
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
    <nav className="flex-1 flex flex-col px-2 py-2">
      <div className="space-y-1 flex-1">
        {navItems.map((item) => (
          <NavLink key={item.href} {...item} active={isActive(item.href)} />
        ))}
      </div>
    </nav>
  );
}
