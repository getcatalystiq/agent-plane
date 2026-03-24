"use client";

import { useMemo } from "react";

export function LocalDate({ value, fallback = "—" }: { value: string | null; fallback?: string }) {
  const formatted = useMemo(() => value ? new Date(value).toLocaleString() : null, [value]);
  if (!formatted) return <>{fallback}</>;
  return <>{formatted}</>;
}
