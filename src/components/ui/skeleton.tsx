import { cn } from "@/lib/utils/cn";

/* A travelling highlight reads as loading more convincingly than a flat pulse,
   and it is the one animation allowed to loop. */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "animate-shimmer rounded-md bg-muted bg-[length:200%_100%] bg-gradient-to-r from-muted via-elevated to-muted",
        className,
      )}
      {...props}
    />
  );
}
