import type { SVGProps } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * Something small is under way: a faint ring with one bright arc turning
 * steadily. For a button, a row or a line of text; RunningOrbit stays the mark
 * for a conversation or task at work. Sized by its class like any icon, and
 * still under reduced motion.
 */
export function Spinner({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      aria-hidden="true"
      data-slot="spinner"
      className={cn("ui-spinner", className)}
      {...props}
    >
      <circle cx="12" cy="12" r="9" opacity="0.2" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}
