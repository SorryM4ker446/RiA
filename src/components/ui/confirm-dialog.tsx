"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocale } from "@/lib/locale/client";
import { t } from "@/lib/locale";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

export type ConfirmOptions = {
  title: string;
  description: ReactNode;
  /** The confirming button; "Continue" when omitted. */
  action?: string;
  /** Deletions and other irreversible steps show the confirming button in the destructive colour. */
  destructive?: boolean;
};

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

/**
 * One confirmation dialog for the whole app, asked for with `useConfirm()` in
 * place of the browser's `window.confirm`. Only one question is open at a time:
 * asking again answers the earlier one with "no".
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  useLocale();
  const [open, setOpen] = useState(false);
  // Kept after closing so the dialog does not go blank while it animates out.
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const pending = useRef<((answer: boolean) => void) | null>(null);

  const settle = useCallback((answer: boolean) => {
    pending.current?.(answer);
    pending.current = null;
    setOpen(false);
  }, []);

  const confirm = useCallback<Confirm>(next => new Promise<boolean>(resolve => {
    pending.current?.(false);
    pending.current = resolve;
    setOptions(next);
    setOpen(true);
  }), []);

  useEffect(() => () => { pending.current?.(false); pending.current = null; }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={open} onOpenChange={next => { if (!next) settle(false); }}>
        {options ? (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{options.title}</AlertDialogTitle>
              <AlertDialogDescription>{options.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("ui.confirm.cancel")}</AlertDialogCancel>
              <AlertDialogAction variant={options.destructive ? "destructive" : "default"} onClick={() => settle(true)}>
                {options.action ?? t("ui.confirm.continue")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used inside ConfirmProvider");
  return confirm;
}
