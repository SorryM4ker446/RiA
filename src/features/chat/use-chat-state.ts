import {
  chatModelSupportsImageInput,
  OPENROUTER_IMAGE_MODELS,
  OPENROUTER_MODELS,
  OPENROUTER_VIDEO_MODELS
} from "@/config/model";
import {
  ChatSummary,
  isToolPart,
  mapStoredMessagesToUI,
  ModelMode,
  readText,
  UploadableFilePart
} from "@/features/chat/page-utils";
import { encodePersistedAssistantToolMessage } from "@/lib/ai/ui-message";
import { getApiErrorMessage as readApiErrorMessage } from "@/lib/api-error-message";
import { useChat } from "@ai-sdk/react";
import { lastAssistantMessageIsCompleteWithApprovalResponses, UIMessage } from "ai";
import { ClipboardEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { chatApi, createChatTransport, filesToUploadParts } from "@/features/chat/api-client";
import { buildDefaultManualFieldValues, normalizeManualToolInput, validateManualToolFields } from "@/features/chat/tool-input";
import type { DeleteTarget } from "@/features/chat/types";

import { persistConversationMessage } from "@/features/chat/api-client";
import { useChatPreferences } from "@/features/chat/use-chat-preferences";
import { useConversations } from "@/features/chat/use-conversations";
import { useMediaGeneration } from "@/features/chat/use-media-generation";
import { useTasks } from "@/features/chat/use-tasks";
import { useTools } from "@/features/chat/use-tools";
export function useChatState() {
  const [input, setInput] = useState("");
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyState, setHistoryState] = useState<{ chatId: string; status: "loading" | "ready" | "error" } | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingMessageText, setEditingMessageText] = useState("");
  const [isDesktopRuntime, setIsDesktopRuntime] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const latestHistoryRequestRef = useRef(0);
  const [olderMessagesCursor, setOlderMessagesCursor] = useState<string | null>(null);
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const olderRequestRef = useRef(false);
  const {
    modelMode, setModelMode, selectedChatModel, selectedImageModel, selectedVideoModel, selectedManualTool,
    setSelectedManualTool, manualToolsOnly, setManualToolsOnly, applyChatPreferences, onModelSelect,
    isLoadingPreferences, preferencesError,
  } = useChatPreferences(activeChatId);
  const {
    chats, activeChat, isCreatingChat, editingChatId, editingTitle, setEditingTitle, isChatListExpanded,
    setIsChatListExpanded, visibleChats, hasHiddenChats, loadChats, createNewChat, startEditingChat,
    cancelEditingChat, saveEditedTitle, performDeleteChat, ensureActiveChatId,
    nextChatsCursor, isLoadingMoreChats, loadMoreChats,
  } = useConversations({ activeChatId, setActiveChatId, preferences: { modelMode, selectedChatModel, selectedImageModel, selectedVideoModel, selectedManualTool, manualToolsOnly }, applyChatPreferences, resetConversation, persistCurrentStreamingAssistantIfNeeded, setPageError });
  const transport = useMemo(() => createChatTransport(activeChatId, { selectedChatModel, manualToolsOnly, modelMode }), [activeChatId, selectedChatModel, manualToolsOnly, modelMode]);
  const { messages, setMessages, sendMessage, regenerate, addToolApprovalResponse, status, error, clearError } = useChat({
    id: activeChatId ?? "draft",
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });
  type PendingSend = {
    chatId: string;
    message: Parameters<typeof sendMessage>[0];
    options: Parameters<typeof sendMessage>[1];
    resolve: () => void;
    reject: (error: Error) => void;
  };
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null);
  const claimedSendRef = useRef<PendingSend | null>(null);
  const {
    tasks, taskStatusFilter, isLoadingTasks, taskPanelError, isTaskListExpanded, filteredTasks,
    visibleTasks, hasHiddenTasks, setTaskStatusFilter, setIsTaskListExpanded, loadTasks,
    updateTaskStatus, deleteTask, saveTaskSchedule, updatingTaskIds,
  } = useTasks();
  const {
    isGeneratingImage, isGeneratingVideo, isUploadingAttachments, setIsUploadingAttachments,
    imageByMessageId, setImageByMessageId, videoByMessageId, setVideoByMessageId, attachments,
    attachingImageKey, fileInputRef, attachmentNames, reuseImageActionLabel, clearAttachments,
    appendAttachments, onReuseImageForEditing, onAttachmentInputChange, generateImage, generateVideo,
  } = useMediaGeneration({ messages, setMessages, ensureActiveChatId, loadChats, setPageError, modelMode, selectedImageModel, selectedVideoModel, textareaRef });
  const {
    toolCatalogError, manualToolFieldValues, setManualToolFieldValues, manualToolFieldErrors,
    setManualToolFieldErrors, isRunningManualTool, manualTools, selectedManualToolConfig,
    manualToolSelectValue, isManualToolSelected, runManualTool,
  } = useTools({ setMessages, ensureActiveChatId, loadChats, selectedChatModel, modelMode, selectedManualTool, setSelectedManualTool, loadTasks, taskStatusFilter });
  const isPending =
    isLoadingPreferences ||
    pendingSend !== null ||
    status === "submitted" ||
    status === "streaming" ||
    isGeneratingImage ||
    isGeneratingVideo ||
    isUploadingAttachments ||
    isLoadingOlderMessages ||
    isRunningManualTool;
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
  const effectiveError = pageError ?? preferencesError ?? (error ? readApiErrorMessage(error.message, "聊天请求失败，请稍后重试。") : null);
  const keyError =
    effectiveError?.includes("OPENROUTER_API_KEY") ||
    effectiveError?.includes("Invalid API key") ||
    effectiveError?.includes("No auth credentials found");
  function resetConversation() {
    latestHistoryRequestRef.current += 1;
    olderRequestRef.current = false;
    setOlderMessagesCursor(null);
    setIsLoadingOlderMessages(false);
    setIsLoadingHistory(false);
    setHistoryState(null);
    setMessages([]);
    setImageByMessageId({});
    setVideoByMessageId({});
    clearAttachments();
  }
  async function loadMessages(chatId: string) {
    const requestId = latestHistoryRequestRef.current + 1;
    latestHistoryRequestRef.current = requestId;
    setIsLoadingHistory(true);
    setHistoryState({ chatId, status: "loading" });
    olderRequestRef.current = false;
    setOlderMessagesCursor(null);
    setIsLoadingOlderMessages(false);
    setPageError(null);
    try {
      const payload = await chatApi.listMessages(chatId);
      if (latestHistoryRequestRef.current !== requestId) {
        return;
      }
      const mapped = mapStoredMessagesToUI(payload.data ?? []);
      setMessages(mapped.uiMessages);
      setImageByMessageId(mapped.imageMap);
      setVideoByMessageId(mapped.videoMap);
      setOlderMessagesCursor(payload.pageInfo?.nextCursor ?? null);
      setHistoryState({ chatId, status: "ready" });
    } catch (loadError) {
      if (latestHistoryRequestRef.current === requestId) {
        setHistoryState({ chatId, status: "error" });
        setPageError(loadError instanceof Error ? loadError.message : "读取历史消息失败");
      }
    } finally {
      if (latestHistoryRequestRef.current === requestId) {
        setIsLoadingHistory(false);
      }
    }
  }

  async function loadOlderMessages() {
    if (!activeChatId || !olderMessagesCursor || olderRequestRef.current || isPending || isLoadingHistory) return;
    const requestId = latestHistoryRequestRef.current;
    olderRequestRef.current = true;
    setIsLoadingOlderMessages(true);
    try {
      const page = await chatApi.listMessages(activeChatId, olderMessagesCursor);
      if (requestId !== latestHistoryRequestRef.current) return;
      const mapped = mapStoredMessagesToUI(page.data);
      setMessages((current) => [...mapped.uiMessages.filter((message) => !current.some((item) => item.id === message.id)), ...current]);
      setImageByMessageId((current) => ({ ...mapped.imageMap, ...current }));
      setVideoByMessageId((current) => ({ ...mapped.videoMap, ...current }));
      setOlderMessagesCursor(page.pageInfo?.nextCursor ?? null);
    } catch (error) {
      if (requestId === latestHistoryRequestRef.current) setPageError(error instanceof Error ? error.message : "读取更早消息失败");
    } finally {
      if (requestId === latestHistoryRequestRef.current) {
        olderRequestRef.current = false;
        setIsLoadingOlderMessages(false);
      }
    }
  }

  function requestDeleteConversation(chat: ChatSummary) {
    setPendingDelete({ kind: "chat", chat });
  }

  function requestDeleteMessage(message: UIMessage) {
    setPendingDelete({ kind: "message", message });
  }

  function closeDeleteDialog() {
    if (isDeleting) return;
    setPendingDelete(null);
  }

  async function confirmDelete() {
    if (!pendingDelete) return;

    setPageError(null);
    setIsDeleting(true);
    try {
      if (pendingDelete.kind === "chat") {
        await performDeleteChat(pendingDelete.chat.id);
      } else {
        await performDeleteMessage(pendingDelete.message.id);
      }
    } catch (deleteError) {
      setPageError(deleteError instanceof Error ? deleteError.message : "删除失败");
    } finally {
      setIsDeleting(false);
      setPendingDelete(null);
    }
  }

  async function performDeleteMessage(messageId: string) {
    if (!activeChatId) return;

    const previous = messages;
    setMessages((current) => current.filter((message) => message.id !== messageId));

    try {
      await chatApi.deleteMessage(activeChatId, messageId);
      await loadChats();
    } catch (deleteError) {
      setMessages(previous);
      throw deleteError;
    }
  }

  function onTextareaPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (isManualToolSelected) return;

    const pastedFiles = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    if (pastedFiles.length === 0) return;
    event.preventDefault();
    appendAttachments(pastedFiles);
  }

  async function persistCurrentStreamingAssistantIfNeeded(chatId: string | null): Promise<void> {
    if (!chatId) return;
    if (status !== "streaming" && status !== "submitted") return;

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") return;

    const text = readText(lastMessage).trim();
    const toolParts = lastMessage.parts.filter(isToolPart);
    const fallbackText = "（响应中断，已保存当前输出）";
    const content =
      toolParts.length > 0
        ? encodePersistedAssistantToolMessage({
          type: "assistant-tool-message",
          text: text || fallbackText,
          tools: toolParts.map((toolPart) => ({
            toolName: toolPart.type.replace(/^tool-/, ""),
            toolCallId: toolPart.toolCallId,
            state: toolPart.state,
            ...(toolPart.input !== undefined ? { input: toolPart.input } : {}),
            ...(toolPart.output !== undefined ? { output: toolPart.output } : {}),
            ...(toolPart.errorText ? { errorText: toolPart.errorText } : {}),
            ...(toolPart.approval ? { approval: toolPart.approval } : {}),
          })),
        })
        : text;

    if (!content.trim()) return;

    try {
      await persistConversationMessage({
        chatId,
        role: "assistant",
        content,
        clientMessageId: lastMessage.id,
        status: "error",
      });
      await loadChats();
    } catch {
      // Best effort persistence; do not block chat switch.
    }
  }

  async function switchActiveChat(nextChatId: string) {
    if (nextChatId === activeChatId) return;
    await persistCurrentStreamingAssistantIfNeeded(activeChatId);
    setActiveChatId(nextChatId);
  }

  function startEditingMessage(message: UIMessage) {
    setEditingMessageId(message.id);
    setEditingMessageText(readText(message));
  }

  function cancelEditingMessage() {
    setEditingMessageId(null);
    setEditingMessageText("");
  }

  async function saveEditedMessage(message: UIMessage) {
    if (isPending) return;
    const nextText = editingMessageText.trim();
    if (!nextText || !activeChatId) return;

    const previous = messages;
    setEditingMessageId(null);
    setEditingMessageText("");
    setMessages((current) =>
      current.map((item) =>
        item.id === message.id ? { ...item, parts: [{ type: "text", text: nextText }] } : item,
      ),
    );

    try {
      await chatApi.editMessage(activeChatId, message.id, nextText);
    } catch (editError) {
      setMessages(previous);
      setPageError(editError instanceof Error ? editError.message : "保存修改失败");
      return;
    }
    await regenerateMessage(message.id);
  }

  async function regenerateMessage(messageId: string) {
    if (isPending) return;
    setPageError(null);
    try {
      await regenerate({ messageId });
      await loadChats();
    } catch (regenerateError) {
      setPageError(regenerateError instanceof Error ? regenerateError.message : "重新生成失败");
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending) return;
    const content = input.trim();
    const hasAttachments = attachments.length > 0;
    const hasContent = content.length > 0;

    if (!hasContent && !hasAttachments) return;
    if (modelMode === "video" && attachments.length > 1) { setPageError("视频生成最多使用 1 个参考图。"); return; }

    setPageError(null);

    if (modelMode === "chat" && selectedManualToolConfig && hasAttachments) {
      setPageError("手动工具调用暂不支持附件，请先清空附件。");
      return;
    }

    if (modelMode === "chat" && hasAttachments && !chatModelSupportsImageInput(selectedChatModel)) {
      setPageError(`当前聊天模型 ${selectedChatModel} 不支持图片输入，请切换视觉模型或移除附件。`);
      return;
    }

    if (hasContent) setInput("");

    let uploadParts: UploadableFilePart[] = [];
    if (hasAttachments) {
      setIsUploadingAttachments(true);
      try {
        uploadParts = await filesToUploadParts(attachments);
      } catch (error) {
        setPageError(error instanceof Error ? error.message : "附件读取失败");
        return;
      } finally {
        setIsUploadingAttachments(false);
      }
    }

    if (modelMode === "chat" && selectedManualToolConfig) {
      try {
        if (!hasContent) {
          throw new Error("请在输入框中填写工具参数。");
        }

        const nextFieldErrors = validateManualToolFields(selectedManualToolConfig, manualToolFieldValues);
        setManualToolFieldErrors(nextFieldErrors);
        if (Object.keys(nextFieldErrors).length > 0) {
          return;
        }
        const normalizedInput = normalizeManualToolInput({
          tool: selectedManualToolConfig,
          text: content,
          fieldValues: manualToolFieldValues,
        });

        await runManualTool({
          tool: selectedManualToolConfig.id,
          input: normalizedInput,
          userVisibleText: content,
        });

        setManualToolFieldValues(buildDefaultManualFieldValues(selectedManualToolConfig));
        setManualToolFieldErrors({});
      } catch (submitError) {
        setPageError(submitError instanceof Error ? submitError.message : "工具执行失败");
      }

      return;
    }

    if (modelMode === "image") {
      await generateImage(content, uploadParts);
      return;
    }

    if (modelMode === "video") {
      await generateVideo(content, uploadParts);
      return;
    }

    try {
      const chatId = await ensureActiveChatId(content || "聊天消息");
      // Activating a new conversation replaces the SDK Chat instance. Send only
      // after that instance and its initial history are ready, not through draft's closure.
      await new Promise<void>((resolve, reject) => setPendingSend({
        chatId,
        message: hasAttachments ? { ...(hasContent ? { text: content } : {}), files: uploadParts } : { text: content },
        options: { body: { chatId, modelId: selectedChatModel, manualToolsOnly, mode: "chat" } },
        resolve, reject,
      }));

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

  useEffect(() => {
    if (!pendingSend || claimedSendRef.current === pendingSend) return;
    if (activeChatId !== pendingSend.chatId || (historyState?.chatId === pendingSend.chatId && historyState.status === "error")) {
      claimedSendRef.current = pendingSend;
      setPendingSend(null);
      pendingSend.reject(new Error("会话已切换或历史加载失败，请重新加载会话后再发送。"));
      return;
    }
    if (historyState?.chatId !== pendingSend.chatId || historyState.status !== "ready" || isLoadingHistory) return;
    claimedSendRef.current = pendingSend;
    setPendingSend(null);
    void sendMessage(pendingSend.message, pendingSend.options).then(pendingSend.resolve, pendingSend.reject);
  }, [activeChatId, historyState, isLoadingHistory, pendingSend, sendMessage]);

  function appendQuickPrompt(prompt: string) {
    setInput((prev) => {
      if (!prev.trim()) return prompt;
      if (prev.endsWith("\n")) return `${prev}${prompt}`;
      return `${prev}\n${prompt}`;
    });
    textareaRef.current?.focus();
  }

  function onModeSelect(value: ModelMode) {
    setModelMode(value);
    if (value !== "chat") {
      setSelectedManualTool("none");
      setManualToolFieldValues({});
      setManualToolFieldErrors({});
    }
  }
  useEffect(() => {
    if (!activeChatId) {
      resetConversation();
      return;
    }
    void loadMessages(activeChatId);
    return () => { latestHistoryRequestRef.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId]);
  useEffect(() => {
    if (status === "ready") {
      void loadChats();
      void loadTasks();
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
    setIsDesktopRuntime(Boolean(window.privateAiDesktop));
  }, []);
  useEffect(() => {
    if (!pendingDelete) return;

    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape" && !isDeleting) {
        setPendingDelete(null);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingDelete, isDeleting]);
  return {
    nextChatsCursor, isLoadingMoreChats, loadMoreChats, olderMessagesCursor, isLoadingOlderMessages, loadOlderMessages,
    isCreatingChat, createNewChat, chats, visibleChats, activeChatId, editingChatId, setEditingTitle,
    editingTitle, saveEditedTitle, cancelEditingChat, switchActiveChat, startEditingChat,
    requestDeleteConversation, hasHiddenChats, setIsChatListExpanded, isChatListExpanded, filteredTasks,
    isLoadingTasks, loadTasks, setTaskStatusFilter, taskStatusFilter, taskPanelError, tasks,
    visibleTasks, updateTaskStatus, deleteTask, saveTaskSchedule, updatingTaskIds, hasHiddenTasks, setIsTaskListExpanded,
    isTaskListExpanded, activeChat, isPending, modelMode, selectedModel, selectedModelInfo, onModeSelect,
    onModelSelect, appendQuickPrompt, isLoadingHistory, messages, imageByMessageId, videoByMessageId,
    status, editingMessageId, startEditingMessage, regenerateMessage, requestDeleteMessage,
    setEditingMessageText, editingMessageText, saveEditedMessage, cancelEditingMessage,
    attachingImageKey, onReuseImageForEditing, reuseImageActionLabel, addToolApprovalResponse, onSubmit,
    setSelectedManualTool, manualToolSelectValue, manualTools, manualToolsOnly, setManualToolsOnly,
    selectedManualToolConfig, manualToolFieldValues, setManualToolFieldValues, manualToolFieldErrors,
    setManualToolFieldErrors, toolCatalogError, setInput, handleTextareaKeyDown, onTextareaPaste,
    textareaRef, input, isManualToolSelected, onAttachmentInputChange, fileInputRef, attachments,
    clearAttachments, attachmentNames, selectedImageModel, selectedVideoModel, selectedManualTool,
    selectedChatModel, pendingDelete, isDeleting, closeDeleteDialog, confirmDelete, isDesktopRuntime,
    effectiveError, keyError, setPageError, clearError,
  };
}
export type ChatState = ReturnType<typeof useChatState>;
