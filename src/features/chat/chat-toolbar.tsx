"use client";
import { useLocale } from "@/lib/locale/client";
import { t, tf, localizeMessage } from "@/lib/locale";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ArrowUpRight, Brain, ChevronDown, Info, LayoutTemplate } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/ui/reveal";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTopbarSlot } from "@/components/layout/topbar-slot";
import type { ChatState } from "@/features/chat/use-chat-state";
import { TemplateDetails } from "@/features/assistants/template-details";
import { useAwaitingFirstLoad } from "@/lib/use-awaiting-first-load";

type Props = Pick<
  ChatState,
  | "activeChat"
  | "isPending"
  | "isWorking"
  | "isLoadingChats"
  | "modelMode"
  | "toggleEphemeral"
  | "assistants" | "assistantsError" | "loadAssistants" | "applyAssistant" | "canApplyAssistant"
>;

/** The memory glyph crossed out the way lucide draws its "-off" icons: cut where the slash passes, then the slash. */
function BrainOff({ className }: { className?: string }) {
  const cut = useId();
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <defs><mask id={cut}><rect width="24" height="24" fill="white" /><path d="M2 2 22 22" stroke="black" strokeWidth={5} /></mask></defs>
      <g mask={`url(#${cut})`}>
        <path d="M12 18V5" /><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" /><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
        <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" /><path d="M18 18a4 4 0 0 0 2-7.464" /><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
        <path d="M6 18a4 4 0 0 1-2-7.464" /><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
      </g>
      <path d="M2 2 22 22" />
    </svg>
  );
}

/**
 * The conversation's heading, in the window's top row: its title opens a menu with the assistant
 * template, the template's details, the conversation's long-term memory and the way to manage
 * templates. Beside the title only what differs from the default is said: the template's name when
 * one is in use, and a "no memory" tag when memory is off.
 */
export function ChatHeader({
  activeChat,
  isPending,
  isWorking,
  isLoadingChats,
  modelMode,
  toggleEphemeral,
  assistants, assistantsError, loadAssistants, applyAssistant, canApplyAssistant,
}: Props) {
  useLocale();
  const toast = useToast();
  const slot = useTopbarSlot();
  const [menuOpen, setMenuOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Opened from the "no memory" tag, the menu puts the keyboard on the memory switch.
  const focusMemory = useRef(false);
  const memoryItem = useRef<HTMLDivElement>(null);
  const titleButton = useRef<HTMLButtonElement>(null);
  // The result, then what it means for this conversation.
  const setMemory = (ephemeral: boolean) => {
    void toggleEphemeral(ephemeral).then(saved => {
      if (saved) toast({ title: t(ephemeral ? "chat.memory.offTitle" : "chat.memory.onTitle"), description: t(ephemeral ? "chat.memory.turnedOff" : "chat.memory.turnedOn") });
    });
  };
  useEffect(() => { const controller = new AbortController(); void loadAssistants(controller.signal); return () => controller.abort(); }, [loadAssistants]);
  // The menu focuses its first item as it opens; asked for from the tag, the memory switch takes over a frame later.
  useEffect(() => {
    if (!menuOpen || !focusMemory.current) return;
    focusMemory.current = false;
    const frame = requestAnimationFrame(() => memoryItem.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [menuOpen]);
  // Until the list first answers, no title is known: naming it a new conversation
  // then is a claim the restored conversation's title replaces a moment later.
  const awaitingConversation = useAwaitingFirstLoad(isLoadingChats, "conversations");
  // A task's conversation is the task's own general-assistant conversation; no template applies to it.
  const ownedByTask = Boolean(activeChat?.task);
  const snapshot = ownedByTask ? null : activeChat?.assistantConfig;
  const currentTemplate = assistants.find(item => item.id === snapshot?.templateId);
  const hasTemplateUpdate = snapshot && currentTemplate && currentTemplate.revision !== snapshot.templateRevision;
  const templateName = snapshot ? (snapshot.templateId.startsWith("builtin_") ? localizeMessage(snapshot.name) : snapshot.name) : null;
  const memoryOff = activeChat?.ephemeral === true;
  const title = activeChat?.title ?? (awaitingConversation ? null : t("chat.toolbar.newChat"));
  const choosing = isPending || !canApplyAssistant;

  const header = (
    // These controls depend on the conversation: its template and its memory switch. Until the list
    // says which conversation is open they hold back, then appear once in place.
    <div className="chat-header desktop-titlebar-interactive" data-waiting={awaitingConversation || undefined}>
      <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          {/* Named for what it opens: a conversation may be called anything, including the name of another button. */}
          <button ref={titleButton} type="button" className="chat-title" aria-label={tf("chat.header.menuLabel", { title: title ?? "" })}><span className="chat-title-text truncate">{title}</span><ChevronDown aria-hidden="true" /></button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="chat-header-menu">
          {title ? <DropdownMenuLabel className="break-words text-popover-foreground">{title}</DropdownMenuLabel> : null}
          <DropdownMenuLabel>{t("ui.assistants.assistantTemplates")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={snapshot?.templateId ?? ""} onValueChange={value => void applyAssistant(value || null)}>
            <DropdownMenuRadioItem value="" disabled={choosing}>{t("ui.chat.chat-toolbar.generalAssistant")}</DropdownMenuRadioItem>
            {snapshot && !currentTemplate ? <DropdownMenuRadioItem value={snapshot.templateId} disabled={choosing}>{templateName}</DropdownMenuRadioItem> : null}
            {assistants.map(item => <DropdownMenuRadioItem key={item.id} value={item.id} disabled={choosing}>{item.builtin ? localizeMessage(item.config.name) : item.config.name}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
          {ownedByTask ? <p className="chat-header-menu-note">{t("chat.toolbar.taskGeneralAssistant")}</p> : null}
          {snapshot ? <DropdownMenuItem onSelect={() => setDetailsOpen(true)}><Info aria-hidden="true" />{t("ui.assistants.template-details.templateDetails")}</DropdownMenuItem> : null}
          {activeChat ? <>
            <DropdownMenuSeparator />
            {/* Toggling keeps the menu open, so the switch is seen to move. */}
            <DropdownMenuCheckboxItem ref={memoryItem} className="chat-memory-item" checked={!memoryOff} disabled={isPending}
              onSelect={event => event.preventDefault()} onCheckedChange={on => setMemory(on !== true)}>
              <Brain aria-hidden="true" />
              <span className="chat-memory-item-text">{t("chat.memory.label")}<small>{t("chat.memory.scope")}</small></span>
              <span className="ui-switch" data-state={memoryOff ? "unchecked" : "checked"} aria-hidden="true"><span className="ui-switch-thumb" /></span>
            </DropdownMenuCheckboxItem>
          </> : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild><Link href="/assistants"><LayoutTemplate aria-hidden="true" />{t("ui.chat.chat-toolbar.manageTemplates")}<ArrowUpRight aria-hidden="true" className="chat-header-menu-trailing" /></Link></DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {templateName ? <span className="chat-header-meta">{templateName}</span> : null}
      {memoryOff ? (
        <button type="button" className="chat-memory-off" aria-label={t("chat.memory.offTagLabel")} onClick={() => { focusMemory.current = true; setMenuOpen(true); }}>
          <BrainOff />{t("chat.memory.offTag")}
        </button>
      ) : null}
      {isWorking ? <>
        <Badge className="shrink-0" variant="outline">{t("chat.toolbar.statusGenerating")}</Badge>
        <span role="status" className="sr-only">{modelMode === "image" ? t("chat.toolbar.pendingImage") : modelMode === "video" ? t("chat.toolbar.pendingVideo") : t("chat.toolbar.pendingChat")}</span>
      </> : null}
    </div>
  );

  return <>
    {slot ? createPortal(header, slot) : null}
    {/* The page's heading, for the document outline and screen readers; the title in the top row is a menu button. */}
    {title ? <h1 className="sr-only">{title}</h1> : null}
    {snapshot ? <TemplateDetails key={activeChat?.id} snapshot={snapshot} open={detailsOpen} onOpenChange={setDetailsOpen} returnFocus={() => titleButton.current?.focus()} /> : null}
    <Reveal className="chat-header-notices">{hasTemplateUpdate || assistantsError ? <div className="flex flex-wrap items-center gap-2 px-6 pb-1 pt-2 text-xs">
      {hasTemplateUpdate ? <Button variant="ghost" size="sm" disabled={choosing} onClick={() => void applyAssistant(snapshot.templateId)}>{t("ui.chat.chat-toolbar.updateToLatestTemplate")}</Button> : null}
      {assistantsError ? <span role="alert">{localizeMessage(assistantsError)} <Button variant="ghost" size="sm" onClick={() => void loadAssistants()}>{t("ui.chat.chat-toolbar.retry")}</Button></span> : null}
    </div> : null}</Reveal>
  </>;
}
