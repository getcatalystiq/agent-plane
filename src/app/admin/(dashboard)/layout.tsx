import Script from "next/script";
import { LogoutButton } from "./logout-button";
import { SidebarNav } from "./sidebar-nav";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { TenantSwitcher } from "@/components/layout/tenant-switcher";
import { TopBar } from "@/components/layout/top-bar";

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
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        {/* Sidebar */}
        <aside className="w-56 border-r border-border flex flex-col shrink-0">
          <TenantSwitcher />
          <SidebarNav />
          <div className="p-2 border-t border-border flex items-center justify-between">
            <LogoutButton />
            <ThemeToggle />
          </div>
        </aside>

        {/* Main content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <TopBar />
          <main className="flex-1 overflow-auto p-6">{children}</main>
        </div>
      </div>
    </>
  );
}
