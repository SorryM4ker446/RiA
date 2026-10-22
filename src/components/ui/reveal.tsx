"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * Space for a message that comes and goes — a notice, an error — which opens
 * and closes smoothly instead of pushing the page down and back up. While
 * closing it keeps showing the last message so it can fold away.
 */
export function Reveal({ children, className }: { children?: ReactNode; className?: string }) {
  const open = Boolean(children);
  const [last, setLast] = useState<ReactNode>(children);
  if (children && children !== last) setLast(children);
  return <div className={cn("reveal", className)} data-state={open ? "open" : "closed"} aria-hidden={!open || undefined}>
    <div className="min-h-0 overflow-hidden">{open ? children : last}</div>
  </div>;
}
