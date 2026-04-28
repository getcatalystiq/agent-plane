"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Select } from "@/components/ui/select";

const SOURCES = [
  { value: "", label: "All Triggers" },
  { value: "api", label: "API" },
  { value: "schedule", label: "Schedule" },
  { value: "playground", label: "Playground" },
  { value: "chat", label: "Chat" },
  { value: "a2a", label: "A2A" },
  { value: "webhook", label: "Webhook" },
];

export function SourceFilter({ current }: { current: string | null }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("source", value);
    else params.delete("source");
    params.delete("page");
    const qs = params.toString();
    router.push(`/admin/sessions${qs ? `?${qs}` : ""}`);
  }

  return (
    <div className="w-40">
      <Select value={current ?? ""} onChange={handleChange}>
        {SOURCES.map((s) => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
      </Select>
    </div>
  );
}
