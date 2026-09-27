import * as React from "react";
import { cn } from "@/lib/utils/cn";

type BadgeVariant = "default" | "secondary" | "outline" | "success" | "warning" | "danger";

/* Pills are for status only. Every variant is a tinted surface with a darker
   text of the same hue, so a badge never competes with the content beside it. */
const variantStyles: Record<BadgeVariant, string> = {
  default: "bg-accent text-accent-foreground",
  secondary: "bg-muted text-muted-foreground",
  outline: "bg-transparent text-muted-foreground shadow-hairline",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  danger: "bg-destructive/10 text-destructive",
};

export function Badge({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { variant?: BadgeVariant }) {
  return (
    <div
      className={cn(
        "inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium leading-4",
        variantStyles[variant],
        className,
      )}
      {...props}
    />
  );
}
