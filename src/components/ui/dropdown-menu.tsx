"use client";

import * as React from "react";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { keepMovedFocus } from "./focus-return";

/** Counts the menu's openings; each one renders a fresh menu (see DropdownMenu). */
const Opening = React.createContext(0);

/**
 * A closing menu shrinks away for a moment. Pressing its trigger again in that moment must open a menu,
 * so each opening renders a new one, cutting the old one's exit short. Reviving the closing menu instead
 * would let it take that same press as a click outside itself and close again at once.
 */
export function DropdownMenu({ open, defaultOpen, onOpenChange, children, ...props }: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Root>) {
  const [opening, setOpening] = React.useState(0);
  const [wasOpen, setWasOpen] = React.useState(open);
  // A menu its owner opens by changing `open` counts as well.
  if (open !== wasOpen) { setWasOpen(open); if (open) setOpening(count => count + 1); }
  return (
    <DropdownPrimitive.Root open={open} defaultOpen={defaultOpen} {...props}
      onOpenChange={next => { if (next && open === undefined) setOpening(count => count + 1); onOpenChange?.(next); }}>
      <Opening.Provider value={opening}>{children}</Opening.Provider>
    </DropdownPrimitive.Root>
  );
}
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;
export const DropdownMenuGroup = DropdownPrimitive.Group;
export const DropdownMenuRadioGroup = DropdownPrimitive.RadioGroup;

export function DropdownMenuContent({ className, sideOffset = 6, onCloseAutoFocus, ...props }: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>) {
  const opening = React.useContext(Opening);
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content key={opening} sideOffset={sideOffset} className={cn("ui-dropdown-content", className)}
        onCloseAutoFocus={keepMovedFocus(onCloseAutoFocus)} {...props} />
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

/** On or off from a menu; the item stays a menu item to assistive technology, whatever it is drawn as. */
export function DropdownMenuCheckboxItem({ className, ...props }: React.ComponentProps<typeof DropdownPrimitive.CheckboxItem>) {
  return <DropdownPrimitive.CheckboxItem className={cn("ui-dropdown-item", className)} {...props} />;
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Label>) {
  return <DropdownPrimitive.Label className={cn("px-2.5 pb-1 pt-1.5 text-xs text-muted-foreground", className)} {...props} />;
}

export function DropdownMenuSeparator(props: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Separator>) {
  return <DropdownPrimitive.Separator className="my-1 h-px bg-border" {...props} />;
}
