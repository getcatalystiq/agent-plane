import * as React from "react";

export function Select({ className = "", ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`flex h-9 w-full rounded-md border border-input bg-transparent pl-3 pr-8 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring ${className}`}
      {...props}
    />
  );
}
