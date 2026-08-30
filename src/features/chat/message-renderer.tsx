import { MarkdownMessage } from "@/components/chat/markdown-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  formatToolState,
  getFileParts,
  getMessageRoleLabel,
  isToolPart,
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
import { getDocumentSources, getWebSearchSources, resolveMessageSourceTag } from "@/features/chat/message-presentation";
import { DocumentSources } from "@/components/knowledge/document-sources";
import type { ChatState } from "@/features/chat/use-chat-state";

type Props = Pick<ChatState, "isLoadingHistory" | "messages" | "imageByMessageId" | "videoByMessageId" | "status" | "editingMessageId" | "isPending" | "startEditingMessage" | "regenerateMessage" | "requestDeleteMessage" | "setEditingMessageText" | "editingMessageText" | "saveEditedMessage" | "cancelEditingMessage" | "attachingImageKey" | "onReuseImageForEditing" | "reuseImageActionLabel" | "addToolApprovalResponse" | "olderMessagesCursor" | "isLoadingOlderMessages" | "loadOlderMessages">;
export function MessageRenderer({ isLoadingHistory, messages, imageByMessageId, videoByMessageId, status, editingMessageId, isPending, startEditingMessage, regenerateMessage, requestDeleteMessage, setEditingMessageText, editingMessageText, saveEditedMessage, cancelEditingMessage, attachingImageKey, onReuseImageForEditing, reuseImageActionLabel, addToolApprovalResponse, olderMessagesCursor, isLoadingOlderMessages, loadOlderMessages }: Props) {
  return (<div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
    {olderMessagesCursor && !isLoadingHistory ? (
      <Button className="w-full" disabled={isPending || isLoadingOlderMessages} onClick={() => void loadOlderMessages()} type="button" variant="secondary">
        {isLoadingOlderMessages ? "加载中…" : "加载更早消息"}
      </Button>
    ) : null}
    {isLoadingHistory ? (
      <div className="space-y-3">
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="ml-auto h-16 w-1/2" />
        <Skeleton className="h-20 w-3/4" />
      </div>
    ) : messages.length === 0 ? (
      <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        开始你的第一条消息吧。支持流式回复、会话持久化和工具调用。
      </div>
    ) : (
      messages.map((message, index) => {
        const isUser = message.role === "user";
        const text = readText(message);
        const fileParts = getFileParts(message);
        const imageUrl = imageByMessageId[message.id];
        const videoUrl = videoByMessageId[message.id];
        const toolParts = message.parts.filter(isToolPart);
        const webSearchSources = getWebSearchSources(toolParts);
        const sourceTag = resolveMessageSourceTag({ role: message.role, toolParts });
        const isLastAssistantStreaming =
          status === "streaming" && index === messages.length - 1 && message.role === "assistant";
        const isEditing = editingMessageId === message.id;
        const isEditable = isUser && fileParts.length === 0 && !isEditing && !isPending;
        const isRegenerable = message.role === "assistant" && index === messages.length - 1;

        return (
          <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")} key={message.id}>
            <article
              className={cn(
                "group max-w-[92%] rounded-2xl border px-4 py-3 text-sm md:max-w-[80%]",
                isUser ? "chat-user-bubble" : "border-border bg-card text-card-foreground",
              )}
            >
              <header className="mb-2 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="text-[11px] tracking-wide opacity-80">
                    {getMessageRoleLabel(message.role)}
                  </span>
                  {sourceTag ? (
                    <Badge className="h-5 px-2 text-[10px]" variant={sourceTag.variant}>
                      {sourceTag.label}
                    </Badge>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {isLastAssistantStreaming ? (
                    <span className="inline-flex items-center text-[11px] opacity-80">
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      streaming
                    </span>
                  ) : null}
                  <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    {isEditable ? (
                      <Button
                        aria-label="编辑消息"
                        onClick={() => startEditingMessage(message)}
                        size="icon"
                        type="button"
                        variant="ghost"
                      >
                        <PencilLine className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                    {isRegenerable && !isPending ? (
                      <Button
                        aria-label="重新生成"
                        onClick={() => void regenerateMessage(message.id)}
                        size="icon"
                        type="button"
                        variant="ghost"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                    <Button
                      aria-label="删除消息"
                      onClick={() => requestDeleteMessage(message)}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
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
                      <Check className="mr-1 h-3.5 w-3.5" />
                      保存
                    </Button>
                    <Button onClick={cancelEditingMessage} size="sm" type="button" variant="ghost">
                      <X className="mr-1 h-3.5 w-3.5" />
                      取消
                    </Button>
                  </div>
                </div>
              ) : text ? (
                <MarkdownMessage text={text} />
              ) : null}
              {webSearchSources.length > 0 ? (
                <details
                  className={cn(
                    "mt-3 rounded-md border text-xs",
                    isUser ? "border-white/30 bg-white/10" : "border-border bg-muted/30",
                  )}
                >
                  <summary className="cursor-pointer px-3 py-2 font-medium">
                    搜索来源（{webSearchSources.length}） 点击展开/收起
                  </summary>
                  <ol className="space-y-2 border-t px-3 py-2">
                    {webSearchSources.map((source, sourceIndex) => (
                      <li className="leading-5" key={`${source.url}-${sourceIndex}`}>
                        <a
                          className="font-medium underline underline-offset-4"
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
                    className="max-h-[420px] w-full rounded-lg border object-contain"
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
                    {attachingImageKey === `${message.id}-generated` ? "加入中..." : reuseImageActionLabel}
                  </Button>
                </div>
              ) : null}
              {videoUrl ? (
                <video
                  className="mt-3 max-h-[420px] w-full rounded-lg border bg-black object-contain"
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
                        className="max-h-[420px] w-full rounded-lg border object-contain"
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
                          ? "加入中..."
                          : reuseImageActionLabel}
                      </Button>
                    </div>
                  );
                }

                if (filePart.mediaType.startsWith("video/")) {
                  return (
                    <video
                      className="mt-3 max-h-[420px] w-full rounded-lg border bg-black object-contain"
                      controls
                      key={`${message.id}-file-video-${fileIndex}`}
                      preload="metadata"
                      src={filePart.url}
                    />
                  );
                }

                return (
                  <a
                    className="mt-3 block rounded-md border px-3 py-2 text-xs underline-offset-2 hover:underline"
                    href={filePart.url}
                    key={`${message.id}-file-link-${fileIndex}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {filePart.filename ?? `附件 ${fileIndex + 1}`} ({filePart.mediaType})
                  </a>
                );
              })}

              {toolParts.length > 0 ? (
                <div className="mt-3">
                  <details
                    className={cn(
                      "rounded-md border text-xs",
                      isUser ? "border-white/30 bg-white/10" : "border-border bg-muted/30",
                    )}
                  >
                    <summary className="flex cursor-pointer items-center justify-between px-3 py-2">
                      <span className="truncate">
                        {(() => {
                          const first = toolParts[0];
                          const firstName = first.type.replace(/^tool-/, "");
                          const firstState = formatToolState(first.state).label;
                          const extra = toolParts.length > 1 ? `，另有 ${toolParts.length - 1} 个调用` : "";
                          return `工具详情：${firstName} · ${firstState}${extra}`;
                        })()}
                      </span>
                      <span className="ml-2 shrink-0 text-[11px] opacity-70">点开查看</span>
                    </summary>
                    <div className="space-y-2 border-t px-3 py-2">
                      {toolParts.map((toolPart, toolIndex) => {
                        const toolState = formatToolState(toolPart.state);
                        const toolName = toolPart.type.replace(/^tool-/, "");
                        return (
                          <div
                            className={cn(
                              "rounded-md border px-3 py-2 text-xs",
                              isUser ? "border-white/30 bg-white/10" : "border-border bg-black/5",
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
                                  <Check className="mr-1 h-3.5 w-3.5" />
                                  批准
                                </Button>
                                <Button
                                  disabled={isPending || index !== messages.length - 1}
                                  onClick={() =>
                                    void addToolApprovalResponse({
                                      id: toolPart.approval.id,
                                      approved: false,
                                      reason: "用户拒绝",
                                    })
                                  }
                                  size="sm"
                                  type="button"
                                  variant="outline"
                                >
                                  <X className="mr-1 h-3.5 w-3.5" />
                                  拒绝
                                </Button>
                              </div>
                            ) : null}
                            {toolPart.input !== undefined ? (
                              <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-black/5 p-2 text-[11px]">
                                input: {safeJson(toolPart.input)}
                              </pre>
                            ) : null}
                            {toolPart.state === "output-available" && toolPart.output !== undefined ? (
                              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-black/5 p-2 text-[11px]">
                                output: {safeJson(toolPart.output)}
                              </pre>
                            ) : null}
                            {toolPart.state === "output-error" && toolPart.errorText ? (
                              <p className="mt-1 text-[11px] text-red-600">error: {toolPart.errorText}</p>
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
