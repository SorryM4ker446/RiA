"use client";

import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils/cn";

type RefreshButtonProps = {
  label: string;
  onClick: () => void;
  /** True while the request is in flight; spins the glyph and locks the button. */
  refreshing?: boolean;
  disabled?: boolean;
  size?: "default" | "sm";
  variant?: "default" | "outline" | "secondary" | "ghost";
  className?: string;
};

/**
 * The refresh affordance every list page shares.
 *
 * Two things made the old plain buttons flicker. The label was the only
 * feedback, so the control sat inert through the request and the surrounding
 * list swapped its contents underneath it; and the pages cleared their rows
 * before fetching, which flashed the empty state. A spinning glyph states that
 * work is happening without changing the button's own size, so nothing around
 * it reflows while the request is in flight.
 */
export function RefreshButton({
  label,
  onClick,
  refreshing = false,
  disabled,
  size = "default",
  variant = "outline",
  className,
}: RefreshButtonProps) {
  return (
    <Button
      aria-busy={refreshing || undefined}
      className={cn("gap-1.5", className)}
      disabled={disabled || refreshing}
      onClick={onClick}
      size={size}
      type="button"
      variant={variant}
    >
      <RefreshCw
        aria-hidden="true"
        className={cn(
          "h-3.5 w-3.5 shrink-0 transition-transform duration-[--dur-slow] ease-[--ease-out]",
          refreshing && "animate-spin",
        )}
      />
      {label}
    </Button>
  );
}
