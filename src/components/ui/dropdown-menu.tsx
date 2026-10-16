"use client";

import * as React from "react";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils/cn";

export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;
export const DropdownMenuGroup = DropdownPrimitive.Group;

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

export function DropdownMenuSeparator(props: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Separator>) {
  return <DropdownPrimitive.Separator className="my-1 h-px bg-border" {...props} />;
}
