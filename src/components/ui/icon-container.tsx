import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const iconContainerVariants = cva(
  "inline-flex shrink-0 items-center justify-center rounded-lg [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      size: {
        sm: "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        default: "size-8 [&_svg:not([class*='size-'])]:size-4",
        lg: "size-10 [&_svg:not([class*='size-'])]:size-5",
      },
      tone: {
        muted: "bg-muted text-foreground",
        accent: "bg-accent text-accent-foreground",
        primary: "bg-primary text-primary-foreground",
        destructive: "bg-destructive/10 text-destructive",
        outline: "border border-border text-foreground",
      },
    },
    defaultVariants: {
      size: "default",
      tone: "muted",
    },
  },
);

interface IconContainerProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof iconContainerVariants> {}

export function IconContainer({ className, size, tone, ...props }: IconContainerProps) {
  return <div className={cn(iconContainerVariants({ size, tone }), className)} {...props} />;
}
