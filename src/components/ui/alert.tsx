import * as React from "react";
import { cn } from "@/lib/utils/cn";

type AlertVariant = "default" | "destructive";

const variantStyles: Record<AlertVariant, string> = {
  default: "border-border bg-card text-card-foreground",
  destructive: "border-red-300 bg-red-50 text-red-800 dark:border-red-500/40 dark:bg-red-950/35 dark:text-red-200",
};

export function Alert({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { variant?: AlertVariant }) {
  return (
    <div
      className={cn("relative w-full rounded-md border p-3 text-sm", variantStyles[variant], className)}
      role="alert"
      {...props}
    />
  );
}

export function AlertTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h5 className={cn("mb-1 font-medium leading-none", className)} {...props} />;
}

export function AlertDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("text-xs leading-relaxed", className)} {...props} />;
}
