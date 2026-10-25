import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils/cn";

/**
 * The line of controls above a list: a search field that takes the free width, then filter chips
 * and actions. It wraps on a narrow window instead of overflowing.
 */
export function PageToolbar({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("page-toolbar", className)}>{children}</div>;
}

/** A borderless search field with a leading glyph; everything an input takes passes through. */
export function ToolbarSearch({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <label className={cn("toolbar-search", className)}>
    <Search aria-hidden="true" />
    <input type="text" enterKeyHint="search" {...props} />
  </label>;
}

/** The quiet column names over a list with columns. The names are visual only: each row already says what it is. */
export function ListHead({ children, lead }: { children: ReactNode; lead?: ReactNode }) {
  // Column names repeat what each row says, so they are hidden from assistive
  // technology; a control in the first column (`lead`) stays reachable.
  return <div className="data-list-head">{lead}<div className="contents" aria-hidden="true">{children}</div></div>;
}
