import { imagePrompts, quickPrompts, videoPrompts } from "@/features/chat/page-utils";
import { MarkdownMessage } from "@/components/chat/markdown-message";
import { DocumentAttachment } from "@/components/chat/document-attachment";
import { DocumentDownload } from "@/features/document-processor/document-download";
import { isDocumentAttachment } from "@/lib/media/limits";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAwaitingFirstLoad } from "@/lib/use-awaiting-first-load";
import { Textarea } from "@/components/ui/textarea";
import {
  getFileParts,
  getMessageRoleLabel,
  isToolPart,
  readReasoning,
  readText,
} from "@/features/chat/page-utils";
import { cn } from "@/lib/utils/cn";
import { writeToClipboard } from "@/lib/clipboard";
import {
  AlertCircle,
  ArrowDown,
  Check,
  Copy,
  Loader2,
  PencilLine,
  RefreshCw,
  Trash2,
  X
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Image from "next/image";
import { t, tf } from "@/lib/locale";
import type { ChatState } from "@/features/chat/use-chat-state";
import type { UIMessage } from "ai";

// The query identity is the open conversation, not a constant. `switchActiveChat`
// only sets the id; it does not clear `messages`, so the previous transcript
// stays mounted until the new one arrives. A constant key left the first-load
// gate permanently satisfied and the stale messages rendered under the new
// chat's header, which the previous `isLoadingHistory` skeleton had masked.
const DRAFT_HISTORY_QUERY = "draft";

/**
 * What the follow-the-answer effect reacts to.
 *
 * Text arriving inside the last message is a change too. A streaming answer
 * grows within a single text part, so the message count and the part count are
 * the same for every token of it: a signature built from those two alone never
 * changed while an answer was being written, and the view stopped following it.
 */
export function messageFollowSignature(messages: UIMessage[]): string {
  const last = messages.at(-1);
  if (!last) return "0";
  return `${messages.length}:${last.parts.length}:${readText(last).length}`;
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

type Props = Pick<ChatState, "appendQuickPrompt" | "modelMode" | "activeChatId" | "isLoadingHistory" | "messages" | "imageByMessageId" | "videoByMessageId" | "status" | "editingMessageId" | "isPending" | "startEditingMessage" | "regenerateMessage" | "requestDeleteMessage" | "setEditingMessageText" | "editingMessageText" | "saveEditedMessage" | "cancelEditingMessage" | "attachingImageKey" | "onReuseImageForEditing" | "reuseImageActionLabel" | "addToolApprovalResponse" | "olderMessagesCursor" | "isLoadingOlderMessages" | "loadOlderMessages" | "selectedChatModel">;
export function MessageRenderer({ appendQuickPrompt, modelMode, activeChatId, isLoadingHistory, messages, imageByMessageId, videoByMessageId, status, editingMessageId, isPending, startEditingMessage, regenerateMessage, requestDeleteMessage, setEditingMessageText, editingMessageText, saveEditedMessage, cancelEditingMessage, attachingImageKey, onReuseImageForEditing, reuseImageActionLabel, olderMessagesCursor, isLoadingOlderMessages, loadOlderMessages }: Props) {
  const awaitingFirstHistoryLoad = useAwaitingFirstLoad(isLoadingHistory, activeChatId ?? DRAFT_HISTORY_QUERY);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const olderAnchorRef = useRef<{ height: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = olderAnchorRef.current;
    const panel = scrollRef.current;
    if (!anchor || !panel || isLoadingOlderMessages) return;
    panel.scrollTop = anchor.top + panel.scrollHeight - anchor.height;
    olderAnchorRef.current = null;
  }, [messages.length, isLoadingOlderMessages]);
  const distanceFromBottom = () => {
    const panel = scrollRef.current;
    return panel ? panel.scrollHeight - panel.scrollTop - panel.clientHeight : 0;
  };

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
  useEffect(() => {
    const onScroll = () => {
      followingRef.current = distanceFromBottom() <= 96;
      if (followingRef.current) setHasUnreadBelow(false);
    };
    const panel = scrollRef.current;
    panel?.addEventListener("scroll", onScroll, { passive: true });
    return () => panel?.removeEventListener("scroll", onScroll);
  }, [activeChatId]);

  const lastMessageSignature = messageFollowSignature(messages);
  useEffect(() => {
    // Follow the reader's scroll intent. Growing text changes scrollHeight
    // even when they have stayed at the end of the conversation.
    const frame = requestAnimationFrame(() => {
      if (shouldOpenOnLayout({
        openedChatId: openedChatIdRef.current,
        activeChatId,
        awaitingFirstHistoryLoad,
        messageCount: messages.length,
      })) {
        openedChatIdRef.current = activeChatId;
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
        followingRef.current = true;
        setHasUnreadBelow(false);
        return;
      }
      // Nothing has been opened and nothing to open yet, so the position is the
      // one the page already has. The history that arrives next does the opening.
      if (openedChatIdRef.current === undefined) return;
      if (followingRef.current) {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
        followingRef.current = true;
        setHasUnreadBelow(false);
      } else if (messages.length > 0) {
        setHasUnreadBelow(true);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [lastMessageSignature, messages.length, activeChatId, awaitingFirstHistoryLoad]);

  function jumpToLatest() {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    followingRef.current = true;
    setHasUnreadBelow(false);
  }

  return (<div ref={scrollRef} className="chat-transcript relative min-h-0 flex-1 space-y-5 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-6 sm:px-7" data-testid="message-list">
  {/* The control stays inside the transcript and never overlaps the composer. */}
  {hasUnreadBelow ? (
    <div className="pointer-events-none sticky top-0 z-20 flex h-0 justify-center">
      <Button className="pointer-events-auto shadow-card" onClick={jumpToLatest} size="sm" type="button" variant="secondary">
        <ArrowDown aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
        {t("chat.messages.jumpToLatest")}
      </Button>
    </div>
  ) : null}
    {/* Same rule as the conversation list: the label stays put while older
        messages load, so the button does not resize and the scroll position
        does not shift. */}
    {olderMessagesCursor && !isLoadingHistory ? (
      <Button className="w-full" disabled={isPending || isLoadingOlderMessages} onClick={() => { const panel = scrollRef.current; if (panel) olderAnchorRef.current = { height: panel.scrollHeight, top: panel.scrollTop }; void loadOlderMessages(); }} type="button" variant="secondary">
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
    {awaitingFirstHistoryLoad ? (
      <div className="space-y-4" data-testid="message-skeleton">
        <div className="flex w-full justify-end">
          <Skeleton className="h-14 w-2/5 rounded-lg" />
        </div>
        <div className="flex w-full justify-start">
          <Skeleton className="h-24 w-4/5 rounded-lg" />
        </div>
        <div className="flex w-full justify-end">
          <Skeleton className="h-14 w-1/3 rounded-lg" />
        </div>
        <div className="flex w-full justify-start">
          <Skeleton className="h-32 w-3/4 rounded-lg" />
        </div>
      </div>
    ) : messages.length === 0 ? (
      <div className="chat-welcome flex h-full min-h-40 flex-col items-center justify-center gap-4 text-center">
        <h1 className="chat-welcome-title">{modelMode === "image" ? "让想象，有图可见。" : modelMode === "video" ? "把灵感，变成动态画面。" : "今天，有什么想一起完成？"}</h1>
        <p className="chat-welcome-description">{t("chat.messages.empty")}</p>
        <div className="mt-4 flex max-w-2xl flex-wrap justify-center gap-3">
          {(modelMode === "image" ? imagePrompts : modelMode === "video" ? videoPrompts : quickPrompts).map(prompt => <Button key={prompt} variant="outline" className="h-auto min-h-10 whitespace-normal py-2.5" onClick={() => appendQuickPrompt(prompt)}>{prompt.replace(/[:：]$/, "")}</Button>)}
        </div>
      </div>
    ) : (
      messages.map((message, index) => {
        const isUser = message.role === "user";
        const text = readText(message);
        const fileParts = getFileParts(message);
        const imageUrl = imageByMessageId[message.id];
        const videoUrl = videoByMessageId[message.id];
        const toolParts = message.parts.filter(isToolPart);
        const reasoning = readReasoning(message);
          const isLastAssistantStreaming =
          status === "streaming" && index === messages.length - 1 && message.role === "assistant";
        const isEditing = editingMessageId === message.id;
        const isEditable = isUser && fileParts.length === 0 && !isEditing && !isPending;
        const isRegenerable = message.role === "assistant" && index === messages.length - 1;

        return (
          <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")} key={message.id}>
            <article
              className={cn(
                "group min-w-0 rounded-xl px-4 py-3 text-sm",
                isUser ? "chat-user-bubble max-w-[92%] md:max-w-[80%]" : "w-full bg-transparent text-card-foreground",
              )}
            >
              <header className="mb-2 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="label-mono">
                    {getMessageRoleLabel(message.role)}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {isLastAssistantStreaming ? (
                    <span className="label-mono inline-flex items-center">
                      <Loader2 aria-hidden="true" className="mr-1 h-3 w-3 animate-spin" />
                      streaming
                    </span>
                  ) : null}
                  <div className="message-actions flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    {isEditable ? (
                      <Button
                        aria-label={t("chat.messages.edit")}
                        onClick={() => startEditingMessage(message)}
                        size="icon"
                        type="button"
                        variant="ghost"
                      >
                        <PencilLine aria-hidden="true" className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                    {isRegenerable && !isPending ? (
                      <Button
                        aria-label={t("chat.messages.regenerate")}
                        onClick={() => void regenerateMessage(message.id)}
                        size="icon"
                        type="button"
                        variant="ghost"
                      >
                        <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                    {!isUser && text ? (
                      <Button
                        aria-label={refusedMessageId === message.id ? t("chat.messages.copyAnswerRefused") : t("chat.messages.copyAnswer")}
                        onClick={() => void copyAnswer({ id: message.id, text })}
                        size="icon"
                        title={refusedMessageId === message.id ? t("chat.messages.copyAnswerRefused") : undefined}
                        type="button"
                        variant="ghost"
                      >
                        {copiedMessageId === message.id ? (
                          <Check aria-hidden="true" className="h-3.5 w-3.5 text-success" />
                        ) : refusedMessageId === message.id ? (
                          <AlertCircle aria-hidden="true" className="h-3.5 w-3.5 text-destructive" />
                        ) : (
                          <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    ) : null}
                    <Button
                      aria-label={t("chat.messages.delete")}
                      onClick={() => requestDeleteMessage(message)}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </header>

              {isEditing ? (
                <div className="space-y-2">
                  <Textarea
                    autoFocus
                    onChange={(event) => setEditingMessageText(event.target.value)}
                    rows={3}
                    value={editingMessageText}
                  />
                  <div className="flex items-center gap-1">
                    <Button onClick={() => void saveEditedMessage(message)} size="sm" type="button">
                      <Check aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                      {t("chat.common.save")}
                    </Button>
                    <Button onClick={cancelEditingMessage} size="sm" type="button" variant="ghost">
                      <X aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                      {t("chat.common.cancel")}
                    </Button>
                  </div>
                </div>
              ) : null}
              {/* The reasoning comes before the answer because that is the order
                  it happened in. It stays collapsed so the answer is what the
                  eye lands on, and open while it is still arriving so the turn
                  does not look stuck. */}
              {reasoning && !isUser ? (
                <details
                  className="mb-2 rounded-lg bg-muted text-xs"
                  open={isLastAssistantStreaming || undefined}
                >
                  <summary className="cursor-pointer px-3 py-2 font-medium">
                    {isLastAssistantStreaming ? t("chat.messages.reasoningLive") : t("chat.messages.reasoningToggle")}
                  </summary>
                  <div className="whitespace-pre-wrap border-t px-3 py-2 leading-5 text-muted-foreground">
                    {reasoning}
                  </div>
                </details>
              ) : null}
              {!isEditing && text ? <MarkdownMessage text={text} /> : null}
              {toolParts.map(part => part.type === "tool-convertDocument" && part.state === "output-available" ? <DocumentDownload key={`download-${part.toolCallId}`} output={part.output} /> : null)}
              {toolParts.some(part => part.state === "approval-requested") ? (
                <p className="mt-2 text-sm text-muted-foreground">{t(isRegenerable ? "chat.messages.reviewInComposer" : "chat.messages.historicalApprovalPending")}</p>
              ) : null}
              {imageUrl ? (
                <div className="mt-3 space-y-2">
                  <Image
                    alt="Generated"
                    className="max-h-[420px] w-full rounded-lg object-contain"
                    src={imageUrl}
                    unoptimized
                    width={1024}
                    height={1024}
                  />
                  <Button
                    disabled={Boolean(attachingImageKey)}
                    onClick={() =>
                      void onReuseImageForEditing({
                        imageUrl,
                        key: `${message.id}-generated`,
                        filenameBase: `generated-${message.id}`,
                      })
                    }
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    {attachingImageKey === `${message.id}-generated` ? t("chat.messages.reusing") : reuseImageActionLabel}
                  </Button>
                </div>
              ) : null}
              {videoUrl ? (
                <video
                  className="mt-3 max-h-[420px] w-full rounded-lg bg-black object-contain"
                  controls
                  preload="metadata"
                  src={videoUrl}
                />
              ) : null}
              {fileParts.map((filePart, fileIndex) => {
                if (isDocumentAttachment(filePart.mediaType)) {
                  return <div className="mt-3 w-64 max-w-full" key={`${message.id}-document-${fileIndex}`}><DocumentAttachment {...filePart} /></div>;
                }
                if (filePart.mediaType.startsWith("image/")) {
                  return (
                    <div className="mt-3 space-y-2" key={`${message.id}-file-image-${fileIndex}`}>
                      <Image
                        alt={filePart.filename ?? `Uploaded image ${fileIndex + 1}`}
                        className="max-h-[420px] w-full rounded-lg object-contain"
                        height={1024}
                        src={filePart.url}
                        unoptimized
                        width={1024}
                      />
                      <Button
                        disabled={Boolean(attachingImageKey)}
                        onClick={() =>
                          void onReuseImageForEditing({
                            imageUrl: filePart.url,
                            key: `${message.id}-file-image-${fileIndex}`,
                            filenameBase:
                              filePart.filename?.replace(/\.[^.]+$/, "") ??
                              `message-${message.id}-image-${fileIndex + 1}`,
                          })
                        }
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        {attachingImageKey === `${message.id}-file-image-${fileIndex}`
                          ? t("chat.messages.reusing")
                          : reuseImageActionLabel}
                      </Button>
                    </div>
                  );
                }

                if (filePart.mediaType.startsWith("video/")) {
                  return (
                    <video
                      className="mt-3 max-h-[420px] w-full rounded-lg bg-black object-contain"
                      controls
                      key={`${message.id}-file-video-${fileIndex}`}
                      preload="metadata"
                      src={filePart.url}
                    />
                  );
                }

                return (
                  <a
                    className="mt-3 block rounded-lg px-3 py-2 text-xs underline-offset-2 transition-colors duration-[--dur-fast] hover:bg-accent hover:underline"
                    href={filePart.url}
                    key={`${message.id}-file-link-${fileIndex}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {filePart.filename ?? `${t("chat.messages.attachmentFallback")} ${fileIndex + 1}`} ({filePart.mediaType})
                  </a>
                );
              })}


            </article>
          </div>
        );
      })
    )}
  </div>);
}
