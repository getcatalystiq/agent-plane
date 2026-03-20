"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, Search, Check } from "lucide-react";

interface Tenant {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
}

const AVATAR_COLORS = [
  "#635bff",
  "#171717",
  "#5e6ad2",
  "#0ea5e9",
  "#f97316",
  "#10b981",
  "#ec4899",
  "#8b5cf6",
];

function getAvatarColor(index: number): string {
  return AVATAR_COLORS[index % AVATAR_COLORS.length];
}

function getInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

function getActiveTenantFromCookie(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)ap-active-tenant=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function setActiveTenantCookie(tenantId: string) {
  document.cookie = `ap-active-tenant=${encodeURIComponent(tenantId)};path=/;SameSite=Lax;Secure;max-age=${60 * 60 * 24 * 365}`;
}

export function TenantSwitcher() {
  const router = useRouter();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeTenantId, setActiveTenantId] = useState<string | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Fetch tenants
  useEffect(() => {
    const controller = new AbortController();
    async function fetchTenants() {
      try {
        const res = await fetch("/api/admin/tenants", {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = await res.json();
        const list: Tenant[] = Array.isArray(data) ? data : data.data ?? data.tenants ?? [];
        setTenants(list);

        // Set active tenant from cookie or default to first
        const cookieId = getActiveTenantFromCookie();
        if (cookieId && list.some((t) => t.id === cookieId)) {
          setActiveTenantId(cookieId);
        } else if (list.length > 0) {
          setActiveTenantId(list[0].id);
          setActiveTenantCookie(list[0].id);
        }
      } catch {
        // AbortError or network error — ignore
      } finally {
        setLoading(false);
      }
    }
    fetchTenants();
    return () => controller.abort();
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Focus search input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => searchInputRef.current?.focus(), 0);
    } else {
      setSearch("");
    }
  }, [open]);

  // Keyboard: Esc to close
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    },
    []
  );

  const handleSelect = useCallback(
    (tenant: Tenant) => {
      setActiveTenantId(tenant.id);
      setActiveTenantCookie(tenant.id);
      setOpen(false);
      router.refresh();
    },
    [router]
  );

  const activeTenant = tenants.find((t) => t.id === activeTenantId);
  const activeTenantIndex = tenants.findIndex((t) => t.id === activeTenantId);

  const filtered = search
    ? tenants.filter((t) =>
        t.name.toLowerCase().includes(search.toLowerCase())
      )
    : tenants;

  // Loading skeleton
  if (loading) {
    return (
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 rounded bg-muted animate-pulse" />
          <div className="h-4 w-24 rounded bg-muted animate-pulse" />
        </div>
      </div>
    );
  }

  return (
    <div className="relative border-b border-border">
      {/* Trigger */}
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-3 w-full h-12 px-4 hover:bg-accent/50 transition-colors"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        {activeTenant ? (
          <>
            {activeTenant.logo_url ? (
              <img src={activeTenant.logo_url} alt="" className="w-5 h-5 rounded object-cover shrink-0" />
            ) : (
              <span
                className="w-5 h-5 rounded text-[9px] font-bold text-white flex items-center justify-center shrink-0"
                style={{
                  backgroundColor: getAvatarColor(
                    activeTenantIndex >= 0 ? activeTenantIndex : 0
                  ),
                }}
              >
                {getInitial(activeTenant.name)}
              </span>
            )}
            <span className="text-[13px] font-semibold tracking-[-0.01em] truncate flex-1 text-left">
              {activeTenant.name}
            </span>
          </>
        ) : (
          <span className="text-[13px] text-muted-foreground">
            No tenant selected
          </span>
        )}
        <ChevronsUpDown className="size-3.5 text-muted-foreground shrink-0 ml-auto" />
      </button>

      {/* Dropdown */}
      {open && (
        <div
          ref={dropdownRef}
          className="absolute left-2 top-full mt-1 z-50 w-[240px] rounded-lg border border-border shadow-lg bg-popover"
          onKeyDown={handleKeyDown}
          role="listbox"
          aria-label="Select tenant"
        >
          {/* Search */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
            <Search className="size-3.5 text-muted-foreground shrink-0" />
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tenants..."
              className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
            />
            <kbd className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono">
              Esc
            </kbd>
          </div>

          {/* Tenant list */}
          <div className="max-h-[240px] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[13px] text-muted-foreground">
                No tenants found
              </div>
            ) : (
              filtered.map((tenant) => {
                const index = tenants.indexOf(tenant);
                const isSelected = tenant.id === activeTenantId;
                return (
                  <button
                    key={tenant.id}
                    onClick={() => handleSelect(tenant)}
                    className={`flex items-center gap-3 w-full px-3 py-2 text-[13px] font-medium hover:bg-accent transition-colors ${
                      isSelected ? "bg-accent/50" : ""
                    }`}
                    role="option"
                    aria-selected={isSelected}
                  >
                    {tenant.logo_url ? (
                      <img src={tenant.logo_url} alt="" className="w-5 h-5 rounded object-cover shrink-0" />
                    ) : (
                      <span
                        className="w-5 h-5 rounded text-[9px] font-bold text-white flex items-center justify-center shrink-0"
                        style={{ backgroundColor: getAvatarColor(index) }}
                      >
                        {getInitial(tenant.name)}
                      </span>
                    )}
                    <span className="truncate flex-1 text-left">
                      {tenant.name}
                    </span>
                    {isSelected && (
                      <Check className="size-3.5 text-foreground shrink-0" />
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
