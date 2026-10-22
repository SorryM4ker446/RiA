"use client";
import { useLocale } from "@/lib/locale/client";
import { formatDateTime, t, tf } from "@/lib/locale";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { useAwaitingFirstLoad } from "@/lib/use-awaiting-first-load";
import { ArrowUpRight, Bot, Check, ChevronDown, ChevronUp, History, Loader2, MessageSquareText, MoreHorizontal, PencilLine, Pin, SquarePen, Trash2, X } from "lucide-react";
import { COLLAPSED_CHAT_LIMIT } from "@/features/chat/types";
import type { ChatSummary } from "@/features/chat/page-utils";
import type { ChatState } from "@/features/chat/use-chat-state";
import { removalKey } from "@/lib/ui/removal";
type Props = Pick<ChatState,
  | "isLoadingChats" | "isCreatingChat" | "createNewChat" | "chats" | "visibleChats"
  | "activeChatId" | "editingChatId" | "setEditingTitle" | "editingTitle" | "saveEditedTitle"
  | "cancelEditingChat" | "switchActiveChat" | "startEditingChat" | "requestDeleteConversation"
  | "hasHiddenChats" | "setIsChatListExpanded" | "isChatListExpanded" | "nextChatsCursor"
  | "isLoadingMoreChats" | "loadMoreChats"
>;

type SectionKey = "pinned" | "today" | "yesterday" | "week" | "older";
const sectionKeys: SectionKey[] = ["pinned", "today", "yesterday", "week", "older"];

// Calendar days keep the groups stable across daylight-saving transitions.
function calendarDay(date: Date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

function conversationSections(chats: ChatSummary[], now: Date) {
  const today = calendarDay(now);
  const sections: Record<SectionKey, ChatSummary[]> = { pinned: [], today: [], yesterday: [], week: [], older: [] };
  for (const chat of chats) {
    const age = today - calendarDay(new Date(chat.lastMessageAt));
    const key = chat.pinned ? "pinned" : age <= 0 ? "today" : age === 1 ? "yesterday" : age < 7 ? "week" : "older";
    sections[key].push(chat);
  }
  return sectionKeys.filter(key => sections[key].length > 0).map(key => ({ key, label: t(`chat.conversations.${key}`), chats: sections[key] }));
}

function compactTime(value: string, now: Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDateTime(date, calendarDay(date) === calendarDay(now)
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { ...(date.getFullYear() !== now.getFullYear() && { year: "numeric" }), month: "numeric", day: "numeric" });
}

export function ConversationList({
  isLoadingChats, isCreatingChat, createNewChat, chats, visibleChats, activeChatId,
  editingChatId, setEditingTitle, editingTitle, saveEditedTitle, cancelEditingChat,
  switchActiveChat, startEditingChat, requestDeleteConversation, hasHiddenChats,
  setIsChatListExpanded, isChatListExpanded, nextChatsCursor, isLoadingMoreChats,
  loadMoreChats,
}: Props) {
  useLocale();
  const awaitingFirstLoad = useAwaitingFirstLoad(isLoadingChats, "conversations");
  const [open, setOpen] = useState(false);
  const now = new Date();
  const sections = conversationSections(visibleChats, now);
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Popover open={open} onOpenChange={next => { setOpen(next); if (!next) cancelEditingChat(); }}>
        <PopoverTrigger asChild><Button variant="ghost" size="sm" aria-label={t("chat.conversations.title")}><History data-icon="inline-start" aria-hidden="true" />{t("chat.conversations.recent")}<ChevronDown data-icon="inline-end" aria-hidden="true" /></Button></PopoverTrigger>
        <PopoverContent align="start" sideOffset={10} collisionPadding={12} className="conversation-popover" aria-label={t("chat.conversations.recent")} onEscapeKeyDown={event => { if (editingChatId) { event.preventDefault(); cancelEditingChat(); } }}>
        <aside aria-label={t("chat.conversations.title")} className="flex min-h-0 flex-col">
        <header className="flex shrink-0 flex-col gap-4 px-4 pb-4 pt-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <History aria-hidden="true" className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold tracking-label">{t("chat.conversations.recent")}</h2>
              <Badge variant="secondary" title={tf("chat.conversations.loaded", { count: chats.length })}>{chats.length}</Badge>
            </div>
            <Button aria-label={t("ui.chat.conversation-list.closeRecentConversations")} onClick={() => setOpen(false)} variant="ghost" size="icon-sm">
              <X aria-hidden="true" />
            </Button>
          </div>
        </header>
        <div className="chat-list-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-3 pb-4">
          {awaitingFirstLoad ? (
            <div role="status" aria-label={t("ui.chat.conversation-list.loadConversation")} className="flex flex-col gap-3 pt-2">
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-[76px]" /><Skeleton className="h-[76px]" /><Skeleton className="h-[76px]" />
            </div>
          ) : chats.length === 0 ? (
            <Empty className="my-auto px-3">
              <EmptyHeader>
                <EmptyMedia><MessageSquareText aria-hidden="true" /></EmptyMedia>
                <EmptyTitle>{t("chat.conversations.emptyTitle")}</EmptyTitle>
                <EmptyDescription>{t("chat.conversations.emptyDescription")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : sections.map(section => (
            <section key={section.key} aria-label={section.label} className="conversation-section flex flex-col gap-1.5">
              <h3 className="conversation-section-label flex items-center gap-1.5 px-2 py-1.5">
                {section.key === "pinned" ? <Pin aria-hidden="true" className="size-3" /> : null}
                {section.label}
              </h3>
              {section.chats.map(chat => {
                const active = activeChatId === chat.id;
                const Icon = chat.assistantConfig ? Bot : MessageSquareText;
                return (
                  <div key={chat.id} {...removalKey(chat.id)} data-active={active} className="conversation-row group relative">
                    {editingChatId === chat.id ? (
                      <div className="conversation-editor flex flex-col gap-3 p-3">
                        <Input autoFocus aria-label={t("chat.conversations.rename")} value={editingTitle}
                          onChange={event => setEditingTitle(event.target.value)}
                          onKeyDown={event => {
                            if (event.key === "Enter") { event.preventDefault(); void saveEditedTitle(chat.id); }
                            if (event.key === "Escape") { event.stopPropagation(); cancelEditingChat(); }
                          }} />
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="ghost" onClick={cancelEditingChat}><X data-icon="inline-start" aria-hidden="true" />{t("chat.common.cancel")}</Button>
                          <Button size="sm" onClick={() => void saveEditedTitle(chat.id)}><Check data-icon="inline-start" aria-hidden="true" />{t("chat.common.save")}</Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <button type="button" aria-current={active ? "true" : undefined} title={chat.title}
                          className="conversation-open flex w-full items-start gap-2.5 rounded-xl py-3 pl-3 pr-9 text-left"
                          onClick={() => { setOpen(false); void switchActiveChat(chat.id); }}>
                          <span aria-hidden="true" className="conversation-icon"><Icon className="size-4" /></span>
                          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                            <span className="conversation-title line-clamp-2 break-words">{chat.title}</span>
                            <span className="conversation-metadata flex flex-wrap items-center gap-x-1.5 gap-y-1">
                              <span>{chat.messageCount ?? 0} {t("chat.conversations.messageCountUnit")}</span>
                              <span aria-hidden="true">·</span>
                              <time dateTime={chat.lastMessageAt} title={formatDateTime(chat.lastMessageAt)}>{compactTime(chat.lastMessageAt, now)}</time>
                            </span>
                          </span>
                        </button>
                        <DropdownMenu modal={false}>
                          <DropdownMenuTrigger asChild>
                            <Button className="conversation-actions absolute right-1 top-2" size="icon-sm" variant="ghost" aria-label={tf("chat.conversations.actions", { title: chat.title })} title={t("ui.chat.conversation-list.conversationActions")}>
                              <MoreHorizontal aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start" aria-label={tf("chat.conversations.actions", { title: chat.title })}>
                            <DropdownMenuGroup>
                              <DropdownMenuItem onSelect={() => startEditingChat(chat)}><PencilLine aria-hidden="true" />{t("chat.conversations.rename")}</DropdownMenuItem>
                            </DropdownMenuGroup>
                            <DropdownMenuSeparator />
                            <DropdownMenuGroup>
                              <DropdownMenuItem variant="destructive" onSelect={() => { setOpen(false); requestDeleteConversation(chat); }}><Trash2 aria-hidden="true" />{t("chat.common.delete")}</DropdownMenuItem>
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </>
                    )}
                  </div>
                );
              })}
            </section>
          ))}
          {hasHiddenChats ? (
            <Button variant="ghost" size="sm" className="w-full" onClick={() => setIsChatListExpanded(previous => !previous)}>
              {isChatListExpanded ? <ChevronUp data-icon="inline-start" aria-hidden="true" /> : <ChevronDown data-icon="inline-start" aria-hidden="true" />}
              {isChatListExpanded ? t("chat.conversations.collapse") : tf("chat.common.expandMore", { count: chats.length - COLLAPSED_CHAT_LIMIT })}
            </Button>
          ) : null}
          {nextChatsCursor && (isChatListExpanded || !hasHiddenChats) ? (
            <Button variant="ghost" size="sm" className="w-full" disabled={isLoadingMoreChats} onClick={() => void loadMoreChats()}>
              {isLoadingMoreChats ? <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" /> : <ChevronDown data-icon="inline-start" aria-hidden="true" />}
              {t("chat.conversations.loadMore")}
            </Button>
          ) : null}
        </div>
        <footer className="flex shrink-0 flex-col gap-1 border-t px-3 py-3">
          <Button asChild variant="ghost" size="sm" className="w-full justify-between"><Link href="/conversations">{t("chat.conversations.manageAll")}<ArrowUpRight data-icon="inline-end" aria-hidden="true" /></Link></Button>
          <p className="px-3 text-[11px] leading-5 text-muted-foreground">{tf("chat.conversations.loaded", { count: chats.length })}</p>
        </footer>
        </aside>
        </PopoverContent>
      </Popover>
      <Button aria-label={t("chat.conversations.create")} title={t("chat.toolbar.newChat")} disabled={isCreatingChat} onClick={() => { setOpen(false); void createNewChat(); }} variant="ghost" size="icon-sm">
        {isCreatingChat ? <Loader2 aria-hidden="true" className="animate-spin" /> : <SquarePen aria-hidden="true" />}
      </Button>
    </div>
  );
}
