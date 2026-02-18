import Link from "next/link";
import Image from "next/image";
import { LayoutDashboard, Users, Bot, Play, Plug } from "lucide-react";
import { LogoutButton } from "./logout-button";

const navItems = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/tenants", label: "Tenants", icon: Users },
  { href: "/admin/agents", label: "Agents", icon: Bot },
  { href: "/admin/runs", label: "Runs", icon: Play },
  { href: "/admin/mcp-servers", label: "Custom Connectors", icon: Plug },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="dark flex min-h-screen bg-background text-foreground">
      {/* Sidebar */}
      <aside className="w-56 border-r border-border flex flex-col">
        <div className="p-4 border-b border-border">
          <Link href="/admin" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Image src="/logo-32.png" alt="AgentPlane" width={24} height={24} className="shrink-0" />
            AgentPlane
          </Link>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="p-2 border-t border-border">
          <LogoutButton />
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="p-8">{children}</div>
      </main>
    </div>
  );
}
