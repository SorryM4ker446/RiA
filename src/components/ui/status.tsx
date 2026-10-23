import * as React from "react";
import { cn } from "@/lib/utils/cn";

type StatusTone = "neutral" | "success" | "warning" | "danger";

const toneStyles: Record<StatusTone, string> = {
  neutral: "bg-muted-foreground/45",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
};

/* A row's state as a coloured dot and a quiet label: the colour carries the
   meaning, so the label never competes with the row's name. */
export function Status({
  className,
  tone = "neutral",
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: StatusTone }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground", className)} {...props}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full transition-colors duration-[--dur-base] ease-[--ease-out]", toneStyles[tone])} />
      {children}
    </span>
  );
}
