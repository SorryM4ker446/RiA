"use client";

import { ChangeEvent, ClipboardEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
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
import {
  chatModelSupportsImageInput,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MODEL,
  DEFAULT_VIDEO_MODEL,
  OPENROUTER_IMAGE_MODELS,
  OPENROUTER_MODELS,
  OPENROUTER_VIDEO_MODELS,
  resolveImageModelId,
  resolveModelId,
  resolveVideoModelId,
  type SupportedImageModelId,
  type SupportedModelId,
  type SupportedVideoModelId,
} from "@/config/model";
import {
  ChatSummary,
  MessageStatus,
  ModelMode,
  StoredMessage,
  UploadableFilePart,
  dedupeFiles,
  encodeImageMessage,
  encodeVideoMessage,
  filesToUploadParts,
  formatTime,
  formatToolState,
  getFileParts,
  getMessageRoleLabel,
  imagePrompts,
  isToolPart,
  mapStoredMessagesToUI,
  normalizePastedFiles,
  quickPrompts,
  readText,
  safeJson,
  videoPrompts,
} from "@/features/chat/page-utils";
import { encodePersistedUserMessage } from "@/lib/ai/ui-message";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils/cn";

export default function ChatPage() {
  const [input, setInput] = useState("");
  const [modelMode, setModelMode] = useState<ModelMode>("chat");
  const [selectedChatModel, setSelectedChatModel] = useState<SupportedModelId>(DEFAULT_MODEL);
  const [selectedImageModel, setSelectedImageModel] = useState<SupportedImageModelId>(DEFAULT_IMAGE_MODEL);
  const [selectedVideoModel, setSelectedVideoModel] = useState<SupportedVideoModelId>(DEFAULT_VIDEO_MODEL);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [isGeneratingVideo, setIsGeneratingVideo] = useState(false);
  const [imageByMessageId, setImageByMessageId] = useState<Record<string, string>>({});
  const [videoByMessageId, setVideoByMessageId] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<File[]>([]);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isCreatingChat, setIsCreatingChat] = useState(false);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [pageError, setPageError] = useState<string | null>(null);
  const [attachingImageKey, setAttachingImageKey] = useState<string | null>(null);
  const [hasLoadedModelPrefs, setHasLoadedModelPrefs] = useState(false);
  const [pendingDeleteChat, setPendingDeleteChat] = useState<ChatSummary | null>(null);
  const [isDeletingChat, setIsDeletingChat] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: activeChatId
          ? { chatId: activeChatId, modelId: selectedChatModel }
          : { modelId: selectedChatModel },
      }),
    [activeChatId, selectedChatModel],
  );

  const { messages, setMessages, sendMessage, status, error, clearError } = useChat({
    id: activeChatId ?? "draft",
    transport,
  });

  const isPending =
    status === "submitted" || status === "streaming" || isGeneratingImage || isGeneratingVideo;
  const activeChat = chats.find((chat) => chat.id === activeChatId) ?? null;
  const selectedModel =
    modelMode === "chat"
      ? selectedChatModel
      : modelMode === "image"
        ? selectedImageModel
        : selectedVideoModel;
  const selectedModelInfo =
    modelMode === "chat"
      ? OPENROUTER_MODELS.find((model) => model.id === selectedChatModel)
      : modelMode === "image"
        ? OPENROUTER_IMAGE_MODELS.find((model) => model.id === selectedImageModel)
        : OPENROUTER_VIDEO_MODELS.find((model) => model.id === selectedVideoModel);
  const effectiveError = pageError ?? error?.message ?? null;
  const keyError =
    effectiveError?.includes("OPENROUTER_API_KEY") ||
    effectiveError?.includes("Invalid API key") ||
    effectiveError?.includes("No auth credentials found");
  const attachmentNames = attachments.map((file) => file.name || "未命名文件");

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
      const mapped = mapStoredMessagesToUI(payload.data ?? []);
      setMessages(mapped.uiMessages);
      setImageByMessageId(mapped.imageMap);
      setVideoByMessageId(mapped.videoMap);
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
      setImageByMessageId({});
      setVideoByMessageId({});
      clearAttachments();
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

  function requestDeleteConversation(chat: ChatSummary) {
    setPendingDeleteChat(chat);
  }

  function closeDeleteDialog() {
    if (isDeletingChat) return;
    setPendingDeleteChat(null);
  }

  async function confirmDeleteConversation() {
    if (!pendingDeleteChat) return;
    const chatId = pendingDeleteChat.id;

    setPageError(null);
    setIsDeletingChat(true);
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
          setImageByMessageId({});
          setVideoByMessageId({});
          clearAttachments();
        }
      }
    } catch (deleteError) {
      setPageError(deleteError instanceof Error ? deleteError.message : "删除会话失败");
    } finally {
      setIsDeletingChat(false);
      setPendingDeleteChat(null);
    }
  }

  async function ensureActiveChatId(titleSeed: string): Promise<string> {
    if (activeChatId) return activeChatId;

    const response = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: titleSeed.slice(0, 40) || "New Chat" }),
    });

    if (!response.ok) {
      throw new Error("创建会话失败");
    }

    const payload = (await response.json()) as { data: ChatSummary };
    const chatId = payload.data.id;
    setActiveChatId(chatId);
    return chatId;
  }

  function clearAttachments() {
    setAttachments([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function appendAttachments(nextFiles: File[]) {
    const normalized = normalizePastedFiles(nextFiles);
    if (normalized.length === 0) return;
    setAttachments((prev) => dedupeFiles([...prev, ...normalized]));
  }

  function extensionFromImageType(mediaType: string): string {
    if (mediaType.includes("jpeg")) return "jpg";
    if (mediaType.includes("webp")) return "webp";
    if (mediaType.includes("gif")) return "gif";
    return "png";
  }

  async function onReuseImageForEditing(params: {
    imageUrl: string;
    key: string;
    filenameBase: string;
  }) {
    setPageError(null);
    setAttachingImageKey(params.key);

    try {
      const response = await fetch(params.imageUrl);
      if (!response.ok) {
        throw new Error("读取图片失败，无法继续编辑。");
      }

      const blob = await response.blob();
      const mediaType = blob.type.startsWith("image/") ? blob.type : "image/png";
      const extension = extensionFromImageType(mediaType);
      const fileName = `${params.filenameBase}.${extension}`;
      const file = new File([blob], fileName, {
        type: mediaType,
        lastModified: Date.now(),
      });

      appendAttachments([file]);
      setModelMode("image");
      textareaRef.current?.focus();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "加入编辑附件失败");
    } finally {
      setAttachingImageKey(null);
    }
  }

  function onAttachmentInputChange(event: ChangeEvent<HTMLInputElement>) {
    appendAttachments(Array.from(event.target.files ?? []));
    event.currentTarget.value = "";
  }

  function onTextareaPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pastedFiles = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    if (pastedFiles.length === 0) return;
    event.preventDefault();
    appendAttachments(pastedFiles);
  }

  async function persistConversationMessage(params: {
    chatId: string;
    role: "user" | "assistant" | "system";
    content: string;
    clientMessageId: string;
    status?: MessageStatus;
  }) {
    const response = await fetch(`/api/conversations/${params.chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: params.role,
        content: params.content,
        clientMessageId: params.clientMessageId,
        status: params.status ?? "success",
      }),
    });

    if (!response.ok) {
      throw new Error("保存消息失败");
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = input.trim();
    const hasAttachments = attachments.length > 0;
    const hasContent = content.length > 0;

    if (!hasContent && !hasAttachments) return;

    setPageError(null);

    if (modelMode === "chat" && hasAttachments && !chatModelSupportsImageInput(selectedChatModel)) {
      setPageError(`当前聊天模型 ${selectedChatModel} 不支持图片输入，请切换视觉模型或移除附件。`);
      return;
    }

    if (hasContent) setInput("");

    let uploadParts: UploadableFilePart[] = [];
    if (hasAttachments) {
      try {
        uploadParts = await filesToUploadParts(attachments);
      } catch (error) {
        setPageError(error instanceof Error ? error.message : "附件读取失败");
        return;
      }
    }

    if (modelMode === "image") {
      let chatId: string;
      try {
        chatId = await ensureActiveChatId(content || "图片生成");
      } catch (chatError) {
        setPageError(chatError instanceof Error ? chatError.message : "创建会话失败");
        return;
      }

      const userMessageId = crypto.randomUUID();
      const assistantMessageId = crypto.randomUUID();
      const nextMessages: UIMessage[] = [
        ...messages,
        {
          id: userMessageId,
          role: "user",
          parts: [
            ...(hasContent ? ([{ type: "text", text: content }] as UIMessage["parts"]) : []),
            ...uploadParts,
          ],
        },
        {
          id: assistantMessageId,
          role: "assistant",
          parts: [{ type: "text", text: "正在生成图片..." }],
        },
      ];
      setMessages(nextMessages);
      setIsGeneratingImage(true);

      try {
        await persistConversationMessage({
          chatId,
          role: "user",
          content:
            uploadParts.length > 0
              ? encodePersistedUserMessage({
                  type: "user-message",
                  text: content,
                  files: uploadParts.map((file) => ({
                    url: file.url,
                    mediaType: file.mediaType,
                    ...(file.filename ? { filename: file.filename } : {}),
                  })),
                })
              : content,
          clientMessageId: userMessageId,
        });

        const response = await fetch("/api/image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: content,
            modelId: selectedImageModel,
            inputImages: uploadParts.map((file) => ({
              url: file.url,
              mediaType: file.mediaType,
            })),
          }),
        });

        const payload = (await response.json()) as { error?: string; modelId?: string; dataUrl?: string };
        if (!response.ok || !payload.dataUrl) {
          throw new Error(payload.error ?? "图片生成失败");
        }

        setImageByMessageId((prev) => ({
          ...prev,
          [assistantMessageId]: payload.dataUrl as string,
        }));
        setMessages(
          nextMessages.map((message) =>
            message.id === assistantMessageId
              ? {
                  ...message,
                  parts: [{ type: "text", text: `图片生成完成 · ${payload.modelId ?? selectedImageModel}` }],
                }
              : message,
          ),
        );
        await persistConversationMessage({
          chatId,
          role: "assistant",
          content: encodeImageMessage({
            type: "image-result",
            dataUrl: payload.dataUrl,
            modelId: payload.modelId ?? selectedImageModel,
            text: `图片生成完成 · ${payload.modelId ?? selectedImageModel}`,
          }),
          clientMessageId: assistantMessageId,
        });
        await loadChats();
        clearAttachments();
      } catch (submitError) {
        const errorText = "图片生成失败，请稍后重试。";
        setMessages(
          nextMessages.map((message) =>
            message.id === assistantMessageId
              ? {
                  ...message,
                  parts: [{ type: "text", text: errorText }],
                }
              : message,
          ),
        );
        try {
          await persistConversationMessage({
            chatId,
            role: "assistant",
            content: errorText,
            clientMessageId: assistantMessageId,
            status: "error",
          });
          await loadChats();
        } catch {
          // Keep UI responsive even if persistence fails.
        }
        setPageError(submitError instanceof Error ? submitError.message : "图片生成失败");
      } finally {
        setIsGeneratingImage(false);
      }

      return;
    }

    if (modelMode === "video") {
      let chatId: string;
      try {
        chatId = await ensureActiveChatId(content || "视频生成");
      } catch (chatError) {
        setPageError(chatError instanceof Error ? chatError.message : "创建会话失败");
        return;
      }

      const userMessageId = crypto.randomUUID();
      const assistantMessageId = crypto.randomUUID();
      const nextMessages: UIMessage[] = [
        ...messages,
        {
          id: userMessageId,
          role: "user",
          parts: [
            ...(hasContent ? ([{ type: "text", text: content }] as UIMessage["parts"]) : []),
            ...uploadParts,
          ],
        },
        {
          id: assistantMessageId,
          role: "assistant",
          parts: [{ type: "text", text: "正在生成视频..." }],
        },
      ];
      setMessages(nextMessages);
      setIsGeneratingVideo(true);

      try {
        await persistConversationMessage({
          chatId,
          role: "user",
          content:
            uploadParts.length > 0
              ? encodePersistedUserMessage({
                  type: "user-message",
                  text: content,
                  files: uploadParts.map((file) => ({
                    url: file.url,
                    mediaType: file.mediaType,
                    ...(file.filename ? { filename: file.filename } : {}),
                  })),
                })
              : content,
          clientMessageId: userMessageId,
        });

        const response = await fetch("/api/video", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: content,
            modelId: selectedVideoModel,
            inputImage:
              uploadParts.length > 0
                ? {
                    url: uploadParts[0].url,
                    mediaType: uploadParts[0].mediaType,
                  }
                : undefined,
          }),
        });

        const payload = (await response.json()) as { error?: string; modelId?: string; videoUrl?: string };
        if (!response.ok || !payload.videoUrl) {
          throw new Error(payload.error ?? "视频生成失败");
        }

        setVideoByMessageId((prev) => ({
          ...prev,
          [assistantMessageId]: payload.videoUrl as string,
        }));
        setMessages(
          nextMessages.map((message) =>
            message.id === assistantMessageId
              ? {
                  ...message,
                  parts: [{ type: "text", text: `视频生成完成 · ${payload.modelId ?? selectedVideoModel}` }],
                }
              : message,
          ),
        );
        await persistConversationMessage({
          chatId,
          role: "assistant",
          content: encodeVideoMessage({
            type: "video-result",
            videoUrl: payload.videoUrl,
            modelId: payload.modelId ?? selectedVideoModel,
            text: `视频生成完成 · ${payload.modelId ?? selectedVideoModel}`,
          }),
          clientMessageId: assistantMessageId,
        });
        await loadChats();
        clearAttachments();
      } catch (submitError) {
        const errorText = "视频生成失败，请稍后重试。";
        setMessages(
          nextMessages.map((message) =>
            message.id === assistantMessageId
              ? {
                  ...message,
                  parts: [{ type: "text", text: errorText }],
                }
              : message,
          ),
        );
        try {
          await persistConversationMessage({
            chatId,
            role: "assistant",
            content: errorText,
            clientMessageId: assistantMessageId,
            status: "error",
          });
          await loadChats();
        } catch {
          // Keep UI responsive even if persistence fails.
        }
        setPageError(submitError instanceof Error ? submitError.message : "视频生成失败");
      } finally {
        setIsGeneratingVideo(false);
      }

      return;
    }

    try {
      const chatId = await ensureActiveChatId(content || "图片消息");

      if (hasAttachments) {
        if (hasContent) {
          await sendMessage(
            { text: content, files: uploadParts },
            {
              body: { chatId, modelId: selectedChatModel },
            },
          );
        } else {
          await sendMessage(
            { files: uploadParts },
            {
              body: { chatId, modelId: selectedChatModel },
            },
          );
        }
      } else {
        await sendMessage(
          { text: content },
          {
            body: { chatId, modelId: selectedChatModel },
          },
        );
      }

      clearAttachments();
      await loadChats();
    } catch (submitError) {
      setPageError(submitError instanceof Error ? submitError.message : "发送消息失败");
    }
  }

  function handleTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const hasAttachments = attachments.length > 0;
      const hasContent = input.trim().length > 0;
      if (isPending) return;
      if (!hasContent && !hasAttachments) return;
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

  function onModelSelect(value: string) {
    if (modelMode === "chat") {
      setSelectedChatModel(resolveModelId(value));
      return;
    }
    if (modelMode === "image") {
      setSelectedImageModel(resolveImageModelId(value));
      return;
    }
    setSelectedVideoModel(resolveVideoModelId(value));
  }

  function onModeSelect(value: ModelMode) {
    setModelMode(value);
  }

  useEffect(() => {
    void loadChats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const storedMode = window.localStorage.getItem("chat:model-mode");
    if (storedMode === "chat" || storedMode === "image" || storedMode === "video") {
      setModelMode(storedMode);
    }

    const stored = window.localStorage.getItem("chat:model-id");
    if (stored) {
      setSelectedChatModel(resolveModelId(stored));
    }

    const storedImage = window.localStorage.getItem("chat:image-model-id");
    if (storedImage) {
      setSelectedImageModel(resolveImageModelId(storedImage));
    }

    const storedVideo = window.localStorage.getItem("chat:video-model-id");
    if (storedVideo) {
      setSelectedVideoModel(resolveVideoModelId(storedVideo));
    }

    setHasLoadedModelPrefs(true);
  }, []);

  useEffect(() => {
    if (!hasLoadedModelPrefs) return;
    window.localStorage.setItem("chat:model-id", selectedChatModel);
  }, [hasLoadedModelPrefs, selectedChatModel]);

  useEffect(() => {
    if (!hasLoadedModelPrefs) return;
    window.localStorage.setItem("chat:image-model-id", selectedImageModel);
  }, [hasLoadedModelPrefs, selectedImageModel]);

  useEffect(() => {
    if (!hasLoadedModelPrefs) return;
    window.localStorage.setItem("chat:video-model-id", selectedVideoModel);
  }, [hasLoadedModelPrefs, selectedVideoModel]);

  useEffect(() => {
    if (!hasLoadedModelPrefs) return;
    window.localStorage.setItem("chat:model-mode", modelMode);
  }, [hasLoadedModelPrefs, modelMode]);

  useEffect(() => {
    if (!activeChatId) {
      setMessages([]);
      setImageByMessageId({});
      setVideoByMessageId({});
      clearAttachments();
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

  useEffect(() => {
    if (!pendingDeleteChat) return;

    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape" && !isDeletingChat) {
        setPendingDeleteChat(null);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingDeleteChat, isDeletingChat]);

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
                            onClick={() => requestDeleteConversation(chat)}
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
                  {isPending
                    ? modelMode === "image"
                      ? "正在生成图片..."
                      : modelMode === "video"
                        ? "正在生成视频..."
                      : "助手正在思考..."
                    : modelMode === "image"
                      ? "当前为文生图模式，输入描述后生成图片。"
                      : modelMode === "video"
                        ? "当前为视频生成模式，输入描述后生成视频。"
                        : "你可以持续多轮对话，消息会自动持久化。"}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={isPending ? "warning" : "success"}>
                  {isPending ? "生成中" : "就绪"}
                </Badge>
                <Badge variant="outline">
                  {modelMode === "chat" ? "聊天模型" : modelMode === "image" ? "图像模型" : "视频模型"}
                </Badge>
                <Badge className="max-w-[220px] truncate" variant="outline">
                  {selectedModel}
                </Badge>
              </div>
            </div>
            <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_160px_240px] md:items-center">
              <p className="text-xs text-muted-foreground">
                当前模型：{selectedModelInfo?.label ?? selectedModel}
                {selectedModelInfo?.description ? ` · ${selectedModelInfo.description}` : ""}
              </p>
              <Select disabled={isPending} onValueChange={(value) => onModeSelect(value as ModelMode)} value={modelMode}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="chat">聊天模式</SelectItem>
                  <SelectItem value="image">文生图模式</SelectItem>
                  <SelectItem value="video">视频生成模式</SelectItem>
                </SelectContent>
              </Select>
              <Select disabled={isPending} onValueChange={onModelSelect} value={selectedModel}>
                <SelectTrigger className="min-h-11">
                  <SelectValue className="line-clamp-2 whitespace-normal text-[13px]" />
                </SelectTrigger>
                <SelectContent>
                  {(
                    modelMode === "chat"
                      ? OPENROUTER_MODELS
                      : modelMode === "image"
                        ? OPENROUTER_IMAGE_MODELS
                        : OPENROUTER_VIDEO_MODELS
                  ).map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap gap-2">
              {(modelMode === "chat"
                ? quickPrompts
                : modelMode === "image"
                  ? imagePrompts
                  : videoPrompts
              ).map((prompt) => (
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
                  const fileParts = getFileParts(message);
                  const imageUrl = imageByMessageId[message.id];
                  const videoUrl = videoByMessageId[message.id];
                  const toolParts = message.parts.filter(isToolPart);
                  const isLastAssistantStreaming =
                    status === "streaming" && index === messages.length - 1 && message.role === "assistant";

                  return (
                    <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")} key={message.id}>
                      <article
                        className={cn(
                          "max-w-[92%] rounded-2xl border px-4 py-3 text-sm md:max-w-[80%]",
                          isUser ? "chat-user-bubble" : "border-border bg-card text-card-foreground",
                        )}
                      >
                        <header className="mb-2 flex items-center justify-between gap-2">
                          <span className="text-[11px] tracking-wide opacity-80">
                            {getMessageRoleLabel(message.role)}
                          </span>
                          {isLastAssistantStreaming ? (
                            <span className="inline-flex items-center text-[11px] opacity-80">
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                              streaming
                            </span>
                          ) : null}
                        </header>

                        {text ? <p className="whitespace-pre-wrap leading-relaxed">{text}</p> : null}
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
                              {attachingImageKey === `${message.id}-generated` ? "加入中..." : "继续编辑这张图"}
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
                                    : "继续编辑这张图"}
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
                      检查 `.env` 中 `OPENROUTER_API_KEY` 是否已填写，并重启 `npm run dev`。
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
                onPaste={onTextareaPaste}
                placeholder={
                  modelMode === "image"
                    ? "描述你想生成的图片，或粘贴参考图...（Enter 发送，Shift+Enter 换行）"
                    : modelMode === "video"
                      ? "描述你想生成的视频，或粘贴参考图...（Enter 发送，Shift+Enter 换行）"
                      : "输入你的问题，或粘贴图片让模型识别...（Enter 发送，Shift+Enter 换行）"
                }
                ref={textareaRef}
                rows={1}
                value={input}
              />
              <div className="flex flex-wrap items-center gap-2">
                <input
                  accept="image/*"
                  className="block max-w-full text-xs text-muted-foreground file:mr-2 file:rounded-md file:border-0 file:bg-primary/10 file:px-2.5 file:py-1.5 file:text-xs file:font-medium file:text-primary hover:file:bg-primary/20"
                  multiple
                  onChange={onAttachmentInputChange}
                  ref={fileInputRef}
                  type="file"
                />
                {attachments.length > 0 ? (
                  <Button onClick={clearAttachments} size="sm" type="button" variant="ghost">
                    清空附件（{attachments.length}）
                  </Button>
                ) : null}
                <span className="text-[11px] text-muted-foreground">支持 Ctrl/Cmd+V 直接粘贴图片</span>
                {attachmentNames.length > 0 ? (
                  <span className="truncate text-[11px] text-muted-foreground">
                    {attachmentNames.join("，")}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  {modelMode === "image"
                    ? `当前模式：文生图 · 选中模型：${selectedImageModel}`
                    : modelMode === "video"
                      ? `当前模式：视频生成 · 选中模型：${selectedVideoModel}`
                      : !chatModelSupportsImageInput(selectedChatModel)
                        ? `当前聊天模型仅支持纯文本：${selectedChatModel}`
                      : attachments.length > 0
                        ? `已选择 ${attachments.length} 个图片附件 · 会话将自动保存`
                        : `当前会话：${activeChat?.title ?? "未创建"} · 消息将自动保存`}
                </p>
                <Button
                  disabled={
                    isPending ||
                    (!input.trim() && attachments.length === 0)
                  }
                  type="submit"
                >
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

      {pendingDeleteChat ? (
        <div
          aria-hidden={isDeletingChat}
          className="dialog-overlay-enter fixed inset-0 z-[70] flex items-center justify-center bg-black/45 px-4 backdrop-blur-[2px]"
          onClick={closeDeleteDialog}
        >
          <div
            aria-modal="true"
            className="dialog-panel-enter w-full max-w-md rounded-xl border border-border/80 bg-card p-5 shadow-2xl shadow-black/40"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="mb-4 flex items-start gap-3">
              <div className="mt-0.5 rounded-full border border-red-500/35 bg-red-500/12 p-1.5 text-red-500 dark:text-red-300">
                <Trash2 className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-foreground">确认删除会话</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  删除后将无法恢复。将移除会话及其全部消息记录。
                </p>
                <p className="mt-2 truncate rounded-md border border-border/80 bg-muted/40 px-2 py-1 text-xs text-foreground/85">
                  {pendingDeleteChat.title}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2">
              <Button disabled={isDeletingChat} onClick={closeDeleteDialog} size="sm" type="button" variant="ghost">
                取消
              </Button>
              <Button
                disabled={isDeletingChat}
                onClick={() => void confirmDeleteConversation()}
                size="sm"
                type="button"
                variant="destructive"
              >
                {isDeletingChat ? (
                  <>
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    删除中...
                  </>
                ) : (
                  "确认删除"
                )}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
