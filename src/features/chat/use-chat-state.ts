import { t } from "@/lib/locale";
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
import { usePanelVisibility } from "./use-panel-visibility";
import { useChat } from "@ai-sdk/react";
import { lastAssistantMessageIsCompleteWithApprovalResponses, UIMessage } from "ai";
import { ClipboardEvent, DragEvent, FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chatApi, createChatTransport, isNotFoundError } from "@/features/chat/api-client";
import { clearChatDraft, readChatDraft, writeChatDraft } from "@/features/chat/draft";
import { normalizeManualToolInput, validateManualToolFields } from "@/features/chat/tool-input";
import type { DeleteTarget } from "@/features/chat/types";
import type { ModelLibraryItem } from "@/lib/models/preferences-schema";
import type { InputNotice } from "@/features/chat/composer-notice";

import { persistConversationMessage } from "@/features/chat/api-client";
import { useChatPreferences } from "@/features/chat/use-chat-preferences";
import { useConversations } from "@/features/chat/use-conversations";
import { useMediaGeneration } from "@/features/chat/use-media-generation";
import { useTasks } from "@/features/chat/use-tasks";
import { useTools } from "@/features/chat/use-tools";
import { animateRemoval } from "@/lib/ui/removal";
export function useChatState() {
  const [input, setInput] = useState("");
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const activeChatIdRef = useRef(activeChatId);
  activeChatIdRef.current = activeChatId;
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyState, setHistoryState] = useState<{ chatId: string; status: "loading" | "ready" | "error" } | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingMessageText, setEditingMessageText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const latestHistoryRequestRef = useRef(0);
  const [olderMessagesCursor, setOlderMessagesCursor] = useState<string | null>(null);
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const olderRequestRef = useRef(false);
  const {
    modelMode, setModelMode, selectedChatModel: preferredChatModel, selectedImageModel, selectedVideoModel,
    applyChatPreferences, onModelSelect: selectPreferredModel,
    isLoadingPreferences, preferencesError, modelLibrary, clearPreferencesError,
  } = useChatPreferences(activeChatId);
  // A send with no model chosen is not an error: nothing was requested. It
  // turns the model hint on, and choosing a model or another mode turns it off.
  const [sentWithoutModel, setSentWithoutModel] = useState(false);
  // Why the last send did not leave the composer, when nothing was requested:
  // kept as a message key so it follows a language switch.
  const [inputNotice, setInputNotice] = useState<InputNotice | null>(null);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  function onModelSelect(value: string) {
    setSentWithoutModel(false);
    setInputNotice(null);
    selectPreferredModel(value);
  }
  const {
    chats, activeChat, isLoadingChats, isCreatingChat, editingChatId, editingTitle, setEditingTitle, isChatListExpanded,
    setIsChatListExpanded, visibleChats, hasHiddenChats, loadChats, createNewChat, startEditingChat,
    cancelEditingChat, saveEditedTitle, performDeleteChat, ensureActiveChatId,
    nextChatsCursor, isLoadingMoreChats, loadMoreChats, toggleEphemeral, isEphemeralSaving,
    documentTopics, loadDocumentTopics, setDocumentScope, isDocumentScopeSaving, assistants, assistantsError, loadAssistants, applyAssistant,
    setWorkspace, isWorkspaceSaving, restoringChatId, isRestoringChat,
  } = useConversations({ activeChatId, setActiveChatId, preferences: { modelMode, selectedChatModel: preferredChatModel, selectedImageModel, selectedVideoModel }, applyChatPreferences, resetConversation, persistCurrentStreamingAssistantIfNeeded, setPageError });
  // A remembered conversation the list has not confirmed yet is not one to send to,
  // and a send waits for a workspace switch so the turn uses the folder the picker shows.
  const isConversationReady = !isLoadingPreferences && restoringChatId === null && !isWorkspaceSaving && (activeChatId !== null || !isLoadingChats);
  // The open conversation once it is known to exist: what history-bound panels may show.
  const confirmedChatId = restoringChatId === null ? activeChatId : null;
  const selectedChatModel = activeChat?.assistantConfig?.model ?? preferredChatModel;
  const transport = useMemo(() => createChatTransport(activeChatId, { selectedChatModel, modelMode }), [activeChatId, selectedChatModel, modelMode]);
  const { messages, setMessages, sendMessage, regenerate, addToolApprovalResponse, status, error, clearError, stop } = useChat({
    id: activeChatId ?? "draft",
    transport,
    // A fast model sends far more deltas than a screen can show. Rendering at
    // most every 50ms keeps a long transcript from falling behind the stream;
    // the trailing update still delivers the final text.
    experimental_throttle: 50,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: ({ messages: finishedMessages, isError }) => {
      if (!isError) return;
      const latestUser = [...finishedMessages].reverse().find(message => message.role === "user");
      const pending = latestUser ? inFlightSendsRef.current.get(latestUser.id) : undefined;
      if (pending) pending.failed = true;
    },
  });
  type PendingSend = {
    chatId: string;
    message: Parameters<typeof sendMessage>[0];
    options: Parameters<typeof sendMessage>[1];
    failed?: boolean;
    resolve: (failed: boolean) => void;
    reject: (error: Error) => void;
  };
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null);
  const claimedSendRef = useRef<PendingSend | null>(null);
  const inFlightSendsRef = useRef(new Map<string, PendingSend>());
  const {
    taskStatusFilter, isLoadingTasks, taskPanelError, isTaskListExpanded, filteredTasks,
    visibleTasks, hasHiddenTasks, setTaskStatusFilter, setIsTaskListExpanded, loadTasks,
    updateTaskStatus, deleteTask, saveTaskSchedule, updatingTaskIds,
  } = useTasks();
  const {
    isGeneratingImage, isGeneratingVideo, isUploadingAttachments,
    imageByMessageId, setImageByMessageId, videoByMessageId, setVideoByMessageId, attachments,
    attachingImageKey, fileInputRef, attachmentNames, reuseImageActionLabel, clearAttachments, removeAttachmentAt, replaceAttachments,
    appendAttachments, onReuseImageForEditing, onAttachmentInputChange, generateImage, generateVideo,
  } = useMediaGeneration({ activeChatId, isConversationReady, isHistoryReady: historyState?.chatId === activeChatId && historyState.status === "ready", setMessages, reloadMessages: loadMessages, ensureActiveChatId, loadChats, setPageError, modelMode, selectedImageModel, selectedVideoModel, textareaRef });
  const {
    toolCatalogError, unavailableTools, manualToolFieldValues, setManualToolFieldValues, manualToolFieldErrors,
    setManualToolFieldErrors, isRunningManualTool, manualTools, selectedManualToolConfig,
    selectedManualTool, setSelectedManualTool, selectedToolDocument, setSelectedToolDocument,
    manualToolSelectValue, isManualToolSelected, runManualTool, loadToolCatalog,
  } = useTools({ activeChatId, allowedToolIds: activeChat?.assistantConfig?.tools, setMessages, ensureActiveChatId, loadChats, selectedChatModel, modelMode, loadTasks, taskStatusFilter });
  // Work in flight that the "generating" status and the stop control stand for.
  // Reading the saved preferences is not part of it: it blocks sending like the
  // rest, but showing it as a running turn flashed both every time chat opened.
  const isWorking =
    pendingSend !== null ||
    status === "submitted" ||
    status === "streaming" ||
    isGeneratingImage ||
    isGeneratingVideo ||
    isUploadingAttachments ||
    isLoadingOlderMessages ||
    isRunningManualTool;
  const isPending = isLoadingPreferences || isWorking;
  // Until the list says which conversation to restore, and that conversation's
  // history has been asked for, the transcript has nothing true to show. Showing
  // the empty-conversation welcome then is what made chat open on the welcome,
  // swap to the placeholder and then to the messages each time it was returned to.
  const isOpeningConversation = restoringChatId !== null || (activeChatId ? historyState?.chatId !== activeChatId : isLoadingChats);
  const selectedModel =
    modelMode === "chat"
      ? selectedChatModel
      : modelMode === "image"
        ? selectedImageModel
        : selectedVideoModel;
  const selectedModelInfo: ModelLibraryItem | undefined = selectedModel
    ? modelLibrary.find(model => model.providerId === selectedModel.providerId && model.modelId === selectedModel.modelId && model.modes.includes(modelMode))
    : undefined;
  // What the composer needs before it can send: a model added for this mode, or
  // one chosen after a send was attempted without. Nothing while loading.
  const modelHint: "add" | "choose" | null = isLoadingPreferences || selectedModel ? null
    : !modelLibrary.some(model => model.modes.includes(modelMode)) ? "add" : sentWithoutModel ? "choose" : null;
  const { visibility: panelVisibility, toggle: togglePanel } = usePanelVisibility();

  const effectiveError = pageError ?? preferencesError ?? (error ? readApiErrorMessage(error.message, t("chatState.requestFailed")) : null);

  // A draft belongs to one conversation. Switching away parks it and switching
  // back brings it back, so a half-written question survives navigating around.
  const draftChatIdRef = useRef<string | null>(null);
  const pendingSendDraftRef = useRef<{ chatId: string; messageId: string; text: string; pendingChat?: boolean; afterIndex: number } | null>(null);
  const draftAttachmentsRef = useRef<UploadableFilePart[]>(attachments);
  draftAttachmentsRef.current = attachments;

  useEffect(() => {
    // Parking first: the current conversation keeps what was typed in it.
    const previousId = draftChatIdRef.current;
    if (previousId && previousId !== activeChatId) {
      const pending = pendingSendDraftRef.current;
      writeChatDraft(previousId, { text: inputRef.current || (pending?.chatId === previousId ? pending.text : ""), attachments: draftAttachmentsRef.current });
    }
    // Only on a conversation change: re-running this on every keystroke would
    // overwrite the draft that is about to be read back.
    draftChatIdRef.current = activeChatId;
    // Sending the first message creates the conversation, which switches the
    // active id out from under the composer. Reading an empty draft at that
    // moment would wipe the message being sent, so an in-flight send keeps its
    // own text.
    const pending = pendingSendDraftRef.current;
    // A send that is still waiting for its conversation to be created must not
    // have its input replaced by the (empty) draft of the new id. Nor may the
    // conversation that send just created: the send already took it over and
    // saved its text as that conversation's draft so a failure can restore it,
    // and reading that draft back here put the sent message in the box again.
    if (pending?.pendingChat || (pending?.chatId === activeChatId && previousId === activeChatId)) return;
    // Only the initial activation is protected. A deliberate switch must always
    // park one conversation's draft and show the other's, even if the user is
    // mid-sentence in the first one.
    const typedBeforeActivation = previousId === null && inputRef.current.length > 0 && inputRef.current !== restoredInputRef.current;
    const draft = readChatDraft(activeChatId);
    // Text written before any conversation existed moves into the first one to
    // open that has no draft of its own, so it is neither lost nor left behind
    // to come back later.
    if (previousId === null && activeChatId !== null) {
      const unsaved = typedBeforeActivation ? { text: inputRef.current, attachments: draftAttachmentsRef.current } : draft ? null : readChatDraft(null);
      if (unsaved) {
        clearChatDraft(null);
        writeChatDraft(activeChatId, unsaved);
        if (typedBeforeActivation) return;
        restoredInputRef.current = unsaved.text;
        setInput(unsaved.text);
        replaceAttachments(unsaved.attachments);
        return;
      }
    }
    if (typedBeforeActivation) return;
    restoredInputRef.current = draft?.text ?? "";
    if (draft) {
      setInput(draft.text);
      replaceAttachments(draft.attachments);
    } else {
      setInput("");
      replaceAttachments([]);
    }
  }, [activeChatId, replaceAttachments]);

  // Kept in a ref so the effect above sees the current text without depending
  // on it, which would re-run on every keystroke.
  const inputRef = useRef(input);
  inputRef.current = input;
  // What the draft last put in the box. Text the user typed after that belongs
  // to them: the conversation list can activate a conversation a moment after
  // the page opens, and restoring an empty draft then would delete whatever was
  // typed in the meantime.
  const restoredInputRef = useRef<string | null>(null);

  useEffect(() => {
    writeChatDraft(draftChatIdRef.current, { text: input, attachments });
  }, [input, attachments]);

  // The draft is cleared only once the turn actually produced an answer. A send
  // that fails, or that the user stops, has to leave the text where it can be
  // sent again — which is also why this is judged by the answer appearing
  // rather than by the request settling: a stopped request settles too.
  useEffect(() => {
    const pending = pendingSendDraftRef.current;
    // A send that is still waiting for its conversation covers whichever one is
    // on screen; otherwise it has to be this exact conversation.
    if (!pending || (!pending.pendingChat && pending.chatId !== activeChatId)) return;
    const answered = messages
      .slice(pending.afterIndex)
      .some((message) => message.role === "assistant" && message.parts.some((part) => part.type === "text" && part.text.trim().length > 0));
    if (!answered) return;
    clearChatDraft(pending.chatId);
    pendingSendDraftRef.current = null;
  }, [messages, activeChatId]);

  /**
   * Stopping abandons the request, not the question: the message was already
   * delivered and is in the conversation, so putting it back in the composer
   * would offer to send it twice. What the model managed to produce stays on
   * screen, stored as an interrupted answer.
   */
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);

  /**
   * Dropping a file on the composer attaches it the same way choosing it does.
   * The drag only counts when it actually carries files, so dragging selected
   * text does not light up the whole composer.
   */
  function onComposerDragOver(event: DragEvent<HTMLElement>) {
    if (isManualToolSelected) return;
    if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer!.dropEffect = "copy";
    setIsDraggingFiles(true);
  }

  function onComposerDragLeave(event: DragEvent<HTMLElement>) {
    // Only clear when the pointer actually left the composer; dragging across
    // its children fires leave events that would otherwise flicker the outline.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDraggingFiles(false);
  }

  function onComposerDrop(event: DragEvent<HTMLElement>) {
    if (isManualToolSelected) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    setIsDraggingFiles(false);
    if (!files.length) return;
    event.preventDefault();
    void appendAttachments(files);
  }

  const stopRef = useRef(stop);
  stopRef.current = stop;
  const onStop = useCallback(() => {
    if (!isPending) return;
    stopRef.current();
    clearChatDraft(activeChatId);
    pendingSendDraftRef.current = null;
  }, [isPending, activeChatId]);

  /**
   * Whether a pending send belongs to the conversation on screen. A send that
   * is still waiting for its conversation to be created covers it too: until
   * that finishes there is no id to match against, and treating it as foreign
   * would drop the text on the floor at exactly the moment it is most fragile.
   */
  function pendingCoversCurrentChat(pending: { chatId: string; pendingChat?: boolean } | null) {
    // Creating the first conversation changes its id while onSubmit is awaiting
    // history. Its older closure must still restore that conversation's draft.
    return pending !== null && (pending.pendingChat === true || pending.chatId === activeChatIdRef.current);
  }

  function restorePendingSendDraft(messageId: string) {
    const pending = pendingSendDraftRef.current;
    if (!pending || pending.messageId !== messageId || !pendingCoversCurrentChat(pending)) return;
    pendingSendDraftRef.current = null;
    setInput(pending.text);
  }

  /**
   * One failure, one message.
   *
   * An app-level fault — an expired local token, an unreachable database — makes
   * the tool catalog and the task list fail with the exact same message. Each
   * panel rendering its own copy made a single problem look like three, so a
   * panel stands down whenever it would only echo the banner above it. An
   * unrelated panel failure still surfaces on its own, because the comparison
   * is exact.
   */
  const withoutGlobalEcho = (message: string | null) =>
    message && message === effectiveError ? null : message;
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
    setInputNotice(null);
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
    setInputNotice(null);
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
        // A remembered conversation deleted since the last visit is not an error
        // to report: the list is about to replace it with another one.
        if (isNotFoundError(loadError) && isRestoringChat(chatId)) return;
        const reason = loadError instanceof Error ? loadError.message : t("chatApi.listMessagesFailed");
        setPageError(`${reason} ${t("chatState.historyRecovery")}`);
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
      if (requestId === latestHistoryRequestRef.current) setPageError(error instanceof Error ? error.message : t("chatState.loadOlderFailed"));
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
      setPageError(deleteError instanceof Error ? deleteError.message : t("chatState.deleteFailed"));
    } finally {
      setIsDeleting(false);
      setPendingDelete(null);
    }
  }

  async function performDeleteMessage(messageId: string) {
    if (!activeChatId) return;

    const previous = messages;
    await animateRemoval(messageId, () => setMessages((current) => current.filter((message) => message.id !== messageId)));

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
    const executionMetadata = lastMessage.metadata as { runId?: string; runIds?: string[]; modelLabel?: string } | undefined;
    const fallbackText = t("chatState.streamInterrupted");
    const content =
      toolParts.length > 0
        ? encodePersistedAssistantToolMessage({
          type: "assistant-tool-message",
          text: text || fallbackText,
          ...(executionMetadata?.runId ? { runId: executionMetadata.runId } : {}),
          ...(executionMetadata?.runIds ? { runIds: executionMetadata.runIds } : {}),
          ...(executionMetadata?.modelLabel ? { modelLabel: executionMetadata.modelLabel } : {}),
          tools: toolParts.map((toolPart) => ({
            toolName: toolPart.type.replace(/^tool-/, ""),
            ...(toolPart.title ? { title: toolPart.title } : {}),
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
    if (isPending || isDocumentScopeSaving) return;
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
      setPageError(editError instanceof Error ? editError.message : t("chatApi.saveEditFailed"));
      return;
    }
    await regenerateMessage(message.id);
  }

  async function regenerateMessage(messageId: string) {
    if (isPending || isDocumentScopeSaving) return;
    if (!activeChatId) return;
    setPageError(null);
    try {
      // The Chat instance keeps the transport it was constructed with, so the
      // current preferences must travel with the request itself.
      await regenerate({
        messageId,
        body: { chatId: activeChatId, ...(selectedChatModel ? { model: selectedChatModel } : {}), mode: modelMode },
      });
      await loadChats();
    } catch (regenerateError) {
      setPageError(regenerateError instanceof Error ? regenerateError.message : t("chatState.regenerateFailed"));
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending || isDocumentScopeSaving || !isConversationReady) return;
    setInputNotice(null);
    if (modelMode === "chat" && selectedManualToolConfig) {
      const isDocumentTool = ["readDocument", "convertDocument"].includes(selectedManualToolConfig.id);
      const content = isDocumentTool ? selectedToolDocument?.id ?? "" : input.trim();
      if (!content) { setInputNotice({ key: isDocumentTool ? "ui.chat.use-chat-state.chooseAKnowledgeDocumentFirst" : "chatState.toolParamsRequired" }); return; }
      if (attachments.length) { setInputNotice({ key: "chatState.manualToolAttachmentBlocked" }); return; }
      const nextFieldErrors = validateManualToolFields(selectedManualToolConfig, manualToolFieldValues);
      setManualToolFieldErrors(nextFieldErrors);
      if (Object.keys(nextFieldErrors).length > 0) return;
      setPageError(null);
      try {
        const result = await runManualTool({
          tool: selectedManualToolConfig.id,
          input: normalizeManualToolInput({ tool: selectedManualToolConfig, text: content, fieldValues: manualToolFieldValues }),
          userVisibleText: isDocumentTool ? `${selectedManualToolConfig.displayName}：${selectedToolDocument!.filename}` : content,
        });
        if (result.isCurrent && !isDocumentTool) setInput(current => current.trim() === content ? "" : current);
      } catch (submitError) {
        setPageError(submitError instanceof Error ? submitError.message : t("chatState.toolRunFailed"));
      }
      return;
    }
    const content = input.trim();
    const hasAttachments = attachments.length > 0;
    const hasContent = content.length > 0;

    if (!hasContent && !hasAttachments) return;
    if (!selectedModel) { setSentWithoutModel(true); return; }
    if (modelMode === "video" && attachments.length > 1) { setInputNotice({ key: "mediaGen.videoReferenceLimit" }); return; }

    setPageError(null);

    if (modelMode !== "chat" && attachments.some(part => !part.mediaType.startsWith("image/"))) {
      setInputNotice({ key: "ui.chat.use-chat-state.pDFAndWordAttachmentsAreSupported" });
      return;
    }
    if (modelMode === "chat" && attachments.some(part => part.mediaType.startsWith("image/")) && !selectedModelInfo?.supportsImageInput) {
      setInputNotice({ key: "chatState.imageInputUnsupported", values: { modelId: selectedChatModel?.modelId ?? "" } });
      return;
    }

    if (hasContent) setInput("");
    // Remembered until the turn produces an answer, so a failure can put the
    // text back instead of making the user retype it. The conversation id is
    // filled in once the first message has created one: a send that creates the
    // conversation switches the active id mid-flight, and the draft has to
    // follow it rather than be read back as empty.
    const userMessageId = crypto.randomUUID();
    pendingSendDraftRef.current = { chatId: activeChatId ?? "", messageId: userMessageId, text: content, pendingChat: activeChatId === null, afterIndex: messages.length };

    // The attachments are already uploaded references, so a submission no
    // longer depends on reading a file that may no longer be in memory. This
    // also removes the window where a send could be started from a composer that
    // belonged to a conversation the user had already left.
    const uploadParts: UploadableFilePart[] = attachments;

    if (modelMode === "image") {
      await generateImage(content, uploadParts);
      return;
    }

    if (modelMode === "video") {
      await generateVideo(content, uploadParts);
      return;
    }

    try {
      const chatId = await ensureActiveChatId(content || t("chatState.defaultChatTitle"));
      // Written here rather than in the composer, and unconditionally: the
      // composer clears its input on submit, and a draft that was only kept for
      // the "conversation was just created" path would be erased by the very
      // save that runs after the input is cleared.
      draftChatIdRef.current = chatId;
      writeChatDraft(chatId, { text: content, attachments });
      if (pendingSendDraftRef.current) {
        pendingSendDraftRef.current = { ...pendingSendDraftRef.current, chatId, pendingChat: false };
      }
      // Activating a new conversation replaces the SDK Chat instance. Send only
      // after that instance and its initial history are ready, not through draft's closure.
      const failed = await new Promise<boolean>((resolve, reject) => setPendingSend({
        chatId,
        message: { id: userMessageId, role: "user", parts: [...uploadParts, ...(hasContent ? [{ type: "text" as const, text: content }] : [])] },
        options: { body: { chatId, ...(selectedChatModel ? { model: selectedChatModel } : {}), mode: "chat" } },
        resolve, reject,
      }));

      if (failed) { restorePendingSendDraft(userMessageId); return; }
      if (draftChatIdRef.current === chatId) clearAttachments();
      await loadChats();
    } catch (submitError) {
      if (pendingSendDraftRef.current?.messageId !== userMessageId || !pendingCoversCurrentChat(pendingSendDraftRef.current)) return;
      restorePendingSendDraft(userMessageId);
      setPageError(submitError instanceof Error ? submitError.message : t("chatState.sendFailed"));
    }
  }

  function handleTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Escape in the message box stops a running answer; with Shift it is the
    // "focus the message box" shortcut, which is already satisfied here.
    if (event.key === "Escape" && !event.shiftKey && isPending) {
      event.preventDefault();
      onStop();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const hasAttachments = attachments.length > 0;
      const hasContent = input.trim().length > 0;
      if (isPending || !isConversationReady) return;
      if (!hasContent && !hasAttachments && !selectedToolDocument) return;
      void onSubmit(event as unknown as FormEvent<HTMLFormElement>);
    }
  }

  useEffect(() => {
    if (!pendingSend || claimedSendRef.current === pendingSend) return;
    if (activeChatId !== pendingSend.chatId || (historyState?.chatId === pendingSend.chatId && historyState.status === "error")) {
      claimedSendRef.current = pendingSend;
      setPendingSend(null);
      pendingSend.reject(new Error(t("chatState.sendContextLost")));
      return;
    }
    if (historyState?.chatId !== pendingSend.chatId || historyState.status !== "ready" || isLoadingHistory) return;
    claimedSendRef.current = pendingSend;
    setPendingSend(null);
    // SDK request failures resolve sendMessage; onFinish reports the outcome.
    // Associate it with this message so an older chat cannot settle a newer send.
    const messageId = pendingSend.message && "id" in pendingSend.message ? pendingSend.message.id : undefined;
    if (messageId) inFlightSendsRef.current.set(messageId, pendingSend);
    void sendMessage(pendingSend.message, pendingSend.options)
      .then(() => pendingSend.resolve(pendingSend.failed === true), pendingSend.reject)
      .finally(() => { if (messageId) inFlightSendsRef.current.delete(messageId); });
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
    setSentWithoutModel(false);
    setInputNotice(null);
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
    if (!pendingDelete) return;

    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || isDeleting) return;
      if (pendingDelete) {
        setPendingDelete(null);
        return;
      }
      // Escape stops a running turn. The composer is left alone: someone
      // pressing Escape to dismiss something should not silently abandon an
      // answer they were watching.
      if (isPending) onStop();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingDelete, isDeleting, isPending, onStop]);
  return {
    toggleEphemeral, isEphemeralSaving, documentTopics, loadDocumentTopics, setDocumentScope, isDocumentScopeSaving, assistants, assistantsError, loadAssistants, applyAssistant,
    setWorkspace, isWorkspaceSaving, loadChats,
    nextChatsCursor, isLoadingMoreChats, loadMoreChats, olderMessagesCursor, isLoadingOlderMessages, loadOlderMessages,
    isLoadingChats, isCreatingChat, createNewChat, chats, visibleChats, activeChatId, editingChatId, setEditingTitle,
    editingTitle, saveEditedTitle, cancelEditingChat, switchActiveChat, startEditingChat,
    requestDeleteConversation, hasHiddenChats, setIsChatListExpanded, isChatListExpanded, filteredTasks,
    isLoadingTasks, loadTasks, setTaskStatusFilter, taskStatusFilter,
    taskPanelError: withoutGlobalEcho(taskPanelError),
    visibleTasks, updateTaskStatus, deleteTask, saveTaskSchedule, updatingTaskIds, hasHiddenTasks, setIsTaskListExpanded,
    isTaskListExpanded, activeChat, isPending, isWorking, isLoadingPreferences, isOpeningConversation, isConversationReady, isRunningManualTool, modelMode, selectedModel, selectedModelInfo, onModeSelect,
    onModelSelect, modelHint, inputNotice, dismissInputNotice: () => setInputNotice(null), isModelMenuOpen, setIsModelMenuOpen, appendQuickPrompt, isHistoryReady: confirmedChatId !== null && historyState?.chatId === confirmedChatId && historyState.status === "ready", isLoadingHistory, confirmedChatId, messages, imageByMessageId, videoByMessageId,
    status, editingMessageId, startEditingMessage, regenerateMessage, requestDeleteMessage,
    setEditingMessageText, editingMessageText, saveEditedMessage, cancelEditingMessage,
    attachingImageKey, onReuseImageForEditing, reuseImageActionLabel, addToolApprovalResponse, onStop, onSubmit,
    removeAttachmentAt: (index: number) => { setInputNotice(null); removeAttachmentAt(index); }, isUploadingAttachments, isDraggingFiles, onComposerDragOver, onComposerDragLeave, onComposerDrop,
    setSelectedManualTool, manualToolSelectValue, manualTools, selectedToolDocument, setSelectedToolDocument,
    selectedManualToolConfig, manualToolFieldValues, setManualToolFieldValues, manualToolFieldErrors,
    setManualToolFieldErrors, unavailableTools, toolCatalogError: withoutGlobalEcho(toolCatalogError), loadToolCatalog,
    setInput, handleTextareaKeyDown, onTextareaPaste,
    textareaRef, input, isManualToolSelected, onAttachmentInputChange, fileInputRef, attachments,
    clearAttachments, attachmentNames, selectedImageModel, selectedVideoModel, selectedManualTool,
    selectedChatModel, pendingDelete, isDeleting, closeDeleteDialog, confirmDelete,
    effectiveError, keyError, setPageError, clearError, clearPreferencesError, modelLibrary,
    panelVisibility, togglePanel,
  };
}
export type ChatState = ReturnType<typeof useChatState>;
