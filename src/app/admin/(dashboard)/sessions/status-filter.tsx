"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Select } from "@/components/ui/select";

const STATUSES = [
  { value: "", label: "All Statuses" },
  { value: "creating", label: "Creating" },
  { value: "active", label: "Active" },
  { value: "idle", label: "Idle" },
  { value: "stopped", label: "Stopped" },
];

export function StatusFilter({ current }: { current: string | null }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("status", value);
    else params.delete("status");
    params.delete("page");
    const qs = params.toString();
    router.push(`/admin/sessions${qs ? `?${qs}` : ""}`);
  }

  return (
    <div className="w-40">
      <Select value={current ?? ""} onChange={handleChange}>
        {STATUSES.map((s) => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
      </Select>
    </div>
  );
}
