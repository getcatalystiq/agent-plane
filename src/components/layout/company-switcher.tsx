"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, Search, Check } from "lucide-react";

interface Company {
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

export function CompanySwitcher() {
  const router = useRouter();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeCompanyId, setActiveCompanyId] = useState<string | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Fetch companies
  useEffect(() => {
    const controller = new AbortController();
    async function fetchCompanies() {
      try {
        const res = await fetch("/api/admin/tenants", {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = await res.json();
        const list: Company[] = Array.isArray(data) ? data : data.data ?? data.tenants ?? [];
        setCompanies(list);

        // Set active company from cookie or default to first
        const cookieId = getActiveTenantFromCookie();
        if (cookieId && list.some((t) => t.id === cookieId)) {
          setActiveCompanyId(cookieId);
        } else if (list.length > 0) {
          setActiveCompanyId(list[0].id);
          setActiveTenantCookie(list[0].id);
        }
      } catch {
        // AbortError or network error — ignore
      } finally {
        setLoading(false);
      }
    }
    fetchCompanies();
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
    (company: Company) => {
      setActiveCompanyId(company.id);
      setActiveTenantCookie(company.id);
      setOpen(false);
      router.refresh();
    },
    [router]
  );

  const activeCompany = companies.find((t) => t.id === activeCompanyId);
  const activeCompanyIndex = companies.findIndex((t) => t.id === activeCompanyId);

  const filtered = search
    ? companies.filter((t) =>
        t.name.toLowerCase().includes(search.toLowerCase())
      )
    : companies;

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
        className="flex items-center gap-2 w-full h-12 px-4 hover:bg-accent/50 transition-colors"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        {activeCompany ? (
          <>
            {activeCompany.logo_url ? (
              <img src={activeCompany.logo_url} alt="" className="w-5 h-5 rounded object-cover shrink-0" />
            ) : (
              <span
                className="w-5 h-5 rounded text-[9px] font-bold text-white flex items-center justify-center shrink-0"
                style={{
                  backgroundColor: getAvatarColor(
                    activeCompanyIndex >= 0 ? activeCompanyIndex : 0
                  ),
                }}
              >
                {getInitial(activeCompany.name)}
              </span>
            )}
            <span className="text-[13px] font-semibold text-foreground tracking-[-0.01em] truncate min-w-0">
              {activeCompany.name}
            </span>
          </>
        ) : (
          <span className="text-[13px] text-muted-foreground">
            No company selected
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
          aria-label="Select company"
        >
          {/* Search */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
            <Search className="size-3.5 text-muted-foreground shrink-0" />
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search companies..."
              className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
            />
            <kbd className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono">
              Esc
            </kbd>
          </div>

          {/* Company list */}
          <div className="max-h-[240px] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[13px] text-muted-foreground">
                No companies found
              </div>
            ) : (
              filtered.map((company) => {
                const index = companies.indexOf(company);
                const isSelected = company.id === activeCompanyId;
                return (
                  <button
                    key={company.id}
                    onClick={() => handleSelect(company)}
                    className={`flex items-center gap-3 w-full px-3 py-2 text-[13px] font-medium hover:bg-accent transition-colors ${
                      isSelected ? "bg-accent/50" : ""
                    }`}
                    role="option"
                    aria-selected={isSelected}
                  >
                    {company.logo_url ? (
                      <img src={company.logo_url} alt="" className="w-5 h-5 rounded object-cover shrink-0" />
                    ) : (
                      <span
                        className="w-5 h-5 rounded text-[9px] font-bold text-white flex items-center justify-center shrink-0"
                        style={{ backgroundColor: getAvatarColor(index) }}
                      >
                        {getInitial(company.name)}
                      </span>
                    )}
                    <span className="truncate flex-1 text-left">
                      {company.name}
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
