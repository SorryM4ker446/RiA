"use client";
import { useLocale } from "@/lib/locale/client";
import { t } from "@/lib/locale";
import { ReplyPending } from "./message-thinking";
import { useDayRollover } from "./message-time";
import { readThinking } from "@/lib/chat/thinking";
import { MessageNavigator } from "./message-navigator";
import { collectEditedFiles } from "@/lib/terminal/file-change-summary";
import { Button } from "@/components/ui/button";
import { useAwaitingFirstLoad } from "@/lib/use-awaiting-first-load";
import { getFileParts, hasLaterUserMessage, isToolPart, readText } from "@/features/chat/page-utils";
import { writeToClipboard } from "@/lib/clipboard";
import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatState } from "@/features/chat/use-chat-state";
import type { UIMessage } from "ai";
import { MessageRow, TranscriptSkeleton, type RowActions } from "./message-row";

// The query identity is the open conversation, not a constant. `switchActiveChat`
// only sets the id; it does not clear `messages`, so the previous transcript
// stays mounted until the new one arrives. A constant key left the first-load
// gate permanently satisfied and the stale messages rendered under the new
// chat's header, which the previous `isLoadingHistory` skeleton had masked.
const DRAFT_HISTORY_QUERY = "draft";

/**
 * What the follow-the-answer effect reacts to.
 *
 * Follow visible content as it grows, including reasoning and downloads.
 * Hidden tool and approval transitions belong to execution records and must
 * not move the reader or announce new transcript content.
 */
export function messageFollowSignature(messages: UIMessage[]): string {
  const last = messages.at(-1);
  if (!last) return "0";
  const downloads = last.parts.flatMap(part => part.type === "tool-convertDocument" && part.state === "output-available" ? [part.toolCallId] : []).join(",");
  return `${messages.length}:${last.id}:${readText(last).length}:${(readThinking(last)?.text.length ?? 0)}:${getFileParts(last).length}:${downloads}`;
}


type OpenLayoutInput = {
  /** The conversation the transcript was last opened for; undefined if none. */
  openedChatId: string | null | undefined;
  activeChatId: string | null;
  awaitingFirstHistoryLoad: boolean;
  messageCount: number;
}

/**
 * Whether a layout is a conversation opening rather than content arriving in one
 * already open.
 *
 * A conversation nobody has opened yet, and one that has just replaced another,
 * have no previous position worth keeping, so they open at the newest message.
 * While its transcript is still loading there is nothing to position: what is on
 * screen belongs to the conversation being left, and measuring the reader
 * against that is what made a switch land wherever the last one was read to.
 * An empty transcript has nothing to open either, so the history that arrives
 * next is what opens it.
 */
export function shouldOpenOnLayout({
  openedChatId,
  activeChatId,
  awaitingFirstHistoryLoad,
  messageCount,
}: OpenLayoutInput): boolean {
  if (awaitingFirstHistoryLoad) return false;
  if (openedChatId !== undefined && openedChatId === activeChatId) return false;
  return messageCount > 0;
}


type Props = Pick<ChatState,
  | "compaction" | "isOrganizing" | "turnNotice" | "isCompacting" | "tools" | "selectedModelInfo" | "modelMode" | "activeChatId"
  | "isLoadingHistory" | "isOpeningConversation" | "messages" | "imageByMessageId" | "videoByMessageId" | "status" | "editingMessageId"
  | "isPending" | "startEditingMessage" | "regenerateMessage" | "requestDeleteMessage" | "setEditingMessageText" | "editingMessageText"
  | "saveEditedMessage" | "cancelEditingMessage" | "attachingImageKey" | "onReuseImageForEditing" | "reuseImageActionLabel"
  | "addToolApprovalResponse" | "olderMessagesCursor" | "isLoadingOlderMessages" | "loadOlderMessages" | "selectedChatModel"
> & { onShowSources?: (messageId: string) => void };
export function MessageRenderer({
  compaction, isOrganizing, turnNotice, isCompacting, tools, selectedModelInfo, onShowSources, modelMode, activeChatId,
  isLoadingHistory, isOpeningConversation, messages, imageByMessageId, videoByMessageId, status, editingMessageId,
  isPending, startEditingMessage, regenerateMessage, requestDeleteMessage, setEditingMessageText, editingMessageText,
  saveEditedMessage, cancelEditingMessage, attachingImageKey, onReuseImageForEditing, reuseImageActionLabel, olderMessagesCursor,
  isLoadingOlderMessages, loadOlderMessages,
}: Props) {
  useLocale();
  // Opening counts as loading: before it is known which conversation is open, or
  // in the render where one has just been chosen, the transcript is not empty yet.
  const awaitingFirstHistoryLoad = useAwaitingFirstLoad(isLoadingHistory || isOpeningConversation, activeChatId ?? DRAFT_HISTORY_QUERY);
  // A model that must reason is reasoning from the moment it is asked, whatever it shows of it.
  const alwaysReasons = selectedModelInfo?.reasoning?.mandatory === true;
  const day = useDayRollover();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const olderAnchorRef = useRef<{ height: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = olderAnchorRef.current;
    const panel = scrollRef.current;
    if (!anchor || !panel || isLoadingOlderMessages) return;
    panel.scrollTop = anchor.top + panel.scrollHeight - anchor.height;
    olderAnchorRef.current = null;
  }, [messages.length, isLoadingOlderMessages]);
  /*
   * Following the conversation is only right while the reader is already at the
   * bottom. Yanking the viewport down mid-scroll would throw away the place they
   * scrolled to, so the position decides: near the bottom follows new content,
   * anywhere else stays put and offers a way back.
   */
  const [hasUnreadBelow, setHasUnreadBelow] = useState(false);
  // Which conversation the transcript was last opened for, so the next one is
  // recognised as new rather than as a conversation already being read. Without it
  // only the first conversation of a session opened at its newest message, and the
  // rest kept the position the reader left the previous one in.
  const openedChatIdRef = useRef<string | null | undefined>(undefined);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [refusedMessageId, setRefusedMessageId] = useState<string | null>(null);

  /**
   * Copying an answer is a first-class action, not something to be done by
   * selecting across a code block. The confirmation falls back on its own so it
   * cannot be left saying "copied" after the reader has moved on.
   */
  async function copyAnswer(message: { id: string; text: string }) {
    const outcome = await writeToClipboard(message.text);
    if (outcome === "unavailable") return;
    if (outcome === "refused") {
      setRefusedMessageId(message.id);
      setTimeout(() => setRefusedMessageId((current) => (current === message.id ? null : current)), 2000);
      return;
    }
    setCopiedMessageId(message.id);
    setTimeout(() => setCopiedMessageId((current) => (current === message.id ? null : current)), 2000);
  }
  const rowActions = useRef<RowActions | null>(null);
  useLayoutEffect(() => {
    rowActions.current = {
      startEditingMessage, regenerateMessage, requestDeleteMessage, setEditingMessageText, saveEditedMessage, cancelEditingMessage,
      onReuseImageForEditing, copyAnswer, onShowSources,
    };
  });
  useEffect(() => {
    const panel = scrollRef.current;
    if (!panel) return;
    lastScrollTopRef.current = panel.scrollTop;
    const onScroll = () => {
      const gap = panel.scrollHeight - panel.scrollTop - panel.clientHeight;
      if (gap <= 2) followingRef.current = true;
      else if (panel.scrollTop < lastScrollTopRef.current - 1) followingRef.current = false;
      lastScrollTopRef.current = panel.scrollTop;
      if (followingRef.current) setHasUnreadBelow(false);
    };
    panel.addEventListener("scroll", onScroll, { passive: true });
    return () => panel.removeEventListener("scroll", onScroll);
  }, [activeChatId]);

  const followLayout = useCallback(() => {
    const panel = scrollRef.current;
    if (!panel || !followingRef.current || olderAnchorRef.current) return;
    // A user scroll may already have moved the viewport before its queued
    // scroll event runs. Content shrinkage only clamps it to the new bottom.
    const gap = panel.scrollHeight - panel.scrollTop - panel.clientHeight;
    if (panel.scrollTop < lastScrollTopRef.current - 1 && gap > 2) {
      followingRef.current = false;
      return;
    }
    panel.scrollTo({ top: panel.scrollHeight, behavior: "instant" });
    lastScrollTopRef.current = panel.scrollTop;
  }, []);

  useLayoutEffect(() => {
    const panel = scrollRef.current, content = contentRef.current;
    if (!panel || !content) return;
    // Images, wrapping, dock resizing and disclosure animations can change the
    // layout without changing any message text. Keep the existing scroll intent.
    const observer = new ResizeObserver(() => {
      if (openedChatIdRef.current === activeChatId) followLayout();
    });
    observer.observe(panel);
    observer.observe(content);
    return () => observer.disconnect();
  }, [activeChatId, followLayout]);

  const lastMessageSignature = messageFollowSignature(messages);
  const lastReply = messages.at(-1);
  const completedChanges = !isPending && lastReply?.role === "assistant" && !lastReply.parts.some(part => isToolPart(part) && part.state === "approval-requested")
    ? collectEditedFiles(lastReply.parts) : null;
  const fileChangesSignature = completedChanges && (completedChanges.files.length || !completedChanges.complete)
    ? `${completedChanges.files.length}:${completedChanges.complete}` : "";
  useLayoutEffect(() => {
    // Follow the reader's scroll intent. Growing text changes scrollHeight
    // even when they have stayed at the end of the conversation.
    if (shouldOpenOnLayout({
      openedChatId: openedChatIdRef.current,
      activeChatId,
      awaitingFirstHistoryLoad,
      messageCount: messages.length,
    })) {
      openedChatIdRef.current = activeChatId;
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "instant" });
      lastScrollTopRef.current = scrollRef.current?.scrollTop ?? 0;
      followingRef.current = true;
      return;
    }
    if (openedChatIdRef.current !== activeChatId) return;
    followLayout();
  }, [lastMessageSignature, fileChangesSignature, messages.length, activeChatId, awaitingFirstHistoryLoad, followLayout]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (openedChatIdRef.current === activeChatId) setHasUnreadBelow(messages.length > 0 && !followingRef.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [lastMessageSignature, fileChangesSignature, messages.length, activeChatId, awaitingFirstHistoryLoad]);

  function jumpToLatest() {
    followingRef.current = true;
    lastScrollTopRef.current = scrollRef.current?.scrollTop ?? 0;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: isPending || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    setHasUnreadBelow(false);
  }

  function jumpToMessage(id: string) {
    const panel = scrollRef.current;
    const target = [...panel?.querySelectorAll<HTMLElement>("[data-message-id]") ?? []].find(element => element.dataset.messageId === id);
    if (!panel || !target) return;
    followingRef.current = false;
    panel.scrollTo({ top: panel.scrollTop + target.getBoundingClientRect().top - panel.getBoundingClientRect().top - 20,
      behavior: isPending || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }

  function loadEarlier() {
    const panel = scrollRef.current;
    if (panel) olderAnchorRef.current = { height: panel.scrollHeight, top: panel.scrollTop };
    void loadOlderMessages();
  }

  const showNavigation = !awaitingFirstHistoryLoad && messages.length > 1 && messages.some(message => message.role === "user");

  return (<div className="chat-transcript-frame relative flex min-h-0 flex-1" data-navigation={showNavigation}>
  <div ref={scrollRef} className="chat-transcript relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-6 sm:px-7" data-testid="message-list">
  {/* The control stays inside the transcript and never overlaps the composer. It sits
      outside the message column: an item of that column, however short, adds the column's
      gap, which would push what is being read down the page when it appears. */}
  {hasUnreadBelow ? (
    <div className="pointer-events-none sticky top-0 z-20 flex h-0 justify-center">
      <Button className="pointer-events-auto shadow-card" onClick={jumpToLatest} size="sm" type="button" variant="secondary">
        <ArrowDown aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
        {t("chat.messages.jumpToLatest")}
      </Button>
    </div>
  ) : null}
  <div ref={contentRef} className="chat-transcript-content flex min-h-full flex-col gap-5">
    {/* Same rule as the conversation list: the label stays put while older
        messages load, so the button does not resize and the scroll position
        does not shift. */}
    {olderMessagesCursor && !isLoadingHistory ? (
      <Button className="w-full" disabled={isPending || isLoadingOlderMessages} onClick={loadEarlier} type="button" variant="secondary">
        {t("chat.messages.loadOlder")}
      </Button>
    ) : null}
    {/*
      The skeleton is measured against a real exchange rather than picked to
      look like a placeholder. It stood three fixed bars tall, so a conversation
      with four messages arrived by collapsing two hundred pixels of reserved
      space into its true height — the page jumped on every load, which reads as
      a flicker even though nothing moved on its own. The bars below use the
      bubble's own metrics, so the swap changes content and not geometry.
    */}
    {awaitingFirstHistoryLoad ? <TranscriptSkeleton /> : messages.length === 0 ? (
      <div className="chat-welcome flex min-h-40 flex-1 flex-col items-center justify-center gap-2 text-center">
        <h1 className="chat-welcome-title">
          {modelMode === "image" ? t("ui.chat.message-renderer.bringYourImaginationIntoView")
            : modelMode === "video" ? t("ui.chat.message-renderer.turnInspirationIntoMotion")
            : t("ui.chat.message-renderer.whatWouldYouLikeToWork")}
        </h1>
        <p className="chat-welcome-description">{t("chat.messages.empty")}</p>
      </div>
    ) : (<>
      {messages.map((message, index) => {
        const isLast = index === messages.length - 1;
        const isEditing = editingMessageId === message.id;
        return <MessageRow key={message.id} message={message} previousMetadata={messages[index - 1]?.metadata}
          isLast={isLast} status={isLast ? status : null} isPending={isPending}
          isEditing={isEditing} editingText={isEditing ? editingMessageText : ""} resendsEdited={isEditing && hasLaterUserMessage(messages, message.id)}
          copyState={copiedMessageId === message.id ? "copied" : refusedMessageId === message.id ? "refused" : null}
          imageUrl={imageByMessageId[message.id]} videoUrl={videoByMessageId[message.id]}
          attachingImageKey={attachingImageKey} reuseImageActionLabel={reuseImageActionLabel}
          tools={tools} alwaysReasons={alwaysReasons} notice={isLast ? turnNotice : null} canShowSources={!!onShowSources}
          compactionSummary={compaction?.coveredIds.includes(message.id) ? compaction.summary : null}
          day={day} actions={rowActions} />;
      })}
      {isCompacting || (status === "submitted" && modelMode === "chat" && messages.at(-1)?.role === "user")
        ? <ReplyPending reasoning={alwaysReasons} organizing={isCompacting || isOrganizing} notice={turnNotice} />
        : null}
    </>)}
  </div>
  </div>
  {showNavigation && <MessageNavigator key={activeChatId ?? "draft"} messages={messages} scrollRef={scrollRef} onNavigate={jumpToMessage}
    hasOlder={!!olderMessagesCursor} loadingOlder={isLoadingOlderMessages} disabled={isPending} onLoadOlder={loadEarlier} />}
  </div>);
}
