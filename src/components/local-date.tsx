"use client";

export function LocalDate({ value, fallback = "—" }: { value: string | null; fallback?: string }) {
  if (!value) return <>{fallback}</>;
  return <>{new Date(value).toLocaleString()}</>;
}
