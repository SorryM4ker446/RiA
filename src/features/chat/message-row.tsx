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
import { formatMessageTime, fullMessageTime, readMessageTime } from "./message-time";
import { readThinking } from "@/lib/chat/thinking";
import { toolLabel } from "./use-tools";
import { MessageChoices } from "./composer-choices";
import { readMessageInvocation } from "@/lib/chat/invocation-schema";
import { isDocumentAttachment } from "@/lib/media/limits";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { getFileParts, getMessageRoleLabel, isToolPart, readText } from "@/features/chat/page-utils";
import { cn } from "@/lib/utils/cn";
import { AlertCircle, Check, Copy, Loader2, PencilLine, RefreshCw, Trash2, X } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import Image from "next/image";
import type { ChatState } from "@/features/chat/use-chat-state";
import type { UIMessage } from "ai";
import { removalKey } from "@/lib/ui/removal";
import type { TurnNotice } from "./page-utils";

/*
 * One message of the transcript, and what it is drawn with: the fold of a long
 * earlier answer and the placeholder shown while a history loads.
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
    {overflows ? (
      <button type="button" className="answer-fold-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        {t(expanded ? "chat.messages.collapseAnswer" : "chat.messages.expandAnswer")}
      </button>
    ) : null}
  </div>;
}
const ANSWER_FOLD_PX = 448;

/** Whether the answer has begun since the latest reasoning; a later tool step may reason again. */
function answerStarted(message: UIMessage) {
  for (let index = message.parts.length - 1; index >= 0; index--) {
    const part = message.parts[index];
    if (part.type === "text" && part.text.trim()) return true;
    if (part.type === "reasoning") return false;
  }
  return false;
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
export function TranscriptSkeleton() {
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
export type RowActions = Pick<ChatState,
  | "startEditingMessage" | "regenerateMessage" | "requestDeleteMessage" | "setEditingMessageText"
  | "saveEditedMessage" | "cancelEditingMessage" | "onReuseImageForEditing"
> & {
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
  /** What the turn says while it waits or retries; only for the last row. */
  notice?: TurnNotice | null;
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
export const MessageRow = memo(function MessageRow({
  message, previousMetadata, isLast, status, isPending, isEditing, editingText, resendsEdited, copyState, imageUrl, videoUrl,
  attachingImageKey, reuseImageActionLabel, tools, alwaysReasons, notice = null, canShowSources, compactionSummary, actions,
}: MessageRowProps) {
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
              {savedAt ? (
                <time
                  className="message-time mr-1 whitespace-nowrap font-mono text-[11px] font-medium tracking-wider tabular-nums text-muted-foreground"
                  dateTime={savedAt.toISOString()} title={fullMessageTime(savedAt)}
                >
                  {formatMessageTime(savedAt)}
                </time>
              ) : null}
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
        {isLive && !isReasoning && !text && !(thinking && thinking.kind !== "hidden") && !toolParts.some(part => part.state === "approval-requested")
          ? <ReplyPending reasoning={alwaysReasons} notice={notice} />
          : null}
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
