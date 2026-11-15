"use client";

import { useState } from "react";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { t } from "@/lib/locale";

/*
 * Leaving a form dialog without saving. A click beside it, Escape, its close button and Cancel all
 * mean the same thing, so they all take one path: a form that is as it was opened closes at once,
 * and one that was changed asks first, so nothing written is lost by a stray click.
 */

/** Whether a form's values differ from what they were when it opened. For a form mounted each time it opens. */
export function useFormChanged(values: unknown): boolean {
  const now = JSON.stringify(values);
  const [opened] = useState(now);
  return now !== opened;
}

/** Asks before discarding a changed form. Resolves to whether the form may close. */
export function useConfirmDiscard(): (changed: boolean) => Promise<boolean> {
  const confirm = useConfirm();
  return changed => changed
    ? confirm({ title: t("ui.settingsOverlay.discardTitle"), description: t("ui.settingsOverlay.discardDescription"), action: t("ui.settingsOverlay.discard"), destructive: true })
    : Promise.resolve(true);
}
