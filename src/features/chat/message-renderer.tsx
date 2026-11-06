"use client";
import { useLocale } from "@/lib/locale/client";
import { localizeMessage, t, tf } from "@/lib/locale";
import { MarkdownMessage } from "@/components/chat/markdown-message";
import { AnswerSources } from "@/features/chat/answer-sources";
import { DocumentAttachment } from "@/components/chat/document-attachment";
import { DocumentDownload } from "@/features/document-processor/document-download";
import { EditedFiles } from "./edited-files";
import { MessageThinking, ReplyPending } from "./message-thinking";
import { CompactionMarker } from "./compaction-marker";
import { formatMessageTime, fullMessageTime, readMessageTime, useDayRollover } from "./message-time";
import { readThinking } from "@/lib/chat/thinking";
import { toolLabel } from "./use-tools";
import { MessageChoices } from "./composer-choices";
import { readMessageInvocation } from "@/lib/chat/invocation-schema";
import { MessageNavigator } from "./message-navigator";
import { collectEditedFiles } from "@/lib/terminal/file-change-summary";
import { isDocumentAttachment } from "@/lib/media/limits";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAwaitingFirstLoad } from "@/lib/use-awaiting-first-load";
import { Textarea } from "@/components/ui/textarea";
import {
  getFileParts,
  getMessageRoleLabel,
  hasLaterUserMessage,
  isToolPart,
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
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import Image from "next/image";
import type { ChatState } from "@/features/chat/use-chat-state";
import type { UIMessage } from "ai";
import { removalKey } from "@/lib/ui/removal";

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
/**
 * A long answer from earlier in the conversation shows its opening and folds
 * the rest away, so scrolling back passes it quickly; one click shows it all.
 * Whether it may fold is decided once, when it first appears: the answer being
 * read when a new question is sent never folds up under the reader.
 */
function CollapsibleAnswer({ collapsible, children }: { collapsible: boolean; children: React.ReactNode }) {
  const [foldable] = useState(collapsible);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = body.current;
    if (!foldable || !node) return;
    const measure = () => setOverflows(node.scrollHeight > node.clientHeight + 1 || (expanded && node.scrollHeight > ANSWER_FOLD_PX));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [foldable, expanded]);
  if (!foldable) return <>{children}</>;
  return <div className="answer-fold" data-folded={!expanded || undefined} data-overflows={overflows || undefined}>
    <div ref={body} className="answer-fold-body">{children}</div>
    {overflows ? <button type="button" className="answer-fold-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{t(expanded ? "chat.messages.collapseAnswer" : "chat.messages.expandAnswer")}</button> : null}
  </div>;
}
const ANSWER_FOLD_PX = 448;

export function messageFollowSignature(messages: UIMessage[]): string {
  const last = messages.at(-1);
  if (!last) return "0";
  const downloads = last.parts.flatMap(part => part.type === "tool-convertDocument" && part.state === "output-available" ? [part.toolCallId] : []).join(",");
  return `${messages.length}:${last.id}:${readText(last).length}:${(readThinking(last)?.text.length ?? 0)}:${getFileParts(last).length}:${downloads}`;
}

/** Whether the answer has begun since the latest reasoning; a later tool step may reason again. */
function answerStarted(message: UIMessage) {
  for (let index = message.parts.length - 1; index >= 0; index--) {
    const part = message.parts[index];
    if (part.type === "text" && part.text.trim()) return true;
    if (part.type === "reasoning") return false;
  }
  return false;
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

/** How long a history load may take before its placeholder is shown at all. */
const SKELETON_DELAY_MS = 200;

/**
 * The transcript's placeholder. It holds its space from the first frame but is
 * only painted once a load has been slow enough to notice: one painted for a
 * few frames and then replaced reads as a flicker. With motion it fades in after
 * the delay (CSS); with reduced motion, which turns animations off, `data-late`
 * marks the moment it may appear.
 */
function TranscriptSkeleton() {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setLate(true), SKELETON_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return <div className="chat-transcript-skeleton space-y-4" data-testid="message-skeleton" data-late={late || undefined}>
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
  </div>;
}

/** What a row does when acted on; read when used, as the chat's handlers are new on every render. */
type RowActions = Pick<ChatState, "startEditingMessage" | "regenerateMessage" | "requestDeleteMessage" | "setEditingMessageText" | "saveEditedMessage" | "cancelEditingMessage" | "onReuseImageForEditing"> & {
  copyAnswer: (message: { id: string; text: string }) => Promise<void>;
  onShowSources?: (messageId: string) => void;
};

type MessageRowProps = {
  message: UIMessage;
  /** The metadata of the message before it, which says whether this answer skipped a chosen tool. */
  previousMetadata: unknown;
  isLast: boolean;
  /** The chat status, for the last message only: no other row changes with it. */
  status: ChatState["status"] | null;
  isPending: boolean;
  isEditing: boolean;
  editingText: string;
  resendsEdited: boolean;
  copyState: "copied" | "refused" | null;
  imageUrl: string | undefined;
  videoUrl: string | undefined;
  attachingImageKey: ChatState["attachingImageKey"];
  reuseImageActionLabel: string;
  tools: ChatState["tools"];
  alwaysReasons: boolean;
  canShowSources: boolean;
  compactionSummary: string | null;
  /** Changes at midnight, so "today" and "yesterday" are worked out again. */
  day: number;
  actions: RefObject<RowActions | null>;
};

/**
 * One message of the transcript. A streamed reply re-renders the transcript on every
 * delta; only a row whose message or place in the conversation changed does any work,
 * so a long, tool-heavy conversation streams at the cost of an empty one.
 */
const MessageRow = memo(function MessageRow({ message, previousMetadata, isLast, status, isPending, isEditing, editingText, resendsEdited, copyState, imageUrl, videoUrl, attachingImageKey, reuseImageActionLabel, tools, alwaysReasons, canShowSources, compactionSummary, actions }: MessageRowProps) {
  useLocale();
  const toolName = (id: string) => {
    const tool = tools.find(item => item.id === id);
    return tool ? (tool.extensionId ? toolLabel(tool) : localizeMessage(tool.displayName)) : null;
  };
  const pendingHere = isLast && isPending;
  const isUser = message.role === "user";
  const text = readText(message);
  const fileParts = getFileParts(message);
  const toolParts = message.parts.filter(isToolPart);
  const thinking = isUser ? null : readThinking(message);
  const invocation = isUser ? readMessageInvocation(message.metadata) : null;
  const skippedTool = !isUser && !pendingHere && typeof (message.metadata as { skippedTool?: unknown } | undefined)?.skippedTool === "string"
    ? readMessageInvocation(previousMetadata)?.tool?.label ?? null : null;
  const isLastAssistantStreaming = status === "streaming" && message.role === "assistant";
  const isLive = !isUser && isLast && (status === "streaming" || status === "submitted" || toolParts.some(part => part.state === "approval-requested"));
  const isReasoning = isLastAssistantStreaming && message.parts.some(part => part.type === "reasoning" && part.state === "streaming");
  const isEditable = isUser && fileParts.length === 0 && !isEditing && !isPending;
  const isRegenerable = message.role === "assistant" && isLast;
  // An answer still being written has no time to state yet.
  const savedAt = isLive || isEditing ? null : readMessageTime(message.metadata);

  return (
    <><div className={cn("flex w-full", isUser ? "justify-end pb-4" : "justify-start")} {...removalKey(message.id)} data-message-id={message.id} data-message-role={message.role}>
      <article
        className={cn(
          "group min-w-0 rounded-xl px-4 py-3 text-sm",
          isUser ? "chat-user-bubble relative max-w-[92%] md:max-w-[80%]" : "w-full bg-transparent text-card-foreground",
        )}
      >
        <header className={isUser ? "chat-user-actions absolute right-0 top-full pt-1" : "mb-2 flex items-center justify-between gap-2"}>
          {!isUser && <div className="flex min-w-0 items-center gap-2">
            <span className="label-mono">
              {getMessageRoleLabel(message.role)}
            </span>
          </div>}
          <div className="flex shrink-0 items-center gap-1">
            {isLastAssistantStreaming ? (
              <span className="label-mono inline-flex items-center">
                <Loader2 aria-hidden="true" className="mr-1 h-3 w-3 animate-spin" />
                {t("chat.toolbar.statusGenerating")}
              </span>
            ) : null}
            <div className="message-actions flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              {savedAt ? <time className="message-time mr-1 whitespace-nowrap font-mono text-[11px] font-medium tracking-wider tabular-nums text-muted-foreground" dateTime={savedAt.toISOString()} title={fullMessageTime(savedAt)}>{formatMessageTime(savedAt)}</time> : null}
              {isEditable ? (
                <Button
                  aria-label={t("chat.messages.edit")}
                  onClick={() => actions.current?.startEditingMessage(message)}
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
                  onClick={() => void actions.current?.regenerateMessage(message.id)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
              ) : null}
              {!isUser && text ? (
                <Button
                  aria-label={copyState === "refused" ? t("chat.messages.copyAnswerRefused") : t("chat.messages.copyAnswer")}
                  onClick={() => void actions.current?.copyAnswer({ id: message.id, text })}
                  size="icon"
                  title={copyState === "refused" ? t("chat.messages.copyAnswerRefused") : undefined}
                  type="button"
                  variant="ghost"
                >
                  {copyState === "copied" ? (
                    <Check aria-hidden="true" className="h-3.5 w-3.5 text-success" />
                  ) : copyState === "refused" ? (
                    <AlertCircle aria-hidden="true" className="h-3.5 w-3.5 text-destructive" />
                  ) : (
                    <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                </Button>
              ) : null}
              <Button
                aria-label={t("chat.messages.delete")}
                onClick={() => actions.current?.requestDeleteMessage(message)}
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
              onChange={(event) => actions.current?.setEditingMessageText(event.target.value)}
              rows={3}
              value={editingText}
            />
            <div className="flex items-center gap-1">
              <Button onClick={() => void actions.current?.saveEditedMessage(message)} size="sm" type="button">
                <Check aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                {resendsEdited ? t("chat.messages.resendEdited") : t("chat.common.save")}
              </Button>
              <Button onClick={() => actions.current?.cancelEditingMessage()} size="sm" type="button" variant="ghost">
                <X aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                {t("chat.common.cancel")}
              </Button>
            </div>
          </div>
        ) : null}
        {thinking ? <MessageThinking thinking={thinking} toolName={toolName}
          live={isLive}
          reasoning={isReasoning}
          answering={answerStarted(message)} /> : null}
        {isLive && !isReasoning && !text && !(thinking && thinking.kind !== "hidden") && !toolParts.some(part => part.state === "approval-requested") ? <ReplyPending reasoning={alwaysReasons} /> : null}
        {isUser && !isEditing && invocation ? <MessageChoices invocation={invocation} /> : null}
        {!isEditing && text ? <CollapsibleAnswer key={message.id} collapsible={!isUser && !isLast}><MarkdownMessage text={text} streaming={isLastAssistantStreaming} /></CollapsibleAnswer> : null}
        {skippedTool ? <p className="mt-2 text-xs text-muted-foreground">{tf("chat.slash.toolNotCalled", { name: skippedTool })}</p> : null}
        {!isUser && !isLastAssistantStreaming && canShowSources ? <AnswerSources message={message} onShowAll={() => actions.current?.onShowSources?.(message.id)} /> : null}
        {toolParts.map(part => part.type === "tool-convertDocument" && part.state === "output-available" ? <DocumentDownload key={`download-${part.toolCallId}`} output={part.output} /> : null)}
        {imageUrl ? (
          <div className="mt-3 space-y-2">
            <Image
              alt={t("chat.messages.generatedImage")}
              className="max-h-[420px] w-full rounded-lg object-contain"
              src={imageUrl}
              unoptimized
              width={1024}
              height={1024}
            />
            <Button
              disabled={Boolean(attachingImageKey)}
              onClick={() =>
                void actions.current?.onReuseImageForEditing({
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
            className="mt-3 aspect-video max-h-[420px] w-full rounded-lg bg-black object-contain"
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
                    void actions.current?.onReuseImageForEditing({
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
                className="mt-3 aspect-video max-h-[420px] w-full rounded-lg bg-black object-contain"
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
        {!isUser && !pendingHere && !toolParts.some(part => part.state === "approval-requested") ? <EditedFiles parts={toolParts} /> : null}
      </article>
    </div>{compactionSummary !== null ? <CompactionMarker summary={compactionSummary} /> : null}</>
  );
});

type Props = Pick<ChatState, "compaction" | "isOrganizing" | "isCompacting" | "tools" | "selectedModelInfo" | "modelMode" | "activeChatId" | "isLoadingHistory" | "isOpeningConversation" | "messages" | "imageByMessageId" | "videoByMessageId" | "status" | "editingMessageId" | "isPending" | "startEditingMessage" | "regenerateMessage" | "requestDeleteMessage" | "setEditingMessageText" | "editingMessageText" | "saveEditedMessage" | "cancelEditingMessage" | "attachingImageKey" | "onReuseImageForEditing" | "reuseImageActionLabel" | "addToolApprovalResponse" | "olderMessagesCursor" | "isLoadingOlderMessages" | "loadOlderMessages" | "selectedChatModel"> & { onShowSources?: (messageId: string) => void };
export function MessageRenderer({ compaction, isOrganizing, isCompacting, tools, selectedModelInfo, onShowSources, modelMode, activeChatId, isLoadingHistory, isOpeningConversation, messages, imageByMessageId, videoByMessageId, status, editingMessageId, isPending, startEditingMessage, regenerateMessage, requestDeleteMessage, setEditingMessageText, editingMessageText, saveEditedMessage, cancelEditingMessage, attachingImageKey, onReuseImageForEditing, reuseImageActionLabel, olderMessagesCursor, isLoadingOlderMessages, loadOlderMessages }: Props) {
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
    rowActions.current = { startEditingMessage, regenerateMessage, requestDeleteMessage, setEditingMessageText, saveEditedMessage, cancelEditingMessage, onReuseImageForEditing, copyAnswer, onShowSources };
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
        <h1 className="chat-welcome-title">{modelMode === "image" ? t("ui.chat.message-renderer.bringYourImaginationIntoView") : modelMode === "video" ? t("ui.chat.message-renderer.turnInspirationIntoMotion") : t("ui.chat.message-renderer.whatWouldYouLikeToWork")}</h1>
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
          tools={tools} alwaysReasons={alwaysReasons} canShowSources={!!onShowSources}
          compactionSummary={compaction?.coveredIds.includes(message.id) ? compaction.summary : null}
          day={day} actions={rowActions} />;
      })}
      {isCompacting || (status === "submitted" && modelMode === "chat" && messages.at(-1)?.role === "user") ? <ReplyPending reasoning={alwaysReasons} organizing={isCompacting || isOrganizing} /> : null}
    </>)}
  </div>
  </div>
  {showNavigation && <MessageNavigator key={activeChatId ?? "draft"} messages={messages} scrollRef={scrollRef} onNavigate={jumpToMessage}
    hasOlder={!!olderMessagesCursor} loadingOlder={isLoadingOlderMessages} disabled={isPending} onLoadOlder={loadEarlier} />}
  </div>);
}
