import * as React from "react";
import { cn } from "@/lib/utils/cn";

type BadgeVariant = "default" | "secondary" | "outline" | "success" | "warning" | "danger";

const variantStyles: Record<BadgeVariant, string> = {
  default: "bg-primary/10 text-primary border-primary/20",
  secondary: "bg-muted text-muted-foreground border-border",
  outline: "bg-background text-foreground border-border",
  success: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300 dark:border-emerald-400/35",
  warning: "bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-300 dark:border-amber-400/35",
  danger: "bg-red-500/10 text-red-700 border-red-500/30 dark:text-red-300 dark:border-red-400/35",
};

export function Badge({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { variant?: BadgeVariant }) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
        variantStyles[variant],
        className,
      )}
      {...props}
    />
  );
}
