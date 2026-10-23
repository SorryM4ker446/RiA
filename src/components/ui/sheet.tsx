"use client";
import { useLocale } from "@/lib/locale/client";

import { t } from "@/lib/locale";

import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { Button } from "@/components/ui/button";

export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetClose = SheetPrimitive.Close;
export const SheetTitle = SheetPrimitive.Title;
export const SheetDescription = SheetPrimitive.Description;

export function SheetContent({
  className,
  children,
  side = "left",
  closeLabel = t("window.close"),
  showClose = true,
  ...props
}: React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content> & {
  side?: "left" | "right";
  closeLabel?: string;
  /** Off when the content brings its own close control in its header. */
  showClose?: boolean;
}) {
  useLocale();
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="sheet-overlay" />
      <SheetPrimitive.Content
        data-side={side}
        className={cn("sheet-content", className)}
        {...props}
      >
        {children}
        {showClose ? <SheetClose asChild>
          <Button className="absolute right-3 top-3" variant="ghost" size="icon-sm" aria-label={closeLabel}>
            <X aria-hidden="true" />
          </Button>
        </SheetClose> : null}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}
