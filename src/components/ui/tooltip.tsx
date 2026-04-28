"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Lightweight CSS tooltip — no Radix dep. Hover/focus on the trigger reveals
 * the tooltip via group-hover/group-focus-within. For complex positioning,
 * adopt @radix-ui/react-tooltip later.
 */
interface TooltipProps {
  content: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  children: React.ReactElement;
  className?: string;
}

const sideClasses: Record<NonNullable<TooltipProps["side"]>, string> = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
  left: "right-full top-1/2 -translate-y-1/2 mr-1.5",
  right: "left-full top-1/2 -translate-y-1/2 ml-1.5",
};

export function Tooltip({ content, side = "top", children, className }: TooltipProps) {
  return (
    <span className="relative inline-flex group">
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-50 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs text-background opacity-0 shadow-md transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100",
          sideClasses[side],
          className,
        )}
      >
        {content}
      </span>
    </span>
  );
}
