"use client";

import { type ReactNode } from "react";
import { Tabs } from "@/components/ui/tabs";

export function AgentTabs({
  general,
  identity,
  runs,
  connectors,
  skills,
  plugins,
  schedules,
  webhooks,
}: {
  general: ReactNode;
  identity: ReactNode;
  runs: ReactNode;
  connectors: ReactNode;
  skills: ReactNode;
  plugins: ReactNode;
  schedules: ReactNode;
  webhooks: ReactNode;
}) {
  return (
    <Tabs
      tabs={[
        { label: "General", content: general },
        { label: "Identity", content: identity },
        { label: "Connectors", content: connectors },
        { label: "Skills", content: skills },
        { label: "Plugins", content: plugins },
        { label: "Schedules", content: schedules },
        { label: "Webhooks", content: webhooks },
        { label: "Runs", content: runs },
      ]}
    />
  );
}
