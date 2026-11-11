"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";

/*
 * A centred dialog for a form that is filled in and saved or cancelled: it
 * shows over the page it was opened from, and nothing changes until it is saved.
 */

export const Dialog = DialogPrimitive.Root;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ className, children, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>) {
  useLocale();
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dialog-overlay" />
      <DialogPrimitive.Content className={cn("dialog-content", className)} {...props}>
        {children}
        <DialogPrimitive.Close asChild>
          <Button className="absolute right-3 top-3" variant="ghost" size="icon-sm" aria-label={t("window.close")}>
            <X aria-hidden="true" />
          </Button>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
