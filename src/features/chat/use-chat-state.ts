import type { TurnNotice } from "@/features/chat/page-utils";
import { localizeMessage, t, tf } from "@/lib/locale";
import type { ModelMode, UploadableFilePart } from "@/features/chat/page-utils";
import { isDocumentAttachment } from "@/lib/media/limits";
import { getApiErrorMessage as readApiErrorMessage } from "@/lib/api-error-message";
import { usePanelVisibility } from "./use-panel-visibility";
import { FormEvent, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { chatApi, createChatTransport, isNotFoundError } from "@/features/chat/api-client";
import type { ModelLibraryItem } from "@/lib/models/preferences-schema";
import type { InputNotice } from "@/features/chat/composer-notice";
import { useChatPreferences } from "@/features/chat/use-chat-preferences";
import { useConversations } from "@/features/chat/use-conversations";
import { useMediaGeneration } from "@/features/chat/use-media-generation";
import { DOCUMENT_TOOLS, EMPTY_CHOICE, invocationOf, useTools } from "@/features/chat/use-tools";
import { useToast } from "@/components/ui/toast";
import { COMPACT_CONTEXT_TOOL } from "@/lib/chat/compact-context";
import { OPEN_CONVERSATION_EVENT } from "@/features/chat/open-conversation";
import { useRefreshOnReturn } from "@/lib/use-refresh-on-return";
import { taskApi } from "@/features/tasks/task-client";
import { parseModelRefValue } from "@/features/chat/preferences";
import { TASK_DEFAULT_MODEL } from "@/features/chat/types";
import { useConversationStore } from "@/features/chat/conversation-store";
import {
  ConversationSession, DRAFT_CHAT, forgetSession, HistoryUnavailableError, isAnswering as chatIsAnswering, keptSession, sessionFor,
  type ComposerDraft, type QueuedMessage,
} from "@/features/chat/conversation-session";
import { useActiveSession } from "@/features/chat/use-active-session";
import { useComposer } from "@/features/chat/use-composer";
import { useMessageActions } from "@/features/chat/use-message-actions";

export type { QueuedMessage } from "@/features/chat/conversation-session";

/** Whether the page is in view, kept current as it is hidden and shown. */
function usePageVisible() {
  return useSyncExternalStore(
    onChange => { document.addEventListener("visibilitychange", onChange); return () => document.removeEventListener("visibilitychange", onChange); },
    () => document.visibilityState === "visible",
    () => true,
  );
}

/**
 * The chat page. Each conversation is a session (conversation-session) holding
 * its messages, its message box, its queue and its notices; this page shows the
 * session of the conversation that is open, and holds only what belongs to the
 * page: which conversation is open, the model and mode, errors and dialogs.
 */
export function useChatState() {
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const activeChatIdRef = useRef(activeChatId);
  activeChatIdRef.current = activeChatId;
  const [pageError, setPageError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
  /** Nothing of the page is left over from the conversation that was open. */
  function resetConversation() { setInputNotice(null); }
  const {
    chats, activeChat, isLoadingChats, isCreatingChat,
    loadChats, createNewChat, performDeleteChat, ensureActiveChatId,
    nextChatsCursor, isLoadingMoreChats, loadMoreChats, toggleEphemeral, isEphemeralSaving,
    isDocumentScopeSaving, assistants, assistantsError, loadAssistants, applyAssistant,
    setWorkspace, isWorkspaceSaving, setApprovalRule, isApprovalSaving, restoringChatId, isRestoringChat,
  } = useConversations({ activeChatId, setActiveChatId, preferences: { modelMode, selectedChatModel: preferredChatModel, selectedImageModel, selectedVideoModel }, applyChatPreferences, resetConversation, setPageError });
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

  // --- the open conversation's session ---------------------------------------------------------

  const transportFor = (chatId: string) => createChatTransport(chatId === DRAFT_CHAT ? null : chatId, { selectedChatModel: sentChatModel, modelMode });
  const makeSession = (chatId: string, fresh = false) => new ConversationSession(chatId, transportFor(chatId), fresh ? { history: "ready" } : {});
  const { session, state, messages, setMessages, regenerate, addToolApprovalResponse, status, error, clearError, stop } = useActiveSession(activeChatId, chatId => transportFor(chatId));
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const draft = state.draft;
  const isHistoryReady = state.history === "ready";
  const isLoadingHistory = state.history === "loading";
  // The service is folding older turns before it can answer: only meaningful until the answer opens.
  const isOrganizing = state.organizing && status === "submitted";
  const turnNotice: TurnNotice | null = state.notice;

  /** Reads a session's history, saying why it could not be read when it is the one on screen. */
  async function readHistoryOf(target: ConversationSession, options: { quiet?: boolean } = {}) {
    const { error: readError } = await target.loadHistory(options);
    if (!readError || sessionRef.current !== target) return;
    // A remembered conversation deleted since the last visit is not an error
    // to report: the list is about to replace it with another one.
    if (isNotFoundError(readError) && isRestoringChat(target.id)) return;
    const reason = readError instanceof Error ? readError.message : t("chatApi.listMessagesFailed");
    setPageError(`${reason} ${t("chatState.historyRecovery")}`);
  }
  const reloadMessages = useCallback(async (chatId: string) => {
    const target = sessionRef.current.id === chatId ? sessionRef.current : keptSession(chatId);
    if (target) await readHistoryOf(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Opening a conversation reads its history; one this window kept is shown as it
  // was at once and checked against what is saved.
  useEffect(() => {
    if (!activeChatId) { resetConversation(); return; }
    setPageError(null);
    setInputNotice(null);
    const history = session.getSnapshot().history;
    if (history === "idle" || history === "error") void readHistoryOf(session);
    else if (history === "ready" && session.historyRead) void readHistoryOf(session, { quiet: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId]);

  // A conversation deleted or archived anywhere is not kept.
  const { onRemoved: onConversationRemoved } = useConversationStore();
  useEffect(() => onConversationRemoved(id => forgetSession(id)), [onConversationRemoved]);

  // --- folding earlier turns -----------------------------------------------------------------

  // The conversation whose earlier turns the person asked to have folded.
  const [compactingChatId, setCompactingChatId] = useState<string | null>(null);
  const [compaction, setCompaction] = useState<{ chatId: string; summary: string; coveredIds: string[] } | null>(null);
  // Space freed by a fold since the latest request measured its input; the next one measures anew.
  const [freedByCompaction, setFreedByCompaction] = useState<{ chatId: string; lastMessageId?: string; tokens: number } | null>(null);
  const compactionRequest = useRef(0);
  const loadCompaction = useCallback(async (chatId: string | null) => {
    const request = ++compactionRequest.current;
    const found = chatId ? await chatApi.conversationSummary(chatId).catch(() => null) : null;
    if (request === compactionRequest.current) setCompaction(found && chatId ? { chatId, ...found } : null);
  }, []);
  // A fold can happen during a turn or just after one, so a finished turn looks again.
  useEffect(() => { if (status === "ready") void loadCompaction(confirmedChatId); }, [status, confirmedChatId, loadCompaction]);

  // --- media and tools -------------------------------------------------------------------------

  const {
    isGeneratingImage, isGeneratingVideo, isUploadingAttachments, attachments,
    attachingImageKey, fileInputRef, attachmentNames, reuseImageActionLabel, clearAttachments, removeAttachmentAt,
    appendAttachments, onReuseImageForEditing, onAttachmentInputChange, generateImage, generateVideo,
  } = useMediaGeneration({ session, activeChatId, isConversationReady, isHistoryReady, setMessages, reloadMessages, ensureActiveChatId, loadChats, setPageError, modelMode, selectedImageModel, selectedVideoModel, textareaRef });
  const {
    tools, skills, toolCatalogError, loadToolCatalog, choice, setChoice, chooseTool, toggleSkill, removeLastChoice, removeTool,
    setToolDocument, setToolFormat, clearChoice, isConverting, convertDocuments, compactContext,
  } = useTools({ activeChatId, isHistoryReady, setMessages, reloadMessages, ensureActiveChatId, loadChats, modelMode });

  // --- what the page is busy with --------------------------------------------------------------

  // A send between leaving the message box and reaching its conversation's client
  // (creating the conversation, waiting for its history to be read).
  const [startingSend, setStartingSend] = useState(false);
  const answeringNow = startingSend || chatIsAnswering(session.chat) || status === "submitted" || status === "streaming";
  // Work in flight that the "generating" status and the stop control stand for.
  // Reading the saved preferences is not part of it: it blocks sending like the
  // rest, but showing it as a running turn flashed both every time chat opened.
  const isWorking = answeringNow || isGeneratingImage || isGeneratingVideo || isUploadingAttachments || state.loadingOlder || isConverting;
  const isPending = isLoadingPreferences || isWorking;
  // The sidebar's dot for this conversation: something is being answered or made in it.
  const isAnsweringHere = answeringNow || isGeneratingImage || isGeneratingVideo || isConverting;
  const { setWorkingId: publishWorking } = useConversationStore();
  useEffect(() => { publishWorking(isAnsweringHere ? activeChatId : null); }, [isAnsweringHere, activeChatId, publishWorking]);
  useEffect(() => () => publishWorking(null), [publishWorking]);
  // Until the list says which conversation to restore, and that conversation's
  // history has been asked for, the transcript has nothing true to show. Showing
  // the empty-conversation welcome then is what made chat open on the welcome,
  // swap to the placeholder and then to the messages each time it was returned to.
  // A conversation this window kept is open as soon as it is chosen: it shows what it showed.
  const isOpeningConversation = restoringChatId !== null || (activeChatId ? state.history === "idle" : isLoadingChats);
  const selectedModel = modelMode === "chat" ? selectedChatModel : modelMode === "image" ? selectedImageModel : selectedVideoModel;
  const selectedModelInfo: ModelLibraryItem | undefined = selectedModel
    ? modelLibrary.find(model => model.providerId === selectedModel.providerId && model.modelId === selectedModel.modelId && model.modes.includes(modelMode))
    : undefined;
  // What the composer needs before it can send: a model added for this mode, or
  // one chosen after a send was attempted without. Nothing while loading.
  const modelHint: "add" | "choose" | null = isLoadingPreferences || selectedModel ? null
    : !modelLibrary.some(model => model.modes.includes(modelMode)) ? "add" : sentWithoutModel ? "choose" : null;
  const { visibility: panelVisibility, toggle: togglePanel } = usePanelVisibility();
  const effectiveError = pageError ?? preferencesError ?? (error ? readApiErrorMessage(error.message, t("chatState.requestFailed")) : null);

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
  const withoutGlobalEcho = (message: string | null) => message && message === effectiveError ? null : message;
  const keyError =
    effectiveError?.includes("OPENROUTER_API_KEY") ||
    effectiveError?.includes("Invalid API key") ||
    effectiveError?.includes("No auth credentials found");

  // --- stopping ---------------------------------------------------------------------------------

  const stopRef = useRef(stop);
  stopRef.current = stop;
  /**
   * Stops the answer. The service holds the turn, so it is the service that is
   * asked: it stops the model, saves what was written and ends the stream, which
   * this page reads to its end like any other. Only when it holds nothing (the
   * request had not reached it, or it already ended) does the page stop alone.
   * Stopping abandons the request, not the question: the message is in the
   * conversation, and what is in the message box stays where it is.
   */
  const onStop = useCallback(() => {
    if (!isPending) return;
    const chatId = activeChatIdRef.current;
    if (chatId && chatIsAnswering(sessionRef.current.chat)) {
      void chatApi.stopTurn(chatId).then(stopped => { if (!stopped) stopRef.current(); }).catch(() => stopRef.current());
    } else stopRef.current();
  }, [isPending]);

  // --- sending ----------------------------------------------------------------------------------

  /**
   * Sends what the message box holds, or a message that waited in the queue
   * (`queued`), which brings its own text and attachments and no tool choice and
   * leaves the message box as it is.
   */
  async function onSubmit(event?: FormEvent<HTMLFormElement>, queued?: QueuedMessage) {
    event?.preventDefault();
    if (isPending || isDocumentScopeSaving || !isConversationReady) return;
    setInputNotice(null);
    const source = session;
    const typed = queued ? queued.text : draft.text;
    const files = queued ? queued.attachments : draft.attachments;
    const chosenTool = modelMode === "chat" && !queued ? choice.tool : null;
    const isDocumentTool = Boolean(chosenTool && DOCUMENT_TOOLS.has(chosenTool.id));
    if (isDocumentTool && files.some(part => !isDocumentAttachment(part.mediaType))) { setInputNotice({ key: "chat.document.onlyDocuments" }); return; }
    if (isDocumentTool && !files.length && !choice.document) { setInputNotice({ key: "ui.chat.use-chat-state.chooseAKnowledgeDocumentFirst" }); return; }
    // Whatever was typed says what to keep; no model answers this one.
    if (chosenTool?.id === COMPACT_CONTEXT_TOOL) {
      const focus = draft.text.trim(), sent = choice;
      setPageError(null); clearChoice(); source.setDraft(current => ({ ...current, text: "" }), { typed: false }); setCompactingChatId(activeChatId);
      try {
        const { status: outcome, freedTokens } = await compactContext(focus);
        toast(t(outcome === "compacted" ? "chat.compact.done" : "chat.compact.nothing"));
        if (outcome === "compacted" && activeChatId) {
          setFreedByCompaction({ chatId: activeChatId, lastMessageId: messages.at(-1)?.id, tokens: freedTokens });
          await loadCompaction(activeChatId);
        }
      }
      catch (submitError) {
        setChoice(sent); source.restoreDraft({ text: focus, attachments: source.getSnapshot().draft.attachments });
        setPageError(submitError instanceof Error ? submitError.message : t("chat.compact.failed"));
      }
      finally { setCompactingChatId(null); }
      return;
    }
    // Nothing to say to a model: the choice itself is the whole request.
    if (chosenTool?.surface.user?.run === "direct" && !draft.text.trim()) {
      const sent = choice;
      setPageError(null); clearChoice();
      try {
        const { failed } = await convertDocuments({ files: draft.attachments, document: choice.document, format: choice.format, text: "", invocation: invocationOf(choice, localizeMessage)! });
        if (failed) setChoice(sent); else clearAttachments();
      } catch (submitError) {
        setChoice(sent);
        setPageError(submitError instanceof Error ? submitError.message : t("chatState.toolRunFailed"));
      }
      return;
    }
    const content = typed.trim() || (isDocumentTool && choice.document ? tf("chat.document.readRequest", { name: choice.document.filename }) : "");
    const hasContent = content.length > 0;
    if (!hasContent && !files.length) return;
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

    // Past every refusal. The attachments are already uploaded references, so a
    // send no longer depends on reading a file that may no longer be in memory.
    const uploadParts: UploadableFilePart[] = files;
    if (modelMode === "image" || modelMode === "video") {
      // A picture or video keeps its attachments until it is made: a failure leaves them to try again.
      if (!queued) source.setDraft(current => ({ ...current, text: "" }), { typed: false });
      await (modelMode === "image" ? generateImage : generateVideo)(content, uploadParts);
      return;
    }
    // What is sent leaves the message box (or the queue) now, and comes back if the request fails.
    const taken: ComposerDraft = queued ? { text: queued.text, attachments: queued.attachments } : source.takeDraft();
    if (queued) source.setQueue(current => current.filter(item => item.id !== queued.id));
    const sentChoice = queued ? EMPTY_CHOICE : choice;
    const invocation = modelMode === "chat" && !queued ? invocationOf(choice, localizeMessage) : null;
    if (!queued) clearChoice();
    const message = { id: crypto.randomUUID(), role: "user" as const, metadata: { ...(invocation ? { invocation } : {}), createdAt: new Date().toISOString() }, parts: [...uploadParts, ...(hasContent ? [{ type: "text" as const, text: content }] : [])] };
    let target: ConversationSession = source;
    /** The message goes back where it can be seen: the conversation it was meant for. */
    const putBack = () => {
      const into = source.id === DRAFT_CHAT && target !== source ? target : source;
      if (into.restoreDraft(taken) && sessionRef.current === into && !queued) setChoice(sentChoice);
    };
    setStartingSend(true);
    try {
      // A message written before any conversation exists creates one, whose session
      // is made empty and ready here, before it opens: it has no history to wait for.
      const chatId = await ensureActiveChatId(content || t("chatState.defaultChatTitle"), undefined, created => { sessionFor(created, () => makeSession(created, true)); });
      target = chatId === source.id ? source : keptSession(chatId) ?? sessionFor(chatId, () => makeSession(chatId)).session;
      const failed = await target.send(message, { body: { chatId, ...(sentChatModel ? { model: sentChatModel } : {}), mode: "chat" } }, { onStarted: () => setStartingSend(false) });
      if (failed) { putBack(); return; }
      await loadChats();
    } catch (submitError) {
      putBack();
      if (sessionRef.current === target || sessionRef.current === source) {
        setPageError(submitError instanceof HistoryUnavailableError ? t("chatState.sendContextLost") : submitError instanceof Error ? submitError.message : t("chatState.sendFailed"));
      }
    } finally {
      setStartingSend(false);
    }
  }

  // --- the message box, the queue, and message actions ------------------------------------------

  const composer = useComposer({
    session, draft, queue: state.queue, activeChatId,
    answeringThere: Boolean(activeChat?.answering), awaitingApprovalThere: Boolean(activeChat?.awaitingApproval), answeringHere: isAnsweringHere,
    isPending, isConversationReady, isHistoryReady: Boolean(confirmedChatId) && isHistoryReady, isDocumentScopeSaving, isUploadingAttachments,
    modelMode, choice, selectedModel, selectedModelInfo, appendAttachments, onSubmit, onStop,
  });
  const actions = useMessageActions({
    session, activeChatId, messages, setMessages, regenerate, isPending, isDocumentScopeSaving, selectedModel, sentChatModel, modelMode,
    generateImage, generateVideo, loadChats, performDeleteChat, setPageError, setSentWithoutModel, onStop,
  });

  // --- following what happens in the open conversation -----------------------------------------

  /*
   * An answer this page did not ask for (a task's run, another window, this page
   * before it was reloaded) is read as it is written: once the history is shown,
   * the session attaches to the turn the service is holding, from its start.
   */
  const [othersTurn, setOthersTurn] = useState(0);
  useEffect(() => {
    if (confirmedChatId && !startingSend) session.follow(Boolean(activeChat?.answering));
  }, [session, confirmedChatId, startingSend, activeChat?.answering, status, state.history, othersTurn]);
  const isWorkingRef = useRef(isWorking);
  isWorkingRef.current = isWorking;
  const confirmedRef = useRef(confirmedChatId);
  confirmedRef.current = confirmedChatId;
  /** Adds what was written to the open conversation since it was read: a task's run, another window. */
  const addNewTurns = useCallback(() => {
    const current = sessionRef.current;
    if (!confirmedRef.current || current.id !== confirmedRef.current || isWorkingRef.current) return;
    void current.addNewTurns();
  }, []);
  useRefreshOnReturn(addNewTurns);
  // A turn that ended without this page reading it (it attached too late, or not
  // at all) has its answer read from what was saved.
  const { onTurn } = useConversationStore();
  useEffect(() => onTurn(notice => {
    const current = sessionRef.current;
    if (notice.chatId !== confirmedRef.current || notice.chatId !== current.id || chatIsAnswering(current.chat)) return;
    if (notice.type === "turn-started") { current.othersTurnStarted(); setOthersTurn(count => count + 1); return; }
    if (notice.type === "turn-finished") addNewTurns();
  }), [onTurn, addNewTurns]);
  // Open and in view, what arrived in it has been read.
  const pageVisible = usePageVisible();
  const markingRead = useRef<string | null>(null);
  const { update: updateSummary } = useConversationStore();
  const historyShown = Boolean(confirmedChatId) && isHistoryReady;
  useEffect(() => {
    if (!historyShown || !confirmedChatId || !activeChat?.unread || !pageVisible || markingRead.current === confirmedChatId) return;
    const chatId = confirmedChatId;
    markingRead.current = chatId;
    void chatApi.markRead(chatId).then(saved => updateSummary(saved.data)).catch(() => { /* Still unread; tried again on the next change. */ })
      .finally(() => { if (markingRead.current === chatId) markingRead.current = null; });
  }, [historyShown, confirmedChatId, activeChat?.unread, pageVisible, updateSummary]);

  /*
   * Leaving a conversation while it answers leaves the answer to the service,
   * which goes on writing and saving it, and this window goes on reading it in
   * the background, so coming back shows it where it has got to.
   */
  async function switchActiveChat(nextChatId: string) {
    if (nextChatId === activeChatId) return;
    setActiveChatId(nextChatId);
  }
  const switchRef = useRef(switchActiveChat);
  useEffect(() => { switchRef.current = switchActiveChat; });
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
  useEffect(() => {
    if (status === "ready") void loadChats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function loadOlderMessages() {
    if (isPending || isLoadingHistory) return;
    const target = session;
    const { error: readError } = await target.loadOlder();
    if (readError && sessionRef.current === target) setPageError(readError instanceof Error ? readError.message : t("chatState.loadOlderFailed"));
  }

  function onModeSelect(value: ModelMode) {
    setSentWithoutModel(false);
    setInputNotice(null);
    setModelMode(value);
  }
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

  const setInput = useCallback((text: string | ((current: string) => string)) =>
    sessionRef.current.setDraft(current => ({ ...current, text: typeof text === "function" ? text(current.text) : text })), []);

  return {
    declineApprovals,
    toggleEphemeral, isEphemeralSaving, isDocumentScopeSaving, assistants, assistantsError, loadAssistants, applyAssistant,
    setWorkspace, isWorkspaceSaving, setApprovalRule, isApprovalSaving, loadChats,
    nextChatsCursor, isLoadingMoreChats, loadMoreChats, olderMessagesCursor: state.olderCursor, isLoadingOlderMessages: state.loadingOlder, loadOlderMessages,
    isLoadingChats, isCreatingChat, createNewChat, chats, activeChatId, switchActiveChat,
    requestDeleteConversation: actions.requestDeleteConversation,
    compaction: compaction?.chatId === activeChatId ? compaction : null,
    freedByCompaction: freedByCompaction?.chatId === activeChatId && freedByCompaction.lastMessageId === messages.at(-1)?.id ? freedByCompaction.tokens : 0,
    queuedMessages: composer.queuedMessages, queueHeldBy: composer.queueHeldBy, canQueue: composer.canQueue, queueMessage: composer.queueMessage, removeQueued: composer.removeQueued, editQueued: composer.editQueued,
    isOrganizing, turnNotice, isCompacting: compactingChatId !== null && compactingChatId === activeChatId, activeChat, isPending, isWorking, isLoadingPreferences, isOpeningConversation, isConversationReady, isConverting, modelMode, selectedModel, selectedModelInfo, defaultChatModel, onModeSelect,
    onModelSelect, modelHint, inputNotice, dismissInputNotice: () => setInputNotice(null), isModelMenuOpen, setIsModelMenuOpen, isHistoryReady: historyShown, isLoadingHistory, confirmedChatId, messages, imageByMessageId: state.images, videoByMessageId: state.videos,
    status, editingMessageId: actions.editingMessageId, startEditingMessage: actions.startEditingMessage, regenerateMessage: actions.regenerateMessage, requestDeleteMessage: actions.requestDeleteMessage,
    setEditingMessageText: actions.setEditingMessageText, editingMessageText: actions.editingMessageText, saveEditedMessage: actions.saveEditedMessage, cancelEditingMessage: actions.cancelEditingMessage,
    attachingImageKey, onReuseImageForEditing, reuseImageActionLabel, addToolApprovalResponse, onStop, onSubmit,
    removeAttachmentAt: (index: number) => { setInputNotice(null); removeAttachmentAt(index); }, isUploadingAttachments, isDraggingFiles: composer.isDraggingFiles, onComposerDragOver: composer.onComposerDragOver, onComposerDragLeave: composer.onComposerDragLeave, onComposerDrop: composer.onComposerDrop,
    tools, skills, choice, chooseTool, toggleSkill, removeLastChoice, removeTool, setToolDocument, setToolFormat, toolCatalogError: withoutGlobalEcho(toolCatalogError), loadToolCatalog,
    setInput, handleTextareaKeyDown: composer.handleTextareaKeyDown, onTextareaPaste: composer.onTextareaPaste,
    textareaRef, input: draft.text, onAttachmentInputChange, fileInputRef, attachments,
    clearAttachments, attachmentNames, selectedImageModel, selectedVideoModel,
    selectedChatModel, pendingDelete: actions.pendingDelete, isDeleting: actions.isDeleting, closeDeleteDialog: actions.closeDeleteDialog, confirmDelete: actions.confirmDelete,
    effectiveError, keyError, setPageError, clearError, clearPreferencesError, modelLibrary,
    panelVisibility, togglePanel,
  };
}
export type ChatState = ReturnType<typeof useChatState>;
