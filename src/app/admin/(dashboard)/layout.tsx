import Link from "next/link";
import Image from "next/image";
import { LogoutButton } from "./logout-button";
import { SidebarNav } from "./sidebar-nav";

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
        <SidebarNav />
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
