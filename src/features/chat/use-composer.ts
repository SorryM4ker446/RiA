import { type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { MessageKey } from "@/lib/locale/zh-CN";
import type { ModelLibraryItem, ModelRef } from "@/lib/models/preferences-schema";
import type { ModelMode, UploadableFilePart } from "@/features/chat/page-utils";
import type { ComposerChoice } from "@/features/chat/use-tools";
import { MAX_QUEUED, type ComposerDraft, type ConversationSession, type QueuedMessage } from "@/features/chat/conversation-session";

type Options = {
  session: ConversationSession;
  draft: ComposerDraft;
  queue: QueuedMessage[];
  activeChatId: string | null;
  /** The service's word on the open conversation. */
  answeringThere: boolean;
  awaitingApprovalThere: boolean;
  /** This page is answering or making something in it. */
  answeringHere: boolean;
  isPending: boolean;
  isConversationReady: boolean;
  isHistoryReady: boolean;
  isDocumentScopeSaving: boolean;
  isUploadingAttachments: boolean;
  modelMode: ModelMode;
  choice: ComposerChoice;
  selectedModel: ModelRef | null;
  selectedModelInfo: ModelLibraryItem | undefined;
  appendAttachments: (files: File[]) => void | Promise<void>;
  onSubmit: (event?: FormEvent<HTMLFormElement>, queued?: QueuedMessage) => Promise<void>;
  onStop: () => void;
};

/**
 * The message box: typing, pasting and dropping files into it, and the messages
 * queued behind an answer.
 *
 * Messages written while the conversation is still answering wait in its
 * session's queue, in order, and are sent one by one once it is free: not
 * answering, here or elsewhere, and not waiting for an approval. The queue is
 * kept in this browser like the drafts. A queued message carries its text and
 * its already-uploaded attachments; a tool or skill choice is not queued.
 */
export function useComposer(options: Options) {
  const { session, draft, queue, activeChatId, isPending, isConversationReady, modelMode, choice, selectedModel, selectedModelInfo } = options;
  const conversationBusy = options.answeringHere || options.answeringThere;
  const canQueue = Boolean(activeChatId) && isConversationReady && conversationBusy && modelMode === "chat" && !choice.tool && !choice.skills.length
    && !options.isUploadingAttachments && (draft.text.trim().length > 0 || draft.attachments.length > 0) && queue.length < MAX_QUEUED;

  function queueMessage() {
    if (!canQueue) return;
    const taken = session.takeDraft();
    session.setQueue(current => [...current, { id: crypto.randomUUID(), text: taken.text.trim(), attachments: [...taken.attachments] }]);
  }
  function removeQueued(id: string) { session.setQueue(current => current.filter(item => item.id !== id)); }
  /** Back into the message box to change, out of the queue. Only into an empty box, so nothing typed is lost. */
  function editQueued(id: string) {
    const item = queue.find(entry => entry.id === id);
    if (!item || session.hasDraft) return;
    removeQueued(id);
    session.setDraft({ text: item.text, attachments: item.attachments });
  }

  // What sending would refuse keeps the next message queued, where it can be
  // changed or removed, and the queue says why instead of seeming stuck.
  const nextQueued = queue[0];
  const queueHeldBy: { key: MessageKey; values?: Record<string, string> } | null = !nextQueued || modelMode !== "chat" ? null
    : !selectedModel ? { key: "chat.queue.heldNoModel" }
    : nextQueued.attachments.some((part: UploadableFilePart) => part.mediaType.startsWith("image/")) && !selectedModelInfo?.supportsImageInput
      ? { key: "chat.queue.heldNoImages", values: { modelId: selectedModel.modelId } }
      : null;
  const queueHeld = queueHeldBy !== null;
  // The next queued message goes once the conversation is free. It leaves the
  // queue only once it is actually on its way (sending takes it out).
  const sendNext = useRef(options.onSubmit);
  useEffect(() => { sendNext.current = options.onSubmit; });
  useEffect(() => {
    if (!activeChatId || !nextQueued || queueHeld || isPending || options.isDocumentScopeSaving || options.answeringThere || options.awaitingApprovalThere || !isConversationReady || !options.isHistoryReady || modelMode !== "chat") return;
    void sendNext.current(undefined, nextQueued);
  }, [activeChatId, nextQueued, queueHeld, isPending, options.isDocumentScopeSaving, options.answeringThere, options.awaitingApprovalThere, isConversationReady, options.isHistoryReady, modelMode]);

  /**
   * Dropping a file on the composer attaches it the same way choosing it does.
   * The drag only counts when it actually carries files, so dragging selected
   * text does not light up the whole composer.
   */
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
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
    void options.appendAttachments(files);
  }
  function onTextareaPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pastedFiles = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (pastedFiles.length === 0) return;
    event.preventDefault();
    void options.appendAttachments(pastedFiles);
  }

  function handleTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Escape in the message box stops a running answer; with Shift it is the
    // "focus the message box" shortcut, which is already satisfied here.
    if (event.key === "Escape" && !event.shiftKey && isPending) {
      event.preventDefault();
      options.onStop();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canQueue) { queueMessage(); return; }
      if (isPending || !isConversationReady) return;
      if (!draft.text.trim() && !draft.attachments.length && !choice.document) return;
      void options.onSubmit(event as unknown as FormEvent<HTMLFormElement>);
    }
  }

  return {
    queuedMessages: queue, queueHeldBy, canQueue, queueMessage, removeQueued, editQueued,
    isDraggingFiles, onComposerDragOver, onComposerDragLeave, onComposerDrop, onTextareaPaste, handleTextareaKeyDown,
  };
}
