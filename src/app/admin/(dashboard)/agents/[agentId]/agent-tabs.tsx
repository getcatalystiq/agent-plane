"use client";

import { type ReactNode } from "react";
import { Tabs } from "@/components/ui/tabs";

export function AgentTabs({
  general,
  runs,
  connectors,
  skills,
  plugins,
  schedules,
}: {
  general: ReactNode;
  runs: ReactNode;
  connectors: ReactNode;
  skills: ReactNode;
  plugins: ReactNode;
  schedules: ReactNode;
}) {
  return (
    <Tabs
      tabs={[
        { label: "General", content: general },
        { label: "Connectors", content: connectors },
        { label: "Skills", content: skills },
        { label: "Plugins", content: plugins },
        { label: "Schedules", content: schedules },
        { label: "Runs", content: runs },
      ]}
    />
  );
}
