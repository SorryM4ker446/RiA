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
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ className, children, closeLabel, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  /** What the close button is called, when "Close" alone would not say what closes. */
  closeLabel?: string;
}) {
  useLocale();
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dialog-overlay" />
      <DialogPrimitive.Content className={cn("dialog-content", className)} {...props}>
        {children}
        <DialogPrimitive.Close asChild>
          <Button className="absolute right-3 top-3" variant="ghost" size="icon-sm" aria-label={closeLabel ?? t("window.close")}>
            <X aria-hidden="true" />
          </Button>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/*
 * The parts every such dialog is made of, so they all read alike: a title with
 * one quiet line under it, a body that scrolls when the form is taller than
 * the window, and the actions at the bottom right, cancel before the main one.
 */
export function DialogHeader({ title, description }: { title: React.ReactNode; description?: React.ReactNode }) {
  return (
    <header className="dialog-header">
      <DialogPrimitive.Title className="dialog-title">{title}</DialogPrimitive.Title>
      {description ? <DialogPrimitive.Description className="dialog-description">{description}</DialogPrimitive.Description> : null}
    </header>
  );
}

export function DialogBody({ className, ...props }: React.ComponentPropsWithoutRef<"div">) {
  return <div className={cn("dialog-body", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.ComponentPropsWithoutRef<"footer">) {
  return <footer className={cn("dialog-footer", className)} {...props} />;
}
