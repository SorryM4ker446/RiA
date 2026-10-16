import type { ComponentProps } from "react";
import { cn } from "@/lib/utils/cn";

export function Empty({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="empty" className={cn("flex min-w-0 flex-col items-center justify-center gap-5 rounded-xl px-5 py-12 text-center", className)} {...props} />;
}

export function EmptyHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex max-w-sm flex-col items-center gap-3", className)} {...props} />;
}

export function EmptyMedia({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex size-11 items-center justify-center rounded-xl bg-secondary text-muted-foreground [&_svg]:size-5", className)} {...props} />;
}

export function EmptyTitle({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("font-medium tracking-label", className)} {...props} />;
}

export function EmptyDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-sm leading-6 text-muted-foreground", className)} {...props} />;
}

export function EmptyContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex max-w-xl flex-wrap items-center justify-center gap-2", className)} {...props} />;
}
