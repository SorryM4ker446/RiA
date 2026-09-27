import * as React from "react";
import { cn } from "@/lib/utils/cn";

type AlertVariant = "default" | "destructive";

const variantStyles: Record<AlertVariant, string> = {
  default: "bg-card text-card-foreground shadow-hairline",
  destructive: "bg-destructive/5 text-destructive shadow-hairline",
};

export function Alert({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { variant?: AlertVariant }) {
  return (
    <div
      className={cn("relative w-full rounded-lg p-3 text-sm", variantStyles[variant], className)}
      role="alert"
      {...props}
    />
  );
}

export function AlertTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h5 className={cn("mb-1 font-semibold leading-5", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("text-[13px] leading-5 opacity-90", className)} {...props} />;
}
