"use client";

import { useRef, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { t, tf } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";
import { modelRefKey } from "@/lib/models/preferences-schema";
import type { ChatState } from "./use-chat-state";

const STORAGE_KEY = "chat:tool-less-acknowledged";

/** Answered once for each model until the app closes: a choice to revisit, not a question for every visit. */
function readAcknowledged(): string[] {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter(item => typeof item === "string") : [];
  } catch { return []; }
}

type Props = Pick<ChatState, "modelMode" | "selectedModelInfo" | "isLoadingPreferences" | "isModelMenuOpen" | "setIsModelMenuOpen" | "activeChat">;

/**
 * A model that cannot call tools takes away everything built on them, and nothing on the
 * page would say so. Before chatting with one, the person is told and chooses: carry on,
 * or pick another model. A template with no tools loses nothing to the model, so it is
 * not asked about, and a model the template fixes cannot be changed here.
 */
export function ToolLessModelNotice({ modelMode, selectedModelInfo, isLoadingPreferences, isModelMenuOpen, setIsModelMenuOpen, activeChat }: Props) {
  useLocale();
  const [acknowledged, setAcknowledged] = useState<string[] | null>(null);
  const [changing, setChanging] = useState(false);
  const accepting = useRef(false);
  const key = selectedModelInfo ? modelRefKey(selectedModelInfo) : "";
  const templateTools = activeChat?.assistantConfig?.tools;
  const fixedByTemplate = !!activeChat?.assistantConfig?.model;
  const applies = modelMode === "chat" && !isLoadingPreferences && selectedModelInfo?.supportsTools === false && templateTools?.length !== 0;
  const answered = applies && (acknowledged ?? readAcknowledged()).includes(key);

  function accept() {
    accepting.current = true;
    const next = [...new Set([...readAcknowledged(), key])];
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* the answer still holds on this page */ }
    setAcknowledged(next);
  }

  return <AlertDialog
    open={applies && !answered && !isModelMenuOpen && !changing}
    onOpenChange={next => {
      if (!next && !accepting.current && !fixedByTemplate) setChanging(true);
      accepting.current = false;
    }}
  >
    {/* The menu opens once the dialog has let go of focus, or it would be dismissed as a click outside. */}
    <AlertDialogContent onCloseAutoFocus={event => {
      if (!changing) return;
      event.preventDefault();
      setChanging(false);
      setIsModelMenuOpen(true);
    }}>
      <AlertDialogHeader>
        <AlertDialogTitle>{t("chat.toolLess.title")}</AlertDialogTitle>
        <AlertDialogDescription>
          {tf("chat.toolLess.description", { model: selectedModelInfo?.name ?? "" })}
          {fixedByTemplate ? ` ${t("chat.toolLess.fixedByTemplate")}` : ""}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        {fixedByTemplate ? null : <AlertDialogCancel>{t("chat.toolLess.change")}</AlertDialogCancel>}
        <AlertDialogAction onClick={accept}>{t("chat.toolLess.continue")}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
