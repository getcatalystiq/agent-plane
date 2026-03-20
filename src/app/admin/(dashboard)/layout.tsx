import Link from "next/link";
import Image from "next/image";
import Script from "next/script";
import { LogoutButton } from "./logout-button";
import { SidebarNav } from "./sidebar-nav";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { TenantSwitcher } from "@/components/layout/tenant-switcher";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Script
        id="theme-init"
        strategy="beforeInteractive"
        dangerouslySetInnerHTML={{
          __html: `(function(){try{var t=localStorage.getItem('ap-theme');if(t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme:dark)').matches))document.documentElement.classList.add('dark');else document.documentElement.classList.remove('dark')}catch(e){}})()`,
        }}
      />
      <div className="flex min-h-screen bg-background text-foreground">
        {/* Sidebar */}
        <aside className="w-56 border-r border-border flex flex-col">
          <div className="p-4 border-b border-border">
            <Link href="/admin" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
              <Image src="/logo-32.png" alt="AgentPlane" width={24} height={24} className="shrink-0" />
              AgentPlane
            </Link>
          </div>
          <TenantSwitcher />
          <SidebarNav />
          <div className="p-2 border-t border-border flex items-center justify-between">
            <LogoutButton />
            <ThemeToggle />
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-auto">
          <div className="p-6">{children}</div>
        </main>
      </div>
    </>
  );
}
