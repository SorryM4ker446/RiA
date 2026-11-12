import type { TurnNotice } from "@/features/chat/page-utils";
import { localizeMessage, t, tf } from "@/lib/locale";
import {
  ChatSummary,
  hasLaterUserMessage,
  isToolPart,
  mapStoredMessagesToUI,
  ModelMode,
  readText,
  UploadableFilePart
} from "@/features/chat/page-utils";
import { encodePersistedUserMessage } from "@/lib/ai/ui-message";
import { readMessageInvocation } from "@/lib/chat/invocation-schema";
import { isDocumentAttachment } from "@/lib/media/limits";
import { getApiErrorMessage as readApiErrorMessage } from "@/lib/api-error-message";
import { usePanelVisibility } from "./use-panel-visibility";
import { useChat } from "@ai-sdk/react";
import { lastAssistantMessageIsCompleteWithApprovalResponses, UIMessage } from "ai";
import { ClipboardEvent, DragEvent, FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { chatApi, createChatTransport, isNotFoundError } from "@/features/chat/api-client";
import { clearChatDraft, readChatDraft, writeChatDraft } from "@/features/chat/draft";
import type { DeleteTarget } from "@/features/chat/types";
import type { ModelLibraryItem } from "@/lib/models/preferences-schema";
import type { InputNotice } from "@/features/chat/composer-notice";

import { useChatPreferences } from "@/features/chat/use-chat-preferences";
import { useConversations } from "@/features/chat/use-conversations";
import { useMediaGeneration } from "@/features/chat/use-media-generation";
import { DOCUMENT_TOOLS, EMPTY_CHOICE, invocationOf, useTools, type ComposerChoice } from "@/features/chat/use-tools";
import { useToast } from "@/components/ui/toast";
import { COMPACT_CONTEXT_TOOL } from "@/lib/chat/compact-context";
import { animateRemoval } from "@/lib/ui/removal";
import { OPEN_CONVERSATION_EVENT } from "@/features/chat/open-conversation";
import { useRefreshOnReturn } from "@/lib/use-refresh-on-return";
import { taskApi } from "@/features/tasks/task-client";
import { parseModelRefValue } from "@/features/chat/preferences";
import { TASK_DEFAULT_MODEL } from "@/features/chat/types";
import { useConversationStore } from "@/features/chat/conversation-store";
/** Whether the page is in view, kept current as it is hidden and shown. */
function usePageVisible() {
  return useSyncExternalStore(
    onChange => { document.addEventListener("visibilitychange", onChange); return () => document.removeEventListener("visibilitychange", onChange); },
    () => document.visibilityState === "visible",
    () => true,
  );
}

/** A message written while its conversation was answering, waiting to be sent. */
export type QueuedMessage = { id: string; text: string; attachments: UploadableFilePart[] };
const QUEUE_STORAGE_KEY = "ria.chat.queue";
/** Enough to keep writing; the queue is not a place to park a backlog. */
const MAX_QUEUED = 10;
function readQueues(): Record<string, QueuedMessage[]> {
  try {
    const value = JSON.parse(window.localStorage.getItem(QUEUE_STORAGE_KEY) ?? "{}") as Record<string, QueuedMessage[]>;
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}
function writeQueues(queues: Record<string, QueuedMessage[]>) {
  try { window.localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queues)); } catch { /* Kept for this visit only. */ }
}

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
    isLoadingPreferences, preferencesError, modelLibrary, clearPreferencesError, defaultChatModel,
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
    // In a task's conversation the model is the task's: choosing one changes the task.
    if (activeChat?.task && modelMode === "chat") { void setTaskModel(activeChat.task.id, value); return; }
    selectPreferredModel(value);
  }
  const {
    chats, activeChat, isLoadingChats, isCreatingChat,
    loadChats, createNewChat, performDeleteChat, ensureActiveChatId,
    nextChatsCursor, isLoadingMoreChats, loadMoreChats, toggleEphemeral, isEphemeralSaving,
    isDocumentScopeSaving, assistants, assistantsError, loadAssistants, applyAssistant,
    setWorkspace, isWorkspaceSaving, setApprovalRule, isApprovalSaving, restoringChatId, isRestoringChat,
  } = useConversations({ activeChatId, setActiveChatId, preferences: { modelMode, selectedChatModel: preferredChatModel, selectedImageModel, selectedVideoModel }, applyChatPreferences, resetConversation, detachFromAnswer, setPageError });
  // A remembered conversation the list has not confirmed yet is not one to send to,
  // and a send waits for a workspace switch so the turn uses the folder the picker shows.
  const isConversationReady = !isLoadingPreferences && restoringChatId === null && !isWorkspaceSaving && !isApprovalSaving && (activeChatId !== null || !isLoadingChats);
  // The open conversation once it is known to exist: what history-bound panels may show.
  const confirmedChatId = restoringChatId === null ? activeChatId : null;
  // A task's conversation uses the task's model, or the default chat model while
  // it names none; the server decides it for every turn there, so none is sent.
  const taskOfChat = activeChat?.task ?? null;
  const selectedChatModel = taskOfChat ? taskOfChat.model ?? defaultChatModel : activeChat?.assistantConfig?.model ?? preferredChatModel;
  const sentChatModel = taskOfChat ? null : selectedChatModel;
  const transport = useMemo(() => createChatTransport(activeChatId, { selectedChatModel: sentChatModel, modelMode }), [activeChatId, sentChatModel, modelMode]);
  async function setTaskModel(taskId: string, value: string) {
    if (!value) return;
    setPageError(null);
    try {
      await taskApi.update(taskId, { model: value === TASK_DEFAULT_MODEL ? null : parseModelRefValue(value) });
    } catch (cause) {
      setPageError(cause instanceof Error ? cause.message : t("tasks.saveFailed"));
    }
    await loadChats({ silent: true });
  }
  const toast = useToast();
  // The server is folding older turns before it can answer; only meaningful until the answer opens.
  const [isOrganizing, setIsOrganizing] = useState(false);
  // Waiting for a place, or the provider being retried: said until the turn moves on.
  const [turnNotice, setTurnNotice] = useState<TurnNotice | null>(null);
  const noticeTimer = useRef(0);
  const showTurnNotice = (notice: TurnNotice | { state: "running" }) => {
    window.clearTimeout(noticeTimer.current);
    if (notice.state === "running") { setTurnNotice(null); return; }
    setTurnNotice(notice);
    // A retry says how long it waits; after that the call is under way again.
    if (notice.state === "retrying") noticeTimer.current = window.setTimeout(() => setTurnNotice(null), notice.seconds * 1000);
  };
  // The conversation whose earlier turns the person asked to have folded.
  const [compactingChatId, setCompactingChatId] = useState<string | null>(null);
  const [compaction, setCompaction] = useState<{ chatId: string; summary: string; coveredIds: string[] } | null>(null);
  // Space freed by a fold since the latest request measured its input; the next one measures anew.
  const [freedByCompaction, setFreedByCompaction] = useState<{ chatId: string; lastMessageId?: string; tokens: number } | null>(null);
  const compactionRequest = useRef(0);
  const { messages, setMessages, sendMessage, regenerate, addToolApprovalResponse, status, error, clearError, stop, resumeStream } = useChat({
    id: activeChatId ?? "draft",
    transport,
    // A fast model sends far more deltas than a screen can show. Rendering at
    // most every 50ms keeps a long transcript from falling behind the stream;
    // the trailing update still delivers the final text.
    experimental_throttle: 50,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onData: part => {
      if (part.type === "data-context-status") setIsOrganizing((part.data as { organizing: boolean }).organizing);
      if (part.type === "data-turn-status") showTurnNotice(part.data as TurnNotice | { state: "running" });
    },
    onFinish: ({ messages: finishedMessages, isError }) => {
      if (!isError) return;
      const latestUser = [...finishedMessages].reverse().find(message => message.role === "user");
      const pending = latestUser ? inFlightSendsRef.current.get(latestUser.id) : undefined;
      if (pending) pending.failed = true;
    },
  });
  useEffect(() => { if (status !== "submitted") setIsOrganizing(false); }, [status]);
  useEffect(() => { if (status === "ready" || status === "error") showTurnNotice({ state: "running" }); }, [status]);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);
  const loadCompaction = useCallback(async (chatId: string | null) => {
    const request = ++compactionRequest.current;
    const found = chatId ? await chatApi.conversationSummary(chatId).catch(() => null) : null;
    if (request === compactionRequest.current) setCompaction(found && chatId ? { chatId, ...found } : null);
  }, []);
  // A fold can happen during a turn or just after one, so a finished turn looks again.
  useEffect(() => { if (status === "ready") void loadCompaction(confirmedChatId); }, [status, confirmedChatId, loadCompaction]);
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
    isGeneratingImage, isGeneratingVideo, isUploadingAttachments,
    imageByMessageId, setImageByMessageId, videoByMessageId, setVideoByMessageId, attachments,
    attachingImageKey, fileInputRef, attachmentNames, reuseImageActionLabel, clearAttachments, removeAttachmentAt, replaceAttachments,
    appendAttachments, onReuseImageForEditing, onAttachmentInputChange, generateImage, generateVideo,
  } = useMediaGeneration({ activeChatId, isConversationReady, isHistoryReady: historyState?.chatId === activeChatId && historyState.status === "ready", setMessages, reloadMessages: loadMessages, ensureActiveChatId, loadChats, setPageError, modelMode, selectedImageModel, selectedVideoModel, textareaRef });
  const {
    tools, skills, toolCatalogError, loadToolCatalog, choice, setChoice, chooseTool, toggleSkill, removeLastChoice, removeTool,
    setToolDocument, setToolFormat, clearChoice, isConverting, convertDocuments, compactContext,
  } = useTools({ activeChatId, isHistoryReady: historyState?.chatId === activeChatId && historyState.status === "ready", setMessages, reloadMessages: loadMessages, ensureActiveChatId, loadChats, modelMode });
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
    isConverting;
  const isPending = isLoadingPreferences || isWorking;
  // The sidebar's dot for this conversation: something is being answered or made in it.
  const isAnswering = pendingSend !== null || status === "submitted" || status === "streaming" || isGeneratingImage || isGeneratingVideo || isConverting;
  const { setWorkingId: publishWorking } = useConversationStore();
  useEffect(() => { publishWorking(isAnswering ? activeChatId : null); }, [isAnswering, activeChatId, publishWorking]);
  useEffect(() => () => publishWorking(null), [publishWorking]);
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

  /*
   * Messages written while the conversation is still answering wait here, in
   * order, and are sent one by one once it is free: not answering, here or
   * elsewhere, and not waiting for an approval. Each conversation has its own
   * queue, kept in this browser like the drafts, so leaving and coming back,
   * or reloading, keeps it. A queued message carries its text and its
   * already-uploaded attachments; a tool or skill choice is not queued.
   */
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({});
  // Read after mount, so the server render and the first client render agree.
  useEffect(() => { setQueues(readQueues()); }, []);
  const updateQueue = useCallback((chatId: string, change: (queue: QueuedMessage[]) => QueuedMessage[]) => setQueues(current => {
    const next = { ...current, [chatId]: change(current[chatId] ?? []) };
    if (!next[chatId].length) delete next[chatId];
    writeQueues(next);
    return next;
  }), []);
  const queuedMessages = useMemo(() => (activeChatId ? queues[activeChatId] ?? [] : []), [activeChatId, queues]);
  const conversationBusy = isAnswering || Boolean(activeChat?.answering);
  const canQueue = Boolean(activeChatId) && isConversationReady && conversationBusy && modelMode === "chat" && !choice.tool && !choice.skills.length
    && !isUploadingAttachments && (input.trim().length > 0 || attachments.length > 0) && queuedMessages.length < MAX_QUEUED;
  function queueMessage() {
    if (!canQueue || !activeChatId) return;
    const item: QueuedMessage = { id: crypto.randomUUID(), text: input.trim(), attachments: [...attachments] };
    updateQueue(activeChatId, queue => [...queue, item]);
    setInput("");
    clearAttachments();
  }
  function removeQueued(id: string) { if (activeChatId) updateQueue(activeChatId, queue => queue.filter(item => item.id !== id)); }
  /** Back into the composer to change, out of the queue. Only into an empty composer, so nothing typed is lost. */
  function editQueued(id: string) {
    const item = queuedMessages.find(entry => entry.id === id);
    if (!item || !activeChatId || input.trim() || attachments.length) return;
    removeQueued(id);
    setInput(item.text);
    replaceAttachments(item.attachments);
  }
  // The next queued message goes once the conversation is free.
  const sendNextQueued = useRef(onSubmit);
  sendNextQueued.current = onSubmit;
  const awaitingApprovalHere = Boolean(activeChat?.awaitingApproval);
  const answeringHere = Boolean(activeChat?.answering);
  const historyReadyForQueue = Boolean(confirmedChatId && historyState?.chatId === confirmedChatId && historyState.status === "ready");
  useEffect(() => {
    if (!activeChatId || !queuedMessages.length || isPending || answeringHere || awaitingApprovalHere || !isConversationReady || !historyReadyForQueue || modelMode !== "chat") return;
    const [next] = queuedMessages;
    // What sending would refuse stays queued, where it can be changed or removed,
    // instead of leaving the queue and going nowhere.
    if (!selectedModel || (next.attachments.some(part => part.mediaType.startsWith("image/")) && !selectedModelInfo?.supportsImageInput)) return;
    updateQueue(activeChatId, queue => queue.filter(item => item.id !== next.id));
    void sendNextQueued.current(undefined, next);
  }, [activeChatId, queuedMessages, isPending, answeringHere, awaitingApprovalHere, isConversationReady, historyReadyForQueue, modelMode, updateQueue, selectedModel, selectedModelInfo]);

  // A draft belongs to one conversation. Switching away parks it and switching
  // back brings it back, so a half-written question survives navigating around.
  const draftChatIdRef = useRef<string | null>(null);
  const pendingSendDraftRef = useRef<{ chatId: string; messageId: string; text: string; choice: ComposerChoice; pendingChat?: boolean; afterIndex: number } | null>(null);
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
    const files = Array.from(event.dataTransfer?.files ?? []);
    setIsDraggingFiles(false);
    if (!files.length) return;
    event.preventDefault();
    void appendAttachments(files);
  }

  const stopRef = useRef(stop);
  stopRef.current = stop;
  const statusRef = useRef(status);
  statusRef.current = status;
  /**
   * Stops the answer. The service holds the turn, so it is the service that is
   * asked: it stops the model, saves what was written and ends the stream, which
   * this page reads to its end like any other. Only when it holds nothing (the
   * request had not reached it, or it already ended) does the page stop alone.
   */
  const onStop = useCallback(() => {
    if (!isPending) return;
    const chatId = activeChatIdRef.current;
    if (chatId && (statusRef.current === "submitted" || statusRef.current === "streaming")) {
      void chatApi.stopTurn(chatId).then(stopped => { if (!stopped) stopRef.current(); }).catch(() => stopRef.current());
    } else stopRef.current();
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
    setChoice(pending.choice);
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

    const pastedFiles = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    if (pastedFiles.length === 0) return;
    event.preventDefault();
    appendAttachments(pastedFiles);
  }

  /**
   * Leaving a conversation while it answers leaves the answer to the service,
   * which goes on writing and saving it; this page only stops reading it. Coming
   * back reads it again from where the service has got to.
   */
  function detachFromAnswer() {
    // Only an answer that has started: a send still waiting for the service must
    // hear how it went, so a refusal can put the message back where it was written.
    if (statusRef.current === "streaming") stopRef.current();
  }

  async function switchActiveChat(nextChatId: string) {
    if (nextChatId === activeChatId) return;
    detachFromAnswer();
    setActiveChatId(nextChatId);
  }

  /**
   * Adds what was written to the open conversation since it was loaded: a
   * task's run, another window. Only turns after the last one already shown are
   * added, and nothing is touched while a turn of this page is in progress.
   */
  async function refreshActiveMessages() {
    const chatId = confirmedChatId;
    if (!chatId || isWorking || historyState?.chatId !== chatId || historyState.status !== "ready") return;
    const payload = await chatApi.listMessages(chatId).catch(() => null);
    if (!payload || latestChatRef.current !== chatId) return;
    const mapped = mapStoredMessagesToUI(payload.data ?? []);
    setMessages(current => {
      const known = new Set(current.map(message => message.id));
      let lastShared = -1;
      mapped.uiMessages.forEach((message, index) => { if (known.has(message.id)) lastShared = index; });
      // Without a turn in common the page and the store disagree on more than new turns; leave the page as it is.
      if (lastShared < 0) return current;
      const added = mapped.uiMessages.slice(lastShared + 1).filter(message => !known.has(message.id));
      return added.length ? [...current, ...added] : current;
    });
    setImageByMessageId(current => ({ ...mapped.imageMap, ...current }));
    setVideoByMessageId(current => ({ ...mapped.videoMap, ...current }));
  }
  const latestChatRef = useRef(confirmedChatId);
  const refreshRef = useRef(refreshActiveMessages);
  const switchRef = useRef(switchActiveChat);
  useEffect(() => { latestChatRef.current = confirmedChatId; refreshRef.current = refreshActiveMessages; switchRef.current = switchActiveChat; });
  useRefreshOnReturn(() => refreshRef.current());
  // An answer this page did not ask for (a task's run, another window, this
  // page before it was reloaded) is read as it is written: once the history is
  // shown, the page attaches to the turn the service is holding, from its start.
  const historyReady = Boolean(confirmedChatId && historyState?.chatId === confirmedChatId && historyState.status === "ready");
  const answeringElsewhere = Boolean(activeChat?.answering);
  const attachedTo = useRef<string | null>(null);
  useEffect(() => {
    if (!answeringElsewhere) { attachedTo.current = null; return; }
    if (!historyReady || status !== "ready" || pendingSend || attachedTo.current === confirmedChatId) return;
    attachedTo.current = confirmedChatId;
    void resumeStream().catch(() => { /* Nothing to attach to: the turn ended; its answer is read below. */ });
  }, [answeringElsewhere, historyReady, status, pendingSend, confirmedChatId, resumeStream]);
  // A turn that ended without this page reading it (it attached too late, or not
  // at all) has its answer read from what was saved.
  const { onTurn } = useConversationStore();
  useEffect(() => onTurn(notice => {
    if (notice.type !== "turn-finished" || notice.chatId !== latestChatRef.current) return;
    if (statusRef.current === "ready") void refreshRef.current();
  }), [onTurn]);
  // Open and in view, what arrived in it has been read.
  const pageVisible = usePageVisible();
  const markingRead = useRef<string | null>(null);
  const { update: updateSummary } = useConversationStore();
  useEffect(() => {
    if (!historyReady || !confirmedChatId || !activeChat?.unread || !pageVisible || markingRead.current === confirmedChatId) return;
    const chatId = confirmedChatId;
    markingRead.current = chatId;
    void chatApi.markRead(chatId).then(saved => updateSummary(saved.data)).catch(() => { /* Still unread; tried again on the next change. */ })
      .finally(() => { if (markingRead.current === chatId) markingRead.current = null; });
  }, [historyReady, confirmedChatId, activeChat?.unread, pageVisible, updateSummary]);
  // Another page, a notice or a system notification asked for a conversation.
  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      void switchRef.current(id).then(() => loadChats());
    };
    window.addEventListener(OPEN_CONVERSATION_EVENT, open);
    return () => window.removeEventListener(OPEN_CONVERSATION_EVENT, open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // Later turns were answered from the message as it was, so rewriting it would
    // leave them answering something no longer there. It goes out again at the end.
    if (hasLaterUserMessage(messages, message.id)) { await resendEditedMessage(message, nextText, activeChatId); return; }

    const previous = messages;
    setEditingMessageId(null);
    setEditingMessageText("");
    setMessages((current) =>
      current.map((item) =>
        item.id === message.id ? { ...item, parts: [{ type: "text", text: nextText }] } : item,
      ),
    );

    try {
      const invocation = readMessageInvocation(message.metadata);
      await chatApi.editMessage(activeChatId, message.id, invocation ? encodePersistedUserMessage({ type: "user-message", text: nextText, files: [], invocation }) : nextText);
    } catch (editError) {
      setMessages(previous);
      setPageError(editError instanceof Error ? editError.message : t("chatApi.saveEditFailed"));
      return;
    }
    await regenerateMessage(message.id);
  }

  /** The original and everything after it stay as they are. A failure reopens the edit. */
  async function resendEditedMessage(message: UIMessage, text: string, chatId: string) {
    if (!selectedModel) { setSentWithoutModel(true); return; }
    setEditingMessageId(null);
    setEditingMessageText("");
    setPageError(null);
    if (modelMode === "image") { await generateImage(text, []); return; }
    if (modelMode === "video") { await generateVideo(text, []); return; }
    const invocation = readMessageInvocation(message.metadata);
    const restore = () => { setEditingMessageId(message.id); setEditingMessageText(text); };
    try {
      const failed = await new Promise<boolean>((resolve, reject) => setPendingSend({
        chatId,
        message: { id: crypto.randomUUID(), role: "user", metadata: { ...(invocation ? { invocation } : {}), createdAt: new Date().toISOString() }, parts: [{ type: "text", text }] },
        options: { body: { chatId, ...(sentChatModel ? { model: sentChatModel } : {}), mode: "chat" } },
        resolve, reject,
      }));
      if (failed) restore(); else await loadChats();
    } catch (sendError) {
      restore();
      setPageError(sendError instanceof Error ? sendError.message : t("chatState.sendFailed"));
    }
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
        body: { chatId: activeChatId, ...(sentChatModel ? { model: sentChatModel } : {}), mode: modelMode },
      });
      await loadChats();
    } catch (regenerateError) {
      setPageError(regenerateError instanceof Error ? regenerateError.message : t("chatState.regenerateFailed"));
    }
  }

  /**
   * Sends what the composer holds, or a message that waited in the queue
   * (`queued`), which brings its own text and attachments and no tool choice and
   * leaves the composer as it is.
   */
  async function onSubmit(event?: FormEvent<HTMLFormElement>, queued?: QueuedMessage) {
    event?.preventDefault();
    if (isPending || isDocumentScopeSaving || !isConversationReady) return;
    setInputNotice(null);
    const typed = queued ? queued.text : input;
    const files = queued ? queued.attachments : attachments;
    const chosenTool = modelMode === "chat" && !queued ? choice.tool : null;
    const isDocumentTool = Boolean(chosenTool && DOCUMENT_TOOLS.has(chosenTool.id));
    if (isDocumentTool && files.some(part => !isDocumentAttachment(part.mediaType))) { setInputNotice({ key: "chat.document.onlyDocuments" }); return; }
    if (isDocumentTool && !files.length && !choice.document) { setInputNotice({ key: "ui.chat.use-chat-state.chooseAKnowledgeDocumentFirst" }); return; }
    // Whatever was typed says what to keep; no model answers this one.
    if (chosenTool?.id === COMPACT_CONTEXT_TOOL) {
      const focus = input.trim(), sent = choice;
      setPageError(null); clearChoice(); setInput(""); setCompactingChatId(activeChatId);
      try {
        const { status: outcome, freedTokens } = await compactContext(focus);
        toast(t(outcome === "compacted" ? "chat.compact.done" : "chat.compact.nothing"));
        if (outcome === "compacted" && activeChatId) {
          setFreedByCompaction({ chatId: activeChatId, lastMessageId: messages.at(-1)?.id, tokens: freedTokens });
          await loadCompaction(activeChatId);
        }
      }
      catch (submitError) {
        setChoice(sent); setInput(focus);
        setPageError(submitError instanceof Error ? submitError.message : t("chat.compact.failed"));
      }
      finally { setCompactingChatId(null); }
      return;
    }
    // Nothing to say to a model: the choice itself is the whole request.
    if (chosenTool?.surface.user?.run === "direct" && !input.trim()) {
      const sent = choice;
      setPageError(null); clearChoice();
      try {
        const { failed } = await convertDocuments({ files: attachments, document: choice.document, format: choice.format, text: "", invocation: invocationOf(choice, localizeMessage)! });
        if (failed) setChoice(sent); else clearAttachments();
      } catch (submitError) {
        setChoice(sent);
        setPageError(submitError instanceof Error ? submitError.message : t("chatState.toolRunFailed"));
      }
      return;
    }
    const content = typed.trim() || (isDocumentTool && choice.document ? tf("chat.document.readRequest", { name: choice.document.filename }) : "");
    const hasAttachments = files.length > 0;
    const hasContent = content.length > 0;

    if (!hasContent && !hasAttachments) return;
    if (!selectedModel) { setSentWithoutModel(true); return; }
    if (modelMode === "video" && files.length > 1) { setInputNotice({ key: "mediaGen.videoReferenceLimit" }); return; }

    setPageError(null);

    if (modelMode !== "chat" && files.some(part => !part.mediaType.startsWith("image/"))) {
      setInputNotice({ key: "ui.chat.use-chat-state.pDFAndWordAttachmentsAreSupported" });
      return;
    }
    if (modelMode === "chat" && files.some(part => part.mediaType.startsWith("image/")) && !selectedModelInfo?.supportsImageInput) {
      setInputNotice({ key: "chatState.imageInputUnsupported", values: { modelId: selectedChatModel?.modelId ?? "" } });
      return;
    }

    if (!queued) setInput("");
    // Remembered until the turn produces an answer, so a failure can put the
    // text back instead of making the user retype it. The conversation id is
    // filled in once the first message has created one: a send that creates the
    // conversation switches the active id mid-flight, and the draft has to
    // follow it rather than be read back as empty.
    const userMessageId = crypto.randomUUID();
    const invocation = modelMode === "chat" && !queued ? invocationOf(choice, localizeMessage) : null;
    pendingSendDraftRef.current = { chatId: activeChatId ?? "", messageId: userMessageId, text: typed.trim(), choice: queued ? EMPTY_CHOICE : choice, pendingChat: activeChatId === null, afterIndex: messages.length };
    if (!queued) clearChoice();

    // The attachments are already uploaded references, so a submission no
    // longer depends on reading a file that may no longer be in memory. This
    // also removes the window where a send could be started from a composer that
    // belonged to a conversation the user had already left.
    const uploadParts: UploadableFilePart[] = files;

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
      if (!queued) writeChatDraft(chatId, { text: content, attachments });
      if (pendingSendDraftRef.current) {
        pendingSendDraftRef.current = { ...pendingSendDraftRef.current, chatId, pendingChat: false };
      }
      // Activating a new conversation replaces the SDK Chat instance. Send only
      // after that instance and its initial history are ready, not through draft's closure.
      const failed = await new Promise<boolean>((resolve, reject) => setPendingSend({
        chatId,
        message: { id: userMessageId, role: "user", metadata: { ...(invocation ? { invocation } : {}), createdAt: new Date().toISOString() }, parts: [...uploadParts, ...(hasContent ? [{ type: "text" as const, text: content }] : [])] },
        options: { body: { chatId, ...(sentChatModel ? { model: sentChatModel } : {}), mode: "chat" } },
        resolve, reject,
      }));

      if (failed) { restorePendingSendDraft(userMessageId); return; }
      if (!queued && draftChatIdRef.current === chatId) clearAttachments();
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
      if (canQueue) { queueMessage(); return; }
      if (isPending || !isConversationReady) return;
      if (!hasContent && !hasAttachments && !choice.document) return;
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

  function onModeSelect(value: ModelMode) {
    setSentWithoutModel(false);
    setInputNotice(null);
    setModelMode(value);
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
  // A model that cannot call tools cannot carry on from an answer, so this records the
  // rejection without a model call and leaves the conversation free for the next message.
  const declineApprovals = useCallback(async (messageId: string) => {
    if (!activeChatId) return;
    const response = await fetch(`/api/conversations/${activeChatId}/messages/${encodeURIComponent(messageId)}/decline`, { method: "POST" });
    if (!response.ok) throw new Error(readApiErrorMessage(await response.json().catch(() => null), t("chatState.requestFailed")));
    const reason = t("chat.messages.approvalRejectedReason");
    setMessages(current => current.map(message => message.id !== messageId ? message : { ...message, parts: message.parts.map(part =>
      "state" in part && part.state === "approval-requested" && "approval" in part && part.approval
        ? { ...part, state: "output-denied", approval: { ...part.approval, approved: false, reason } } as unknown as typeof part
        : part) }));
  }, [activeChatId, setMessages]);
  return {
    declineApprovals,
    toggleEphemeral, isEphemeralSaving, isDocumentScopeSaving, assistants, assistantsError, loadAssistants, applyAssistant,
    setWorkspace, isWorkspaceSaving, setApprovalRule, isApprovalSaving, loadChats,
    nextChatsCursor, isLoadingMoreChats, loadMoreChats, olderMessagesCursor, isLoadingOlderMessages, loadOlderMessages,
    isLoadingChats, isCreatingChat, createNewChat, chats, activeChatId, switchActiveChat,
    requestDeleteConversation,
    compaction: compaction?.chatId === activeChatId ? compaction : null,
    freedByCompaction: freedByCompaction?.chatId === activeChatId && freedByCompaction.lastMessageId === messages.at(-1)?.id ? freedByCompaction.tokens : 0,
    queuedMessages, canQueue, queueMessage, removeQueued, editQueued,
    isOrganizing, turnNotice, isCompacting: compactingChatId !== null && compactingChatId === activeChatId, activeChat, isPending, isWorking, isLoadingPreferences, isOpeningConversation, isConversationReady, isConverting, modelMode, selectedModel, selectedModelInfo, defaultChatModel, onModeSelect,
    onModelSelect, modelHint, inputNotice, dismissInputNotice: () => setInputNotice(null), isModelMenuOpen, setIsModelMenuOpen, isHistoryReady: confirmedChatId !== null && historyState?.chatId === confirmedChatId && historyState.status === "ready", isLoadingHistory, confirmedChatId, messages, imageByMessageId, videoByMessageId,
    status, editingMessageId, startEditingMessage, regenerateMessage, requestDeleteMessage,
    setEditingMessageText, editingMessageText, saveEditedMessage, cancelEditingMessage,
    attachingImageKey, onReuseImageForEditing, reuseImageActionLabel, addToolApprovalResponse, onStop, onSubmit,
    removeAttachmentAt: (index: number) => { setInputNotice(null); removeAttachmentAt(index); }, isUploadingAttachments, isDraggingFiles, onComposerDragOver, onComposerDragLeave, onComposerDrop,
    tools, skills, choice, chooseTool, toggleSkill, removeLastChoice, removeTool, setToolDocument, setToolFormat, toolCatalogError: withoutGlobalEcho(toolCatalogError), loadToolCatalog,
    setInput, handleTextareaKeyDown, onTextareaPaste,
    textareaRef, input, onAttachmentInputChange, fileInputRef, attachments,
    clearAttachments, attachmentNames, selectedImageModel, selectedVideoModel,
    selectedChatModel, pendingDelete, isDeleting, closeDeleteDialog, confirmDelete,
    effectiveError, keyError, setPageError, clearError, clearPreferencesError, modelLibrary,
    panelVisibility, togglePanel,
  };
}
export type ChatState = ReturnType<typeof useChatState>;
