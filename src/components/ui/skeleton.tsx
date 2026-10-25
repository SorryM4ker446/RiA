"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils/cn";

/** How long a load may take before its placeholder shows (--delay-placeholder). */
const PLACEHOLDER_DELAY_MS = 200;

/*
 * A travelling highlight reads as loading more convincingly than a flat pulse,
 * and it is the one animation allowed to loop. A load that finishes quickly
 * never shows it: the placeholder keeps its space but stays invisible for the
 * first moments, so a fast page goes straight from nothing to its content
 * instead of flashing grey blocks. The delay is a timer rather than only an
 * animation delay, so it holds with reduced motion too.
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setLate(true), PLACEHOLDER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div
      aria-hidden="true"
      data-late={late || undefined}
      className={cn(
        "skeleton rounded-md bg-muted bg-[length:200%_100%] bg-gradient-to-r from-muted via-elevated to-muted",
        className,
      )}
      {...props}
    />
  );
}
