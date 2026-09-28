import { MarkdownMessage } from "@/components/chat/markdown-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAwaitingFirstLoad } from "@/lib/use-awaiting-first-load";
import { Textarea } from "@/components/ui/textarea";
import {
  formatToolState,
  getFileParts,
  getMessageRoleLabel,
  isToolPart,
  readReasoning,
  readText,
  safeJson
} from "@/features/chat/page-utils";
import { cn } from "@/lib/utils/cn";
import {
  Check,
  Loader2,
  PencilLine,
  RefreshCw,
  Trash2,
  X
} from "lucide-react";
import Image from "next/image";
import { getDocumentSources, getTurnNotices, getWebSearchSources, resolveMessageSourceTag } from "@/features/chat/message-presentation";
import { t, tf } from "@/lib/locale";
import { DocumentSources } from "@/components/knowledge/document-sources";
import type { ChatState } from "@/features/chat/use-chat-state";

// The query identity is the open conversation, not a constant. `switchActiveChat`
// only sets the id; it does not clear `messages`, so the previous transcript
// stays mounted until the new one arrives. A constant key left the first-load
// gate permanently satisfied and the stale messages rendered under the new
// chat's header, which the previous `isLoadingHistory` skeleton had masked.
const DRAFT_HISTORY_QUERY = "draft";
type Props = Pick<ChatState, "activeChatId" | "isLoadingHistory" | "messages" | "imageByMessageId" | "videoByMessageId" | "status" | "editingMessageId" | "isPending" | "startEditingMessage" | "regenerateMessage" | "requestDeleteMessage" | "setEditingMessageText" | "editingMessageText" | "saveEditedMessage" | "cancelEditingMessage" | "attachingImageKey" | "onReuseImageForEditing" | "reuseImageActionLabel" | "addToolApprovalResponse" | "olderMessagesCursor" | "isLoadingOlderMessages" | "loadOlderMessages">;
export function MessageRenderer({ activeChatId, isLoadingHistory, messages, imageByMessageId, videoByMessageId, status, editingMessageId, isPending, startEditingMessage, regenerateMessage, requestDeleteMessage, setEditingMessageText, editingMessageText, saveEditedMessage, cancelEditingMessage, attachingImageKey, onReuseImageForEditing, reuseImageActionLabel, addToolApprovalResponse, olderMessagesCursor, isLoadingOlderMessages, loadOlderMessages }: Props) {
  const awaitingFirstHistoryLoad = useAwaitingFirstLoad(isLoadingHistory, activeChatId ?? DRAFT_HISTORY_QUERY);
  return (<div className="chat-list-scroll min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
    {/* Same rule as the conversation list: the label stays put while older
        messages load, so the button does not resize and the scroll position
        does not shift. */}
    {olderMessagesCursor && !isLoadingHistory ? (
      <Button className="w-full" disabled={isPending || isLoadingOlderMessages} onClick={() => void loadOlderMessages()} type="button" variant="secondary">
        {t("chat.messages.loadOlder")}
      </Button>
    ) : null}
    {/* A reload that still has messages on screen keeps them; the skeleton is
        only for a conversation that has nothing to show yet. */}
    {awaitingFirstHistoryLoad ? (
      <div className="space-y-3">
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="ml-auto h-16 w-1/2" />
        <Skeleton className="h-20 w-3/4" />
      </div>
    ) : messages.length === 0 ? (
      <div className="empty-state">
        {t("chat.messages.empty")}
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
        const webSearchSources = getWebSearchSources(toolParts);
        const sourceTag = resolveMessageSourceTag({ role: message.role, toolParts });
        // Stated once per turn and kept across reloads, so a turn that had no
        // internet access says so in the same place every time it is read.
        const turnNotices = getTurnNotices(message);
        const isLastAssistantStreaming =
          status === "streaming" && index === messages.length - 1 && message.role === "assistant";
        const isEditing = editingMessageId === message.id;
        const isEditable = isUser && fileParts.length === 0 && !isEditing && !isPending;
        const isRegenerable = message.role === "assistant" && index === messages.length - 1;

        return (
          <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")} key={message.id}>
            <article
              className={cn(
                "group max-w-[92%] rounded-lg px-4 py-3 text-sm md:max-w-[80%]",
                isUser ? "chat-user-bubble" : "bg-card text-card-foreground shadow-card",
              )}
            >
              <header className="mb-2 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="label-mono">
                    {getMessageRoleLabel(message.role)}
                  </span>
                  {sourceTag ? (
                    <Badge className="h-5 px-2 text-[10px]" variant={sourceTag.variant}>
                      {sourceTag.label}
                    </Badge>
                  ) : null}
                  {turnNotices.map((notice) => (
                    <Badge className="h-5 px-2 text-[10px]" key={notice} variant="outline">
                      {notice}
                    </Badge>
                  ))}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {isLastAssistantStreaming ? (
                    <span className="label-mono inline-flex items-center">
                      <Loader2 aria-hidden="true" className="mr-1 h-3 w-3 animate-spin" />
                      streaming
                    </span>
                  ) : null}
                  <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
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
              {webSearchSources.length > 0 ? (
                <details
                  className={cn(
                    "mt-3 rounded-lg text-xs",
                    isUser ? "bg-foreground/5" : "bg-muted",
                  )}
                >
                  <summary className="cursor-pointer px-3 py-2 font-medium">
                    {tf("chat.messages.searchSourcesPrefix", { count: webSearchSources.length })} {t("chat.messages.searchSourcesToggle")}
                  </summary>
                  <ol className="space-y-2 border-t px-3 py-2">
                    {webSearchSources.map((source, sourceIndex) => (
                      <li className="leading-5" key={`${source.url}-${sourceIndex}`}>
                        <a
                          className="font-medium text-ring underline decoration-ring/40 underline-offset-4 transition-colors duration-[--dur-fast] hover:decoration-ring"
                          href={source.url}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {sourceIndex + 1}. {source.title}
                        </a>
                        {source.snippet ? (
                          <p className="mt-1 line-clamp-3 text-muted-foreground">{source.snippet}</p>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}
              <DocumentSources sources={getDocumentSources(message)} />
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

              {toolParts.length > 0 ? (
                <div className="mt-3">
                  <details
                    className={cn(
                      "rounded-lg text-xs",
                      isUser ? "bg-foreground/5" : "bg-muted",
                    )}
                  >
                    <summary className="flex cursor-pointer items-center justify-between px-3 py-2">
                      <span className="truncate">
                        {(() => {
                          const first = toolParts[0];
                          const firstName = first.type.replace(/^tool-/, "");
                          const firstState = formatToolState(first.state).label;
                          const extra = toolParts.length > 1 ? `${t("chat.messages.extraCallsPrefix")} ${toolParts.length - 1} ${t("chat.messages.extraCallsSuffix")}` : "";
                          return tf("chat.messages.toolDetails", { name: firstName, state: firstState, extra });
                        })()}
                      </span>
                      <span className="label-mono ml-2 shrink-0">{t("chat.messages.expandHint")}</span>
                    </summary>
                    <div className="space-y-2 border-t px-3 py-2">
                      {toolParts.map((toolPart, toolIndex) => {
                        const toolState = formatToolState(toolPart.state);
                        const toolName = toolPart.type.replace(/^tool-/, "");
                        return (
                          <div
                            className={cn(
                              "rounded-lg px-3 py-2 text-xs",
                              isUser ? "bg-foreground/5" : "bg-muted",
                            )}
                            key={`${message.id}-${toolPart.toolCallId}-${toolIndex}`}
                          >
                            <div className="mb-1 flex items-center gap-2">
                              <Badge variant="outline">{toolName}</Badge>
                              <Badge variant={toolState.variant}>{toolState.label}</Badge>
                            </div>
                            {toolPart.state === "approval-requested" && "approval" in toolPart && toolPart.approval ? (
                              <div className="mt-2 flex items-center gap-2">
                                <Button
                                  disabled={isPending || index !== messages.length - 1}
                                  onClick={() =>
                                    void addToolApprovalResponse({
                                      id: toolPart.approval.id,
                                      approved: true,
                                    })
                                  }
                                  size="sm"
                                  type="button"
                                >
                                  <Check aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                                  {t("chat.messages.approve")}
                                </Button>
                                <Button
                                  disabled={isPending || index !== messages.length - 1}
                                  onClick={() =>
                                    void addToolApprovalResponse({
                                      id: toolPart.approval.id,
                                      approved: false,
                                      reason: t("chat.messages.approvalRejectedReason"),
                                    })
                                  }
                                  size="sm"
                                  type="button"
                                  variant="outline"
                                >
                                  <X aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                                  {t("chat.messages.reject")}
                                </Button>
                              </div>
                            ) : null}
                            {toolPart.input !== undefined ? (
                              <pre className="chat-list-scroll overflow-x-auto whitespace-pre-wrap rounded-md bg-foreground/5 p-2 font-mono text-[11px]">
                                input: {safeJson(toolPart.input)}
                              </pre>
                            ) : null}
                            {toolPart.state === "output-available" && toolPart.output !== undefined ? (
                              <pre className="chat-list-scroll mt-1 overflow-x-auto whitespace-pre-wrap rounded-md bg-foreground/5 p-2 font-mono text-[11px]">
                                output: {safeJson(toolPart.output)}
                              </pre>
                            ) : null}
                            {toolPart.state === "output-error" && toolPart.errorText ? (
                              <p className="mt-1 text-[11px] text-destructive">error: {toolPart.errorText}</p>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </details>
                </div>
              ) : null}
            </article>
          </div>
        );
      })
    )}
  </div>);
}
