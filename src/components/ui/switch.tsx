"use client";

import * as React from "react";
import { cn } from "@/lib/utils/cn";

type SwitchProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "role" | "type"> & {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

/**
 * On or off, taking effect at once. A setting that waits for a Save button, or
 * a choice among rows, stays a checkbox. Named by a wrapping or associated
 * <label> like any button, so clicking the words flips it too.
 */
export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, onClick, className, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      data-state={checked ? "checked" : "unchecked"}
      className={cn("ui-switch", className)}
      onClick={event => {
        onClick?.(event);
        if (!event.defaultPrevented) onCheckedChange?.(!checked);
      }}
      {...props}
    >
      <span className="ui-switch-thumb" aria-hidden="true" />
    </button>
  ),
);
Switch.displayName = "Switch";
