import type { ComponentProps } from "react";
import { cn } from "@/lib/utils/cn";

/* An empty list reads as one quiet line where the rows would be — the reason,
   and at most one way forward — rather than an illustration block that
   outweighs the content it stands in for. The way forward sits at the right
   edge, under the page's own actions, like the actions of a row. */
export function Empty({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="empty" className={cn("flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 py-4 text-left text-sm", className)} {...props} />;
}

export function EmptyHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex min-w-0 max-w-xl flex-col gap-0.5", className)} {...props} />;
}

/* Kept for callers that pass an icon; the compact layout does not draw it. */
export function EmptyMedia({ className, ...props }: ComponentProps<"div">) {
  return <div aria-hidden="true" className={cn("hidden", className)} {...props} />;
}

export function EmptyTitle({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-sm font-medium tracking-label", className)} {...props} />;
}

export function EmptyDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-[13px] leading-6 text-muted-foreground", className)} {...props} />;
}

export function EmptyContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex max-w-xl flex-wrap items-center gap-2", className)} {...props} />;
}
