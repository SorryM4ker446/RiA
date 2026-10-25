"use client";
import { useLocale } from "@/lib/locale/client";
import { t, tf, type MessageKey } from "@/lib/locale";
import { CircleAlert, Cpu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/ui/reveal";
import { useOpenSettings } from "@/features/settings/settings-context";
import { cn } from "@/lib/utils/cn";

/** A send stopped in the composer before anything was requested. */
export type InputNotice = { key: MessageKey; values?: Record<string, string> };

/**
 * What stands between the user and sending, said once, above the composer.
 * The model comes first: add one when this mode has none, or choose one after a
 * send was tried without. Otherwise, why the last send stayed in the composer.
 * Both are guidance rather than errors, because nothing was requested, and they
 * fold away once the cause is dealt with.
 *
 * While the model menu is open the text fades but keeps its place, so the menu
 * does not sit on top of it and closing the menu does not move the composer.
 */
export function ComposerNotice({ modelHint, notice, dimmed, onChooseModel, onDismiss }: {
  modelHint: "add" | "choose" | null;
  notice: InputNotice | null;
  dimmed: boolean;
  onChooseModel: () => void;
  onDismiss: () => void;
}) {
  useLocale();
  const openSettings = useOpenSettings();
  const content = modelHint ? <>
    <span className="flex min-w-0 items-center gap-2 text-muted-foreground"><Cpu aria-hidden="true" className="size-4 shrink-0" />{t(modelHint === "add" ? "chat.modelHint.add" : "chat.modelHint.choose")}</span>
    <Button size="sm" variant="ghost" className="shrink-0" onClick={() => modelHint === "add" ? openSettings("models") : onChooseModel()}>
      {t(modelHint === "add" ? "chat.modelHint.addAction" : "chat.modelHint.chooseAction")}
    </Button>
  </> : notice ? <>
    <span className="flex min-w-0 items-center gap-2 text-muted-foreground"><CircleAlert aria-hidden="true" className="size-4 shrink-0" />{notice.values ? tf(notice.key, notice.values) : t(notice.key)}</span>
    <Button size="icon" variant="ghost" className="size-7 shrink-0" aria-label={t("chatPage.dismissError")} onClick={onDismiss}><X aria-hidden="true" className="size-4" /></Button>
  </> : null;
  return <Reveal className="chat-dock-notice">
    {content ? <div role="status" className={cn("mx-auto flex w-full max-w-[42rem] items-center justify-between gap-3 rounded-xl border border-border/70 px-3 py-2 text-sm transition-opacity duration-[--dur-fast]", dimmed && "opacity-0")}>
      {content}
    </div> : null}
  </Reveal>;
}
