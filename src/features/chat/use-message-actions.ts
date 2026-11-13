import type { UIMessage } from "ai";
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { t } from "@/lib/locale";
import { encodePersistedUserMessage } from "@/lib/ai/ui-message";
import { readMessageInvocation } from "@/lib/chat/invocation-schema";
import { animateRemoval } from "@/lib/ui/removal";
import type { ModelRef } from "@/lib/models/preferences-schema";
import { chatApi } from "@/features/chat/api-client";
import { hasLaterUserMessage, readText, type ChatSummary, type ModelMode, type UploadableFilePart } from "@/features/chat/page-utils";
import type { DeleteTarget } from "@/features/chat/types";
import { HistoryUnavailableError, type ConversationSession } from "@/features/chat/conversation-session";

type Options = {
  session: ConversationSession;
  activeChatId: string | null;
  messages: UIMessage[];
  setMessages: (messages: UIMessage[] | ((current: UIMessage[]) => UIMessage[])) => void;
  regenerate: (options: { messageId: string; body: Record<string, unknown> }) => Promise<void>;
  isPending: boolean;
  isDocumentScopeSaving: boolean;
  selectedModel: ModelRef | null;
  sentChatModel: ModelRef | null;
  modelMode: ModelMode;
  generateImage: (content: string, uploadParts: UploadableFilePart[]) => Promise<void>;
  generateVideo: (content: string, uploadParts: UploadableFilePart[]) => Promise<void>;
  loadChats: () => Promise<void>;
  performDeleteChat: (chatId: string) => Promise<void>;
  setPageError: Dispatch<SetStateAction<string | null>>;
  setSentWithoutModel: (value: boolean) => void;
  onStop: () => void;
};

/** Editing, answering again and deleting messages, and deleting conversations, with the dialog that confirms it. */
export function useMessageActions(options: Options) {
  const { session, activeChatId, messages, setMessages, isPending, isDocumentScopeSaving, setPageError } = options;
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingMessageText, setEditingMessageText] = useState("");
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

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
    setMessages((current) => current.map((item) => item.id === message.id ? { ...item, parts: [{ type: "text", text: nextText }] } : item));
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
    if (!options.selectedModel) { options.setSentWithoutModel(true); return; }
    setEditingMessageId(null);
    setEditingMessageText("");
    setPageError(null);
    if (options.modelMode === "image") { await options.generateImage(text, []); return; }
    if (options.modelMode === "video") { await options.generateVideo(text, []); return; }
    const invocation = readMessageInvocation(message.metadata);
    const restore = () => { setEditingMessageId(message.id); setEditingMessageText(text); };
    try {
      const failed = await session.send(
        { id: crypto.randomUUID(), role: "user", metadata: { ...(invocation ? { invocation } : {}), createdAt: new Date().toISOString() }, parts: [{ type: "text", text }] },
        { body: { chatId, ...(options.sentChatModel ? { model: options.sentChatModel } : {}), mode: "chat" } },
      );
      if (failed) restore(); else await options.loadChats();
    } catch (sendError) {
      restore();
      setPageError(sendError instanceof HistoryUnavailableError ? t("chatState.sendContextLost") : sendError instanceof Error ? sendError.message : t("chatState.sendFailed"));
    }
  }

  async function regenerateMessage(messageId: string) {
    if (isPending || isDocumentScopeSaving || !activeChatId) return;
    setPageError(null);
    try {
      // The chat client keeps the transport it was made with, so the current
      // preferences travel with the request itself.
      await options.regenerate({ messageId, body: { chatId: activeChatId, ...(options.sentChatModel ? { model: options.sentChatModel } : {}), mode: options.modelMode } });
      await options.loadChats();
    } catch (regenerateError) {
      setPageError(regenerateError instanceof Error ? regenerateError.message : t("chatState.regenerateFailed"));
    }
  }

  function requestDeleteConversation(chat: ChatSummary) { setPendingDelete({ kind: "chat", chat }); }
  function requestDeleteMessage(message: UIMessage) { setPendingDelete({ kind: "message", message }); }
  function closeDeleteDialog() { if (!isDeleting) setPendingDelete(null); }

  async function performDeleteMessage(messageId: string) {
    if (!activeChatId) return;
    const previous = messages;
    await animateRemoval(messageId, () => setMessages((current) => current.filter((message) => message.id !== messageId)));
    try {
      await chatApi.deleteMessage(activeChatId, messageId);
      await options.loadChats();
    } catch (deleteError) {
      setMessages(previous);
      throw deleteError;
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setPageError(null);
    setIsDeleting(true);
    try {
      if (pendingDelete.kind === "chat") await options.performDeleteChat(pendingDelete.chat.id);
      else await performDeleteMessage(pendingDelete.message.id);
    } catch (deleteError) {
      setPageError(deleteError instanceof Error ? deleteError.message : t("chatState.deleteFailed"));
    } finally {
      setIsDeleting(false);
      setPendingDelete(null);
    }
  }

  const { onStop } = options;
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
    editingMessageId, editingMessageText, setEditingMessageText, startEditingMessage, cancelEditingMessage, saveEditedMessage, regenerateMessage,
    pendingDelete, isDeleting, requestDeleteConversation, requestDeleteMessage, closeDeleteDialog, confirmDelete,
  };
}
