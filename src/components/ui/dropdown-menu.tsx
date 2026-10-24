"use client";

import * as React from "react";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;
export const DropdownMenuGroup = DropdownPrimitive.Group;
export const DropdownMenuRadioGroup = DropdownPrimitive.RadioGroup;

export function DropdownMenuContent({ className, sideOffset = 6, ...props }: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content sideOffset={sideOffset} className={cn("ui-dropdown-content", className)} {...props} />
    </DropdownPrimitive.Portal>
  );
}

export function DropdownMenuItem({ className, variant = "default", ...props }: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Item> & { variant?: "default" | "destructive" }) {
  return <DropdownPrimitive.Item data-variant={variant} className={cn("ui-dropdown-item", className)} {...props} />;
}

/** A choice of one; the check sits at the end so labels stay aligned with ordinary items. */
export function DropdownMenuRadioItem({ className, children, ...props }: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.RadioItem>) {
  return <DropdownPrimitive.RadioItem className={cn("ui-dropdown-item", className)} {...props}>
    {children}
    <DropdownPrimitive.ItemIndicator className="ml-auto flex"><Check aria-hidden="true" /></DropdownPrimitive.ItemIndicator>
  </DropdownPrimitive.RadioItem>;
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Label>) {
  return <DropdownPrimitive.Label className={cn("px-2.5 pb-1 pt-1.5 text-xs text-muted-foreground", className)} {...props} />;
}

export function DropdownMenuSeparator(props: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Separator>) {
  return <DropdownPrimitive.Separator className="my-1 h-px bg-border" {...props} />;
}
