import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const spinnerVariants = cva("inline-block animate-spin rounded-full border-current border-t-transparent text-muted-foreground", {
  variants: {
    size: {
      sm: "size-3 border",
      default: "size-4 border-2",
      lg: "size-5 border-2",
    },
  },
  defaultVariants: { size: "default" },
});

interface SpinnerProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "role">, VariantProps<typeof spinnerVariants> {
  label?: string;
}

export function Spinner({ className, size, label = "Loading", ...props }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(spinnerVariants({ size }), className)}
      {...props}
    />
  );
}
