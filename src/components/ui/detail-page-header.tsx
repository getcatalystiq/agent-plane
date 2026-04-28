import * as React from "react";
import { cn } from "@/lib/utils";

interface DetailPageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Optional metadata row rendered above the title (badges, slugs, IDs). */
  eyebrow?: React.ReactNode;
  /** Action buttons rendered on the right. */
  actions?: React.ReactNode;
  className?: string;
}

export function DetailPageHeader({
  title,
  description,
  eyebrow,
  actions,
  className,
}: DetailPageHeaderProps) {
  return (
    <div className={cn("flex items-start justify-between gap-4 mb-6", className)}>
      <div className="min-w-0 flex-1 space-y-1.5">
        {eyebrow ? <div className="flex items-center gap-2 text-xs text-muted-foreground">{eyebrow}</div> : null}
        <h1 className="text-2xl font-semibold leading-tight truncate">{title}</h1>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
