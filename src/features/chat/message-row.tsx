"use client";
import { useLocale } from "@/lib/locale/client";
import { localizeMessage, t, tf } from "@/lib/locale";
import { MarkdownMessage } from "@/components/chat/markdown-message";
import { AnswerSources } from "@/features/chat/answer-sources";
import { DocumentAttachment } from "@/components/chat/document-attachment";
import { DocumentDownload } from "@/features/document-processor/document-download";
import { EditedFiles } from "./edited-files";
import { TaskPlan, shownPlan } from "./task-plan";
import { Reveal } from "@/components/ui/reveal";
import { QuestionRecords } from "./question-card";
import { MessageThinking, ReplyPending, ToolRunning } from "./message-thinking";
import { CompactionMarker } from "./compaction-marker";
import { formatMessageTime, fullMessageTime, readMessageTime } from "./message-time";
import { readThinking, runningToolCall } from "@/lib/chat/thinking";
import { readMessageNotice } from "@/lib/chat/invocation-schema";
import { SubagentCard, SubagentNoticeLine } from "@/features/chat/subagent-card";
import { toolLabel } from "./use-tools";
import { MessageChoices } from "./composer-choices";
import { readMessageInvocation } from "@/lib/chat/invocation-schema";
import { isDocumentAttachment } from "@/lib/media/limits";
import { assetIdFromUrl } from "@/lib/media/message-codec";
import { answerPieces, generatedPictures } from "./generated-pictures";
import { ChatPicture } from "./answer-picture";
import { ImageViewer, type ViewedImage } from "@/components/media/image-viewer";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { getFileParts, getMessageRoleLabel, isToolPart, readText } from "@/features/chat/page-utils";
import { cn } from "@/lib/utils/cn";
import { AlertCircle, Check, Copy, ImagePlus, PencilLine, RefreshCw, Trash2 } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import type { ChatState } from "@/features/chat/use-chat-state";
import type { UIMessage } from "ai";
import { removalKey } from "@/lib/ui/removal";
import type { TurnNotice } from "./page-utils";

import type { MemoryNotice } from "./conversation-store";
import { SettingsLink } from "@/features/settings/settings-context";
/*
 * One message of the transcript, and what it is drawn with: the fold of a long
 * earlier answer and the placeholder shown while a history loads.
 */

/**
 * A long answer from earlier in the conversation shows its opening and folds
 * the rest away, so scrolling back passes it quickly; one click unfolds it
 * smoothly. Whether it may fold is decided once, when it first appears: the
 * answer being read when a new question is sent never folds up under the reader.
 */
function useAnswerFold(collapsible: boolean, bodyRef: RefObject<HTMLDivElement | null>) {
  const [foldable] = useState(collapsible);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!foldable || !node) return;
    const measure = () => {
      if (node.dataset.animating) return;
      setOverflows(node.scrollHeight > node.clientHeight + 1 || (expanded && node.scrollHeight > ANSWER_FOLD_PX));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [foldable, expanded, bodyRef]);

  useEffect(() => () => { cleanupRef.current?.(); }, []);

  const toggle = useCallback(() => {
    const node = bodyRef.current;
    if (!foldable || !node || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      cleanupRef.current?.();
      setExpanded(value => !value);
      return;
    }
    const startHeight = node.getBoundingClientRect().height;
    cleanupRef.current?.();
    const nextExpanded = !expanded;
    let timer: number | null = null;
    let frame: number | null = null;
    const onEnd = (event: TransitionEvent) => {
      if (event.target === node && event.propertyName === "height") finish();
    };
    const finish = () => {
      node.removeEventListener("transitionend", onEnd);
      if (timer !== null) { window.clearTimeout(timer); timer = null; }
      if (frame !== null) { window.cancelAnimationFrame(frame); frame = null; }
      if (cleanupRef.current === finish) cleanupRef.current = null;
      delete node.dataset.animating;
      node.style.height = "";
    };
    cleanupRef.current = finish;
    node.dataset.animating = "true";
    node.style.height = `${Math.round(startHeight)}px`;
    setExpanded(nextExpanded);
    frame = window.requestAnimationFrame(() => {
      frame = null;
      const targetHeight = Math.round(nextExpanded ? node.scrollHeight : Math.min(node.scrollHeight, ANSWER_FOLD_PX));
      if (Math.round(startHeight) === targetHeight) {
        finish();
        return;
      }
      node.addEventListener("transitionend", onEnd);
      node.style.height = `${targetHeight}px`;
      timer = window.setTimeout(finish, 360);
    });
  }, [foldable, expanded, bodyRef]);

  return { foldable, expanded, overflows: foldable && overflows, toggle };
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

const readRunIds = (metadata: unknown) => {
  const value = metadata as { runId?: unknown; runIds?: unknown } | undefined;
  const ids = [...(Array.isArray(value?.runIds) ? value.runIds : []), ...(value?.runId ? [value.runId] : [])].filter((id): id is string => typeof id === "string");
  return [...new Set(ids)];
};

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
  /** The message just sent, while its turn is live: it arrives with motion. */
  arriving?: boolean;
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
  reuseImageActionLabel: string | null;
  canAttachImage: boolean;
  tools: ChatState["tools"];
  alwaysReasons: boolean;
  /** What the turn says while it waits or retries; only for the last row. */
  notice?: TurnNotice | null;
  /** What a note-taking run this answer asked for kept, shown once the answer has ended. */
  memoryNote?: MemoryNotice;
  canShowSources: boolean;
  compactionSummary: string | null;
  /** The conversation the row belongs to, for undoing its file changes. */
  chatId: string | null;
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
  message, previousMetadata, isLast, arriving = false, status, isPending, isEditing, editingText, resendsEdited, copyState, imageUrl, videoUrl,
  attachingImageKey, reuseImageActionLabel, canAttachImage, tools, alwaysReasons, notice = null, canShowSources, compactionSummary, actions, memoryNote, chatId,
}: MessageRowProps) {
  useLocale();
  const toolName = (id: string) => {
    // The checklist and questions show as themselves, not as tools the answer used.
    if (id === "updatePlan" || id === "askUser") return null;
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
  const waitingFor = toolParts.find(part => part.state === "approval-requested");
  // The call the turn is waiting on while it runs; the checklist and questions show as themselves.
  const running = runningToolCall(toolParts, isLive);
  const runningName = running ? toolName(running.tool) : null;
  const plan = isUser ? null : shownPlan(message, isLive);
  const isReasoning = isLastAssistantStreaming && message.parts.some(part => part.type === "reasoning" && part.state === "streaming");
  const isEditable = isUser && fileParts.length === 0 && !isEditing && !isPending;
  const isRegenerable = message.role === "assistant" && isLast;
  // An answer still being written has no time to state yet.
  const savedAt = isLive || isEditing ? null : readMessageTime(message.metadata);
  // An answer that made pictures shows them where they were made, between the text written before and after.
  const pieces = isUser ? null : answerPieces(message);
  const savedPictures = !isUser && !pieces ? generatedPictures(toolParts) : [];
  const hasCopyBody = !isEditing && Boolean(text || imageUrl || pieces || savedPictures.length || fileParts.some(file => file.mediaType.startsWith("image/")));
  const [viewing, setViewing] = useState<{ image: ViewedImage; returnTo: () => HTMLElement | null } | null>(null);
  const openPicture = (image: ViewedImage, returnTo: () => HTMLElement | null) => setViewing({ image, returnTo });
  const articleRef = useRef<HTMLElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const foldBodyRef = useRef<HTMLDivElement>(null);
  const fold = useAnswerFold(!isUser && !isLast, foldBodyRef);

  // Clicking empty space outside an active inline edit cancels it cleanly.
  useEffect(() => {
    if (!isEditing) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (articleRef.current?.contains(target)) return;
      if (target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [data-radix-popper-content-wrapper], .toast-stack, .message-actions')) return;
      actions.current?.cancelEditingMessage();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [isEditing, actions]);

  // Place caret at the end when entering edit mode and auto-fit the textarea height to its content.
  useLayoutEffect(() => {
    const input = editTextareaRef.current;
    if (!isEditing || !input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(256, Math.max(68, input.scrollHeight))}px`;
  }, [isEditing, editingText]);
  useEffect(() => {
    const input = editTextareaRef.current;
    if (!isEditing || !input) return;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, [isEditing]);

  const onEditKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      actions.current?.cancelEditingMessage();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && editingText.trim()) {
      event.preventDefault();
      void actions.current?.saveEditedMessage(message);
    }
  };
  const reuseButton = (imageUrl: string, key: string, filenameBase: string) => {
    const label = reuseImageActionLabel ?? (canAttachImage && assetIdFromUrl(imageUrl) ? t("chat.contextMenu.attachImage") : null);
    if (!label) return null;
    const activeLabel = attachingImageKey === key ? t("chat.messages.reusing") : label;
    return (
      <Button
        className="chat-picture-action"
        disabled={Boolean(attachingImageKey)}
        onClick={() => void actions.current?.onReuseImageForEditing({ imageUrl, key, filenameBase })}
        size="icon-sm"
        type="button"
        variant="ghost"
        aria-label={activeLabel}
        title={activeLabel}
      >
        {attachingImageKey === key ? <Spinner aria-hidden="true" /> : <ImagePlus aria-hidden="true" />}
      </Button>
    );
  };

  // RiA's own notice that background sub-agents ended: a line between the turns, not the user's message.
  const ownNotice = isUser ? readMessageNotice(message.metadata) : null;
  if (ownNotice) return <div className="flex w-full justify-center pb-3" {...removalKey(message.id)} data-message-id={message.id} data-message-role="notice"><SubagentNoticeLine titles={ownNotice.titles} /></div>;

  return (
    <><div className={cn("flex w-full", isUser ? "justify-end pb-4" : "justify-start")} {...removalKey(message.id)} data-message-id={message.id} data-message-role={message.role} data-arriving={arriving || undefined}>
      <article
        ref={articleRef}
        className={cn(
          "group min-w-0 text-sm",
          isUser
            ? isEditing
              ? "chat-user-editor relative w-full max-w-[36rem]"
              : "chat-user-bubble relative max-w-[92%] rounded-xl px-4 py-3 md:max-w-[80%]"
            : "w-full rounded-xl bg-transparent px-4 py-3 text-card-foreground",
        )}
      >
        {isUser ? (
          isEditing ? null : (
          <header className="chat-user-actions absolute right-0 top-full pt-1">
            <div className="message-actions flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              {savedAt ? (
                <time
                  className="message-time mr-1 whitespace-nowrap font-mono text-[11px] font-medium tracking-wider tabular-nums text-muted-foreground"
                  dateTime={savedAt.toISOString()} title={fullMessageTime(savedAt)}
                >
                  {formatMessageTime(savedAt)}
                </time>
              ) : null}
              {text ? (
                <Button
                  aria-label={copyState === "refused" ? t("chat.messages.copyAnswerRefused") : t("chat.messages.copyMessage")}
                  onClick={() => void actions.current?.copyAnswer({ id: message.id, text })}
                  size="icon"
                  title={copyState === "refused" ? t("chat.messages.copyAnswerRefused") : copyState === "copied" ? t("chat.code.copied") : t("chat.messages.copyMessage")}
                  type="button"
                  variant="ghost"
                >
                  {copyState === "copied" ? (
                    <Check aria-hidden="true" className="copy-confirm-icon h-3.5 w-3.5 text-success" />
                  ) : copyState === "refused" ? (
                    <AlertCircle aria-hidden="true" className="h-3.5 w-3.5 text-destructive" />
                  ) : (
                    <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                </Button>
              ) : null}
              {isEditable ? (
                <Button
                  aria-label={t("chat.messages.edit")}
                  title={t("chat.messages.edit")}
                  onClick={() => actions.current?.startEditingMessage(message)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <PencilLine aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
              ) : null}
              <Button
                aria-label={t("chat.messages.delete")}
                title={t("chat.messages.delete")}
                onClick={() => actions.current?.requestDeleteMessage(message)}
                size="icon"
                type="button"
                variant="ghost"
              >
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
            </div>
          </header>
          )
        ) : (
          <header className="mb-2 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="label-mono">
                {getMessageRoleLabel(message.role)}
              </span>
            </div>
            {isLastAssistantStreaming ? (
              <span className="label-mono inline-flex items-center">
                <Spinner aria-hidden="true" className="mr-1 h-3 w-3" />
                {t("chat.toolbar.statusGenerating")}
              </span>
            ) : null}
          </header>
        )}

        {isEditing ? (
          <div className="chat-user-editor-body">
            <Textarea
              ref={editTextareaRef}
              className="chat-user-editor-input block min-h-[68px] w-full resize-none border-0 bg-transparent px-3.5 pb-2 pt-3 text-sm leading-6 shadow-none focus-visible:ring-0"
              onChange={(event) => actions.current?.setEditingMessageText(event.target.value)}
              onKeyDown={onEditKeyDown}
              rows={2}
              value={editingText}
            />
            <div className="chat-user-editor-foot">
              <Button onClick={() => actions.current?.cancelEditingMessage()} size="sm" type="button" variant="ghost">
                {t("chat.common.cancel")}
              </Button>
              <Button disabled={!editingText.trim()} onClick={() => void actions.current?.saveEditedMessage(message)} size="sm" type="button">
                {resendsEdited ? t("chat.messages.resendEdited") : t("chat.common.save")}
              </Button>
            </div>
          </div>
        ) : null}
        {thinking ? <MessageThinking thinking={thinking} toolName={toolName}
          live={isLive}
          reasoning={isReasoning}
          answering={answerStarted(message)} /> : null}
        {/* With a checklist on show, the plain "replying" line says nothing it does not; a queue, retry or review still shows. */}
        {isLive && (notice?.state === "reviewing" || (!isReasoning && !text && !runningName && !(thinking && thinking.kind !== "hidden"))) && !toolParts.some(part => part.state === "approval-requested") && (!plan || notice)
          ? <ReplyPending reasoning={alwaysReasons} notice={notice} />
          : null}
        {/* A sub-agent has a card of its own, which says what it is doing; any other tool says so in a line. */}
        {running && running.tool !== "runSubagent" && !(running.tool === "generateImage" && pieces) && runningName && !isReasoning && notice?.state !== "reviewing" ? <ToolRunning key={running.callId} name={runningName} /> : null}
        {!isUser ? toolParts.filter(part => part.type === "tool-runSubagent").map(part => <SubagentCard key={`subagent-${part.toolCallId}`} part={part} runIds={readRunIds(message.metadata)} toolName={toolName} />) : null}
        {isLive && !text && waitingFor ? <p className="reply-waiting" role="status">{t(waitingFor.type === "tool-askUser" ? "chat.messages.waitingForAnswer" : "chat.messages.waitingForApproval")}</p> : null}
        {isUser && !isEditing && invocation ? <MessageChoices invocation={invocation} /> : null}
        {/* Leaves with a fold, not a jump, once the final answer starts. */}
        <Reveal>{plan ? <TaskPlan messageId={message.id} items={plan} /> : null}</Reveal>
        {!isUser ? <QuestionRecords parts={toolParts} /> : null}
        <div className={hasCopyBody ? undefined : "contents"} data-chat-copy-body={hasCopyBody || undefined} tabIndex={hasCopyBody ? 0 : undefined}
          role={hasCopyBody ? "group" : undefined} aria-label={hasCopyBody ? t("chat.contextMenu.messageBody") : undefined}>
        {!isEditing && pieces ? (fold.foldable ? (
          <div className="answer-fold" data-folded={!fold.expanded || undefined} data-overflows={fold.overflows || undefined}>
            <div ref={foldBodyRef} className="answer-fold-body">{pieces.map((piece, index) => {
              if (piece.kind === "text") {
                const after = pieces.slice(0, index).reverse().find(item => item.kind === "picture");
                return <MarkdownMessage key={`text-after-${after?.kind === "picture" ? after.callId : "start"}`} text={piece.text} streaming={isLastAssistantStreaming && index === pieces.length - 1} />;
              }
              if (!piece.picture && piece.state !== "input-streaming" && piece.state !== "input-available") return null;
              const picture = piece.picture;
              return <ChatPicture key={`picture-${piece.callId}`} url={picture?.url ?? null} alt={t("chat.messages.generatedImage")} testId="generated-picture" open={openPicture}>
                {picture ? reuseButton(picture.url, `${message.id}-${picture.callId}`, `generated-${picture.mediaId}`) : null}
              </ChatPicture>;
            })}</div>
          </div>
        ) : pieces.map((piece, index) => {
          if (piece.kind === "text") {
            const after = pieces.slice(0, index).reverse().find(item => item.kind === "picture");
            return <MarkdownMessage key={`text-after-${after?.kind === "picture" ? after.callId : "start"}`} text={piece.text} streaming={isLastAssistantStreaming && index === pieces.length - 1} />;
          }
          // A call that failed or was refused made nothing to show; the answer says so.
          if (!piece.picture && piece.state !== "input-streaming" && piece.state !== "input-available") return null;
          const picture = piece.picture;
          return <ChatPicture key={`picture-${piece.callId}`} url={picture?.url ?? null} alt={t("chat.messages.generatedImage")} testId="generated-picture" open={openPicture}>
            {picture ? reuseButton(picture.url, `${message.id}-${picture.callId}`, `generated-${picture.mediaId}`) : null}
          </ChatPicture>;
        }))
          : !isEditing && text ? (fold.foldable ? (
            <div className="answer-fold" data-folded={!fold.expanded || undefined} data-overflows={fold.overflows || undefined}>
              <div ref={foldBodyRef} className="answer-fold-body"><MarkdownMessage text={text} streaming={isLastAssistantStreaming} /></div>
            </div>
          ) : <MarkdownMessage text={text} streaming={isLastAssistantStreaming} />) : null}
        <div className="contents" data-chat-copy-ignore>
        {skippedTool ? <p className="mt-2 text-xs text-muted-foreground">{tf("chat.slash.toolNotCalled", { name: skippedTool })}</p> : null}
        {memoryNote && !isUser && !pendingHere ? <p className="answer-memory-note mt-2 text-xs text-muted-foreground" data-outcome={memoryNote.outcome}>
          {memoryNote.outcome === "updated" ? tf("chat.memoryNote.updated", { added: memoryNote.added, updated: memoryNote.updated, removed: memoryNote.removed })
            : memoryNote.outcome === "full" ? tf("chat.memoryNote.full", { dropped: memoryNote.dropped })
            : t(memoryNote.outcome === "unchanged" ? "chat.memoryNote.unchanged" : "chat.memoryNote.failed")}
          {memoryNote.outcome === "full" ? <> · <SettingsLink section="ria" className="underline-offset-4 hover:underline">{t("chat.memoryNote.manage")}</SettingsLink></> : null}
        </p> : null}
        {!isUser && !isLastAssistantStreaming && canShowSources ? <AnswerSources message={message} onShowAll={() => actions.current?.onShowSources?.(message.id)} /> : null}
        {toolParts.map(part => part.type === "tool-convertDocument" && part.state === "output-available" ? <DocumentDownload key={`download-${part.toolCallId}`} output={part.output} /> : null)}
        </div>
        {savedPictures.map(picture => (
          <ChatPicture key={`picture-${picture.callId}`} url={picture.url} alt={t("chat.messages.generatedImage")} testId="generated-picture" open={openPicture}>
            {reuseButton(picture.url, `${message.id}-${picture.callId}`, `generated-${picture.mediaId}`)}
          </ChatPicture>
        ))}
        {imageUrl ? (
          <ChatPicture url={imageUrl} alt={t("chat.messages.generatedImage")} testId="generated-image" open={openPicture}>
            {reuseButton(imageUrl, `${message.id}-generated`, `generated-${message.id}`)}
          </ChatPicture>
        ) : null}
        {videoUrl ? (
          <video
            data-chat-copy-ignore
            className="mt-3 aspect-video max-h-[420px] w-full rounded-lg bg-black object-contain"
            controls
            preload="metadata"
            src={videoUrl}
          />
        ) : null}
        {fileParts.map((filePart, fileIndex) => {
          if (isDocumentAttachment(filePart.mediaType)) {
            return <div data-chat-copy-ignore className="mt-3 w-64 max-w-full" key={`${message.id}-document-${fileIndex}`}><DocumentAttachment {...filePart} /></div>;
          }
          if (filePart.mediaType.startsWith("image/")) {
            return (
              <ChatPicture key={`${message.id}-file-image-${fileIndex}`} url={filePart.url} alt={filePart.filename ?? `Uploaded image ${fileIndex + 1}`} testId="message-image" open={openPicture}>
                {reuseButton(filePart.url, `${message.id}-file-image-${fileIndex}`, filePart.filename?.replace(/\.[^.]+$/, "") ?? `message-${message.id}-image-${fileIndex + 1}`)}
              </ChatPicture>
            );
          }

          if (filePart.mediaType.startsWith("video/")) {
            return (
              <video
                data-chat-copy-ignore
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
              data-chat-copy-ignore
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
        </div>
        {!isUser && !pendingHere && !toolParts.some(part => part.state === "approval-requested") ? <EditedFiles parts={toolParts} chatId={chatId} runIds={readRunIds(message.metadata)} /> : null}
        {!isUser ? (
          <footer className="chat-assistant-actions mt-2 flex flex-wrap items-center gap-1" data-has-fold={fold.overflows || undefined} data-chat-copy-ignore>
            {fold.overflows ? (
              <button type="button" className="answer-fold-toggle" aria-expanded={fold.expanded} onClick={fold.toggle}>
                {t(fold.expanded ? "chat.messages.collapseAnswer" : "chat.messages.expandAnswer")}
              </button>
            ) : null}
            <div
              className="message-actions flex items-center gap-0.5"
              data-persistent={isLast && !isLive && !isPending ? "true" : undefined}
            >
              {text ? (
                <Button
                  aria-label={copyState === "refused" ? t("chat.messages.copyAnswerRefused") : t("chat.messages.copyAnswer")}
                  onClick={() => void actions.current?.copyAnswer({ id: message.id, text })}
                  size="icon"
                  title={copyState === "refused" ? t("chat.messages.copyAnswerRefused") : copyState === "copied" ? t("chat.code.copied") : t("chat.messages.copyAnswer")}
                  type="button"
                  variant="ghost"
                >
                  {copyState === "copied" ? (
                    <Check aria-hidden="true" className="copy-confirm-icon h-3.5 w-3.5 text-success" />
                  ) : copyState === "refused" ? (
                    <AlertCircle aria-hidden="true" className="h-3.5 w-3.5 text-destructive" />
                  ) : (
                    <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                </Button>
              ) : null}
              {isRegenerable && !isPending ? (
                <Button
                  aria-label={t("chat.messages.regenerate")}
                  title={t("chat.messages.regenerate")}
                  onClick={() => void actions.current?.regenerateMessage(message.id)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
              ) : null}
              <Button
                aria-label={t("chat.messages.delete")}
                title={t("chat.messages.delete")}
                onClick={() => actions.current?.requestDeleteMessage(message)}
                size="icon"
                type="button"
                variant="ghost"
              >
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
              {savedAt ? (
                <time
                  className="message-time ml-1.5 whitespace-nowrap font-mono text-[11px] font-medium tracking-wider tabular-nums text-muted-foreground"
                  dateTime={savedAt.toISOString()} title={fullMessageTime(savedAt)}
                >
                  {formatMessageTime(savedAt)}
                </time>
              ) : null}
            </div>
          </footer>
        ) : null}
      </article>
    </div>{compactionSummary !== null ? <CompactionMarker summary={compactionSummary} /> : null}
    <ImageViewer image={viewing?.image ?? null} returnFocus={viewing?.returnTo} onClose={() => setViewing(null)} /></>
  );
});
