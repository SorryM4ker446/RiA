"use client";

import * as React from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { cn } from "@/lib/utils/cn";

type Option<T extends string> = { value: T; label: React.ReactNode; disabled?: boolean };

type SegmentedControlProps<T extends string> = {
  value: T | null;
  options: readonly Option<T>[];
  onValueChange: (value: T) => void;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** While a choice is being saved: the control stays as it is and ignores further choices. */
  busy?: boolean;
  size?: "default" | "sm";
  className?: string;
};

/**
 * One choice of a few, all in view. Options share one width, so the selected
 * fill can slide between them by its index alone, with nothing to measure.
 * A radio group to assistive technology; the chosen option is never disabled,
 * so it never reads as unavailable. Choosing the chosen option again keeps it.
 */
export function SegmentedControl<T extends string>({ value, options, onValueChange, busy = false, size = "default", className, ...labels }: SegmentedControlProps<T>) {
  const index = options.findIndex(option => option.value === value);
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value ?? ""}
      onValueChange={next => { if (next && !busy) onValueChange(next as T); }}
      aria-busy={busy || undefined}
      data-size={size}
      className={cn("ui-segmented", className)}
      style={{ "--segment-count": options.length, "--segment-index": Math.max(index, 0) } as React.CSSProperties}
      {...labels}
    >
      <span className="ui-segmented-thumb" aria-hidden="true" data-hidden={index < 0 || undefined} />
      {options.map(option => (
        <ToggleGroupPrimitive.Item key={option.value} value={option.value} disabled={option.disabled} className="ui-segmented-item">
          {option.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  );
}
