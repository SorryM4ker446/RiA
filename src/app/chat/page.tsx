"use client";

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, UIMessage } from "ai";
import {
  Check,
  Loader2,
  MessageSquare,
  PencilLine,
  Plus,
  SendHorizonal,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils/cn";

type ChatSummary = {
  id: string;
  title: string;
  lastMessageAt: string;
  messageCount: number;
};

type StoredMessage = {
  id: string;
  clientMessageId: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

type ToolPart = Extract<UIMessage["parts"][number], { type: `tool-${string}` }>;

const quickPrompts = [
  "帮我总结这段内容：",
  "把这段话改写得更专业：",
  "帮我制定一周学习计划：",
];

function readText(message: UIMessage): string {
  const text = message.parts
    .filter(
      (part): part is Extract<(typeof message.parts)[number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("")
    .trim();

  if (text.length > 0) return text;

  const legacyContent = (message as { content?: unknown }).content;
  return typeof legacyContent === "string" ? legacyContent : "";
}

function isToolPart(part: UIMessage["parts"][number]): part is ToolPart {
  return (
    typeof part.type === "string" &&
    part.type.startsWith("tool-") &&
    "toolCallId" in part &&
    "state" in part
  );
}

function formatToolState(state: string): { label: string; variant: "secondary" | "success" | "warning" | "danger" } {
  switch (state) {
    case "input-streaming":
      return { label: "准备输入中", variant: "secondary" };
    case "input-available":
      return { label: "输入已就绪", variant: "secondary" };
    case "approval-requested":
      return { label: "等待批准", variant: "warning" };
    case "approval-responded":
      return { label: "已批准", variant: "success" };
    case "output-available":
      return { label: "执行完成", variant: "success" };
    case "output-error":
      return { label: "执行失败", variant: "danger" };
    case "output-denied":
      return { label: "已拒绝", variant: "warning" };
    default:
      return { label: state, variant: "secondary" };
  }
}

function mapStoredMessagesToUI(messages: StoredMessage[]): UIMessage[] {
  return messages.map((message) => ({
    id: message.clientMessageId ?? message.id,
    role: message.role,
    parts: [{ type: "text", text: message.content }],
  }));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ChatPage() {
  const [input, setInput] = useState("");
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isCreatingChat, setIsCreatingChat] = useState(false);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [pageError, setPageError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: activeChatId ? { chatId: activeChatId } : {},
      }),
    [activeChatId],
  );

  const { messages, setMessages, sendMessage, status, error, clearError } = useChat({
    id: activeChatId ?? "draft",
    transport,
  });

  const isPending = status === "submitted" || status === "streaming";
  const activeChat = chats.find((chat) => chat.id === activeChatId) ?? null;
  const effectiveError = pageError ?? error?.message ?? null;
  const keyError =
    effectiveError?.includes("GOOGLE_GENERATIVE_AI_API_KEY") ||
    effectiveError?.includes("Invalid API key");

  async function loadChats() {
    try {
      const response = await fetch("/api/conversations", { cache: "no-store" });
      if (!response.ok) {
        throw new Error("读取会话列表失败");
      }

      const payload = (await response.json()) as { data: ChatSummary[] };
      const list = payload.data ?? [];
      setChats(list);

      if (!activeChatId && list.length > 0) {
        setActiveChatId(list[0].id);
      }
    } catch (loadError) {
      setPageError(loadError instanceof Error ? loadError.message : "读取会话列表失败");
    }
  }

  async function loadMessages(chatId: string) {
    setIsLoadingHistory(true);
    setPageError(null);
    try {
      const response = await fetch(`/api/conversations/${chatId}/messages`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error("读取历史消息失败");
      }

      const payload = (await response.json()) as { data: StoredMessage[] };
      setMessages(mapStoredMessagesToUI(payload.data ?? []));
    } catch (loadError) {
      setPageError(loadError instanceof Error ? loadError.message : "读取历史消息失败");
    } finally {
      setIsLoadingHistory(false);
    }
  }

  async function createNewChat() {
    setIsCreatingChat(true);
    setPageError(null);
    try {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New Chat" }),
      });
      if (!response.ok) {
        throw new Error("创建会话失败");
      }

      const payload = (await response.json()) as { data: ChatSummary };
      const chat = payload.data;

      setActiveChatId(chat.id);
      setMessages([]);
      await loadChats();
    } catch (createError) {
      setPageError(createError instanceof Error ? createError.message : "创建会话失败");
    } finally {
      setIsCreatingChat(false);
    }
  }

  function startEditingChat(chat: ChatSummary) {
    setEditingChatId(chat.id);
    setEditingTitle(chat.title);
  }

  function cancelEditingChat() {
    setEditingChatId(null);
    setEditingTitle("");
  }

  async function saveEditedTitle(chatId: string) {
    const title = editingTitle.trim();
    if (!title) return;

    setPageError(null);
    try {
      const response = await fetch(`/api/conversations/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!response.ok) {
        throw new Error("重命名会话失败");
      }

      setChats((prev) => prev.map((chat) => (chat.id === chatId ? { ...chat, title } : chat)));
      cancelEditingChat();
    } catch (renameError) {
      setPageError(renameError instanceof Error ? renameError.message : "重命名会话失败");
    }
  }

  async function deleteConversation(chatId: string) {
    const confirmed = window.confirm("确认删除该会话？删除后不可恢复。");
    if (!confirmed) return;

    setPageError(null);
    try {
      const response = await fetch(`/api/conversations/${chatId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("删除会话失败");
      }

      const nextChats = chats.filter((chat) => chat.id !== chatId);
      setChats(nextChats);

      if (activeChatId === chatId) {
        const nextActiveId = nextChats[0]?.id ?? null;
        setActiveChatId(nextActiveId);
        if (!nextActiveId) {
          setMessages([]);
        }
      }
    } catch (deleteError) {
      setPageError(deleteError instanceof Error ? deleteError.message : "删除会话失败");
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = input.trim();
    if (!content) return;

    setPageError(null);
    let chatId = activeChatId;

    try {
      if (!chatId) {
        const response = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: content.slice(0, 40) }),
        });

        if (!response.ok) {
          throw new Error("创建会话失败");
        }

        const payload = (await response.json()) as { data: ChatSummary };
        chatId = payload.data.id;
        setActiveChatId(chatId);
      }

      setInput("");
      await sendMessage(
        { text: content },
        {
          body: chatId ? { chatId } : {},
        },
      );
      await loadChats();
    } catch (submitError) {
      setPageError(submitError instanceof Error ? submitError.message : "发送消息失败");
    }
  }

  function handleTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (isPending || !input.trim()) return;
      void onSubmit(event as unknown as FormEvent<HTMLFormElement>);
    }
  }

  function appendQuickPrompt(prompt: string) {
    setInput((prev) => {
      if (!prev.trim()) return prompt;
      if (prev.endsWith("\n")) return `${prev}${prompt}`;
      return `${prev}\n${prompt}`;
    });
    textareaRef.current?.focus();
  }

  useEffect(() => {
    void loadChats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeChatId) {
      setMessages([]);
      return;
    }
    void loadMessages(activeChatId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId]);

  useEffect(() => {
    if (status === "ready") {
      void loadChats();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, [input]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-4 p-4 md:p-6 lg:flex-row lg:items-start">
      <aside className="w-full shrink-0 lg:sticky lg:top-6 lg:w-80">
        <Card className="glass-surface overflow-hidden">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <MessageSquare className="h-4 w-4 text-primary" />
                  会话列表
                </CardTitle>
                <CardDescription>按最近更新时间排序</CardDescription>
              </div>
              <Button
                disabled={isCreatingChat}
                onClick={() => void createNewChat()}
                size="sm"
                type="button"
              >
                {isCreatingChat ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-4 w-4" />}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {chats.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                还没有会话，点击右上角按钮创建第一个会话。
              </p>
            ) : (
              chats.map((chat) => {
                const isActive = activeChatId === chat.id;
                const isEditing = editingChatId === chat.id;

                return (
                  <div
                    className={cn(
                      "rounded-lg border p-2.5 transition",
                      isActive ? "border-primary/40 bg-primary/5" : "hover:bg-muted/40",
                    )}
                    key={chat.id}
                  >
                    {isEditing ? (
                      <div className="space-y-2">
                        <Input
                          autoFocus
                          onChange={(event) => setEditingTitle(event.target.value)}
                          value={editingTitle}
                        />
                        <div className="flex items-center gap-1">
                          <Button
                            onClick={() => void saveEditedTitle(chat.id)}
                            size="sm"
                            type="button"
                            variant="default"
                          >
                            <Check className="mr-1 h-3.5 w-3.5" />
                            保存
                          </Button>
                          <Button onClick={cancelEditingChat} size="sm" type="button" variant="ghost">
                            <X className="mr-1 h-3.5 w-3.5" />
                            取消
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <button
                          className="w-full text-left"
                          onClick={() => setActiveChatId(chat.id)}
                          type="button"
                        >
                          <p className="truncate text-sm font-medium">{chat.title}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {chat.messageCount} 条消息 · {formatTime(chat.lastMessageAt)}
                          </p>
                        </button>
                        <div className="mt-2 flex items-center gap-1">
                          <Button
                            onClick={() => startEditingChat(chat)}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            <PencilLine className="mr-1 h-3.5 w-3.5" />
                            重命名
                          </Button>
                          <Button
                            onClick={() => void deleteConversation(chat.id)}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            <Trash2 className="mr-1 h-3.5 w-3.5" />
                            删除
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </aside>

      <section className="flex min-h-[80vh] min-w-0 flex-1 flex-col">
        <Card className="glass-surface flex h-full flex-col overflow-hidden">
          <CardHeader className="space-y-3 border-b border-border/70 pb-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="h-4 w-4 text-primary" />
                  {activeChat?.title ?? "新会话"}
                </CardTitle>
                <CardDescription>
                  {isPending ? "助手正在思考..." : "你可以持续多轮对话，消息会自动持久化。"}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={isPending ? "warning" : "success"}>
                  {isPending ? "生成中" : "就绪"}
                </Badge>
                <Badge variant="outline">{status}</Badge>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {quickPrompts.map((prompt) => (
                <Button
                  className="h-7 px-2.5 text-[11px]"
                  key={prompt}
                  onClick={() => appendQuickPrompt(prompt)}
                  type="button"
                  variant="secondary"
                >
                  {prompt}
                </Button>
              ))}
            </div>
          </CardHeader>

          <CardContent className="flex min-h-0 flex-1 flex-col gap-4 p-4">
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
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
                  const toolParts = message.parts.filter(isToolPart);
                  const isLastAssistantStreaming =
                    status === "streaming" && index === messages.length - 1 && message.role === "assistant";

                  return (
                    <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")} key={message.id}>
                      <article
                        className={cn(
                          "max-w-[92%] rounded-2xl border px-4 py-3 text-sm md:max-w-[80%]",
                          isUser
                            ? "border-primary/30 bg-primary text-primary-foreground"
                            : "border-border bg-card text-card-foreground",
                        )}
                      >
                        <header className="mb-2 flex items-center justify-between gap-2">
                          <span className="text-[11px] uppercase tracking-wide opacity-80">
                            {isUser ? "You" : message.role}
                          </span>
                          {isLastAssistantStreaming ? (
                            <span className="inline-flex items-center text-[11px] opacity-80">
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                              streaming
                            </span>
                          ) : null}
                        </header>

                        {text ? <p className="whitespace-pre-wrap leading-relaxed">{text}</p> : null}

                        {toolParts.length > 0 ? (
                          <div className="mt-3 space-y-2">
                            <Separator />
                            {toolParts.map((toolPart, toolIndex) => {
                              const toolState = formatToolState(toolPart.state);
                              const toolName = toolPart.type.replace(/^tool-/, "");
                              return (
                                <div
                                  className={cn(
                                    "rounded-md border px-3 py-2 text-xs",
                                    isUser ? "border-white/30 bg-white/10" : "border-border bg-muted/30",
                                  )}
                                  key={`${message.id}-${toolPart.toolCallId}-${toolIndex}`}
                                >
                                  <div className="mb-1 flex items-center gap-2">
                                    <Badge variant="outline">{toolName}</Badge>
                                    <Badge variant={toolState.variant}>{toolState.label}</Badge>
                                  </div>
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
                        ) : null}
                      </article>
                    </div>
                  );
                })
              )}
            </div>

            {effectiveError ? (
              <Alert variant="destructive">
                <AlertTitle className="flex items-center gap-2">
                  <TriangleAlert className="h-4 w-4" />
                  请求失败
                </AlertTitle>
                <AlertDescription>
                  <p>{effectiveError}</p>
                  {keyError ? (
                    <p className="mt-1">
                      检查 `.env` 中 `GOOGLE_GENERATIVE_AI_API_KEY` 是否已填写，并重启 `npm run dev`。
                    </p>
                  ) : null}
                </AlertDescription>
                <div className="mt-2">
                  <Button
                    onClick={() => {
                      setPageError(null);
                      clearError();
                    }}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    关闭提示
                  </Button>
                </div>
              </Alert>
            ) : null}

            <form className="space-y-3" onSubmit={onSubmit}>
              <Textarea
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleTextareaKeyDown}
                placeholder="输入你的问题...（Enter 发送，Shift+Enter 换行）"
                ref={textareaRef}
                rows={1}
                value={input}
              />
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  当前会话：{activeChat?.title ?? "未创建"} · 消息将自动保存
                </p>
                <Button disabled={isPending || !input.trim()} type="submit">
                  {isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Thinking...
                    </>
                  ) : (
                    <>
                      <SendHorizonal className="mr-2 h-4 w-4" />
                      发送
                    </>
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
