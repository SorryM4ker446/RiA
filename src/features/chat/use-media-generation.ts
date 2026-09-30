import { dedupeAttachmentNames, dedupeFiles, encodeImageMessage, encodeVideoMessage, type ModelMode, type UploadableFilePart } from "@/features/chat/page-utils";
import { encodePersistedUserMessage } from "@/lib/ai/ui-message";
import { t } from "@/lib/locale";
import { attachmentValidationError, MEDIA_LIMITS } from "@/lib/media/limits";
import type { UIMessage } from "ai";
import type { ModelRef } from "@/lib/models/preferences-schema";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { type ChangeEvent, type DragEvent, useCallback, useLayoutEffect, useRef, useState } from "react";
import { chatApi, filesToUploadParts, persistConversationMessage } from "@/features/chat/api-client";
import { attachmentLabel } from "@/features/chat/draft";

type MediaView = {
  chatId: string | null;
  ready: boolean;
  setMessages: Dispatch<SetStateAction<UIMessage[]>>;
  reloadMessages: (chatId: string) => Promise<void>;
};
type Options = {
  activeChatId: string | null;
  isHistoryReady: boolean;
  setMessages: MediaView["setMessages"];
  reloadMessages: MediaView["reloadMessages"];
  ensureActiveChatId: (title: string, shouldActivate?: () => boolean) => Promise<string>;
  loadChats: (options?: { silent?: boolean }) => Promise<void>;
  setPageError: Dispatch<SetStateAction<string | null>>;
  modelMode: ModelMode;
  selectedImageModel: ModelRef | null;
  selectedVideoModel: ModelRef | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

type GenerationOptions = Pick<Options, "ensureActiveChatId" | "loadChats" | "setPageError"> & {
  kind: "image" | "video";
  model: ModelRef | null;
  content: string;
  uploadParts: UploadableFilePart[];
  getView: () => MediaView;
  isOriginView: () => boolean;
  setAsset: (messageId: string, url: string) => void;
  clearAttachments: () => void;
  setGenerating: (generating: boolean) => void;
};

/**
 * How many attachment uploads are still running.
 *
 * The composer is locked while an upload is in flight, and a second attachment
 * can start before the first has finished. A boolean was not enough: whichever
 * upload returned first cleared the lock while the other was still running, so
 * the composer could be sent with an attachment that had not arrived.
 */
export function createUploadLock() {
  let inFlight = 0;
  return {
    begin() { inFlight += 1; },
    /** Whether the composer is free again, so it can stop being locked. */
    end() { inFlight = Math.max(0, inFlight - 1); return inFlight === 0; }
  };
}

export type UploadLock = ReturnType<typeof createUploadLock>;

export type AttachmentUploadOptions = {
  files: File[];
  modelMode: ModelMode;
  /** The names already in the composer, which the limits are counted against. */
  existingNames: string[];
  upload: (files: File[]) => Promise<UploadableFilePart[]>;
  setPageError: (error: string | null) => void;
  getVersion: () => number;
  /** The conversation on screen, for callers that can name it. */
  getConversationId?: () => string | null;
  commit: (uploaded: UploadableFilePart[]) => void;
  setUploading: (uploading: boolean) => void;
  lock: UploadLock;
};

/**
 * Uploading one batch of chosen files.
 *
 * Separate from React for the same reason `runMediaGeneration` is: the
 * interesting behaviour is what happens to a result that arrives after the
 * conversation on screen has changed, which a renderer cannot express.
 */
export async function runAttachmentUpload({ files, modelMode, existingNames, upload, setPageError, getVersion, getConversationId, commit, setUploading, lock }: AttachmentUploadOptions) {
  const combined = dedupeAttachmentNames([...existingNames, ...files.map((file) => file.name ?? "")]);
  const validation = attachmentValidationError(files) || (modelMode === "video" && combined.length > 1 ? t("mediaGen.videoReferenceLimit") : null);
  if (validation) { setPageError(validation); return; }
  if (existingNames.length + files.length > MEDIA_LIMITS.attachmentCount) { setPageError(t("mediaGen.videoReferenceLimit")); return; }
  const version = getVersion();
  const conversationId = getConversationId?.() ?? null;
  // A finished upload belongs to the conversation it was started in, so that is
  // what it is judged against — not a counter that only ever rises. Leaving a
  // conversation and coming back is not a different conversation: the reference
  // is still the user's and is still offered to them. Without an identity to
  // compare, the counter is all there is and it still decides.
  const isStillOurs = () => (getConversationId ? getConversationId() === conversationId : version === getVersion());
  lock.begin();
  setUploading(true);
  setPageError(null);
  try {
    const uploaded = await upload(files);
    if (!isStillOurs()) return;
    commit(uploaded);
  } catch (error) {
    if (isStillOurs()) setPageError(error instanceof Error ? error.message : t("chatApi.uploadAttachmentFailed"));
  } finally {
    // The lock describes the composer, not the conversation on screen. Tying its
    // release to the view version meant an upload that outlived a conversation
    // switch never released it, and the composer stayed disabled for the rest
    // of the session.
    if (lock.end()) setUploading(false);
  }
}

// The request owns its chat ID; only the currently committed view owns UI setters.
// Keep this operation separate from React so deferred network races are testable.
export async function runMediaGeneration({ kind, model, content, uploadParts, getView, isOriginView, ensureActiveChatId, loadChats, setPageError, setAsset, clearAttachments, setGenerating }: GenerationOptions) {
  if (!model) throw new Error(t("mediaGen.needModel"));
  const label = kind === "image" ? t("mediaGen.kindImage") : t("mediaGen.kindVideo");
  setGenerating(true);
  try {
    let chatId: string;
    try {
      chatId = await ensureActiveChatId(content || `${label}${t("mediaGen.defaultTitleSuffix")}`, isOriginView);
    } catch (error) {
      if (isOriginView()) setPageError(error instanceof Error ? error.message : t("chatApi.createConversationFailed"));
      return;
    }
    const userMessage: UIMessage = {
      id: crypto.randomUUID(), role: "user",
      parts: [...(content ? [{ type: "text" as const, text: content }] : []), ...uploadParts],
    };
    const assistantMessage: UIMessage = {
      id: crypto.randomUUID(), role: "assistant", parts: [{ type: "text", text: `${t("mediaGen.generatingPrefix")}${label}...` }],
    };
    function publish(text: string, url?: string) {
      const view = getView();
      if (view.chatId !== chatId || !view.ready) return;
      // History may have replaced the placeholder after A -> B -> A. Merge only
      // this request's messages, never replay the array captured when it started.
      view.setMessages((current) => {
        if (getView().chatId !== chatId) return current;
        const result = { ...assistantMessage, parts: [{ type: "text" as const, text }] };
        const withUser = current.some((message) => message.id === userMessage.id) ? current : [...current, userMessage];
        return withUser.some((message) => message.id === result.id)
          ? withUser.map((message) => message.id === result.id ? result : message)
          : [...withUser, result];
      });
      if (url) setAsset(assistantMessage.id, url);
    }
    publish(`${t("mediaGen.generatingPrefix")}${label}...`);
    try {
      await persistConversationMessage({
        chatId, role: "user", clientMessageId: userMessage.id,
        content: uploadParts.length ? encodePersistedUserMessage({ type: "user-message", text: content, files: uploadParts.map(({ url, mediaType, filename }) => ({ url, mediaType, ...(filename ? { filename } : {}) })) }) : content,
      });
      const payload = await chatApi.generateMedia(kind, content, model, uploadParts, chatId);
      const text = `${label}${t("mediaGen.completedSuffix")} · ${payload.modelId ?? model.modelId}`;
      const result = { assetId: payload.asset.assetId, relativePath: payload.asset.relativePath, mediaType: payload.asset.mediaType, modelId: payload.modelId ?? model.modelId, text };
      await persistConversationMessage({
        chatId, role: "assistant", clientMessageId: assistantMessage.id,
        content: kind === "image" ? encodeImageMessage({ ...result, type: "image-result" }) : encodeVideoMessage({ ...result, type: "video-result" }),
      });
      publish(text, payload.asset.url);
      // A draft can become a real SDK Chat while its first history fetch is in
      // flight. Restart that fetch after persistence so it cannot hide the result.
      const view = getView();
      if (view.chatId === chatId && !view.ready) await view.reloadMessages(chatId);
      await loadChats({ silent: true });
      if (isOriginView()) clearAttachments();
    } catch (error) {
      const text = `${label}${t("mediaGen.failedSuffix")}`;
      try {
        await persistConversationMessage({ chatId, role: "assistant", content: text, clientMessageId: assistantMessage.id, status: "error" });
        const view = getView();
        if (view.chatId === chatId && !view.ready) await view.reloadMessages(chatId);
        await loadChats({ silent: true });
      } catch {
        // Keep the failure visible even if persistence is unavailable.
      }
      publish(text);
      if (isOriginView()) setPageError(error instanceof Error ? error.message : `${label}${t("mediaGen.failedShortSuffix")}`);
    }
  } finally {
    setGenerating(false);
  }
}

/**
 * What the composer still holds once the turn that was just sent is finished.
 *
 * Only the references that were sent are removed. A media turn takes long enough
 * for the user to attach something else while it runs — the composer stays
 * usable throughout — and clearing everything would throw that away without a
 * word. A reference is identified by the asset it points at, so re-picking the
 * same picture yields a new one and is kept.
 */
export function remainingAttachments(current: UploadableFilePart[], sent: UploadableFilePart[]) {
  const sentUrls = new Set(sent.map((part) => part.url));
  return current.filter((part) => !sentUrls.has(part.url));
}

export function useMediaGeneration({ activeChatId, isHistoryReady, setMessages, reloadMessages, ensureActiveChatId, loadChats, setPageError, modelMode, selectedImageModel, selectedVideoModel, textareaRef }: Options) {
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [isGeneratingVideo, setIsGeneratingVideo] = useState(false);
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false);
  const [imageByMessageId, setImageByMessageId] = useState<Record<string, string>>({});
  const [videoByMessageId, setVideoByMessageId] = useState<Record<string, string>>({});
  // Attachments are stored as the reference the upload returned rather than as
  // the chosen file: a file cannot be recovered after a reload, a reference can.
  const [attachments, setAttachments] = useState<UploadableFilePart[]>([]);
  const [attachingImageKey, setAttachingImageKey] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<MediaView>({ chatId: activeChatId, ready: isHistoryReady, setMessages, reloadMessages });
  const viewVersionRef = useRef(0);
  const uploadLockRef = useRef(createUploadLock());
  useLayoutEffect(() => {
    if (viewRef.current.chatId !== activeChatId) viewVersionRef.current += 1;
    viewRef.current = { chatId: activeChatId, ready: isHistoryReady, setMessages, reloadMessages };
  });
  const attachmentNames = attachments.map(attachmentLabel);
  // Exposed so a restored draft can be applied without the composer remounting.
  const replaceAttachments = useCallback((next: UploadableFilePart[]) => setAttachments(next), []);
  const reuseImageActionLabel = modelMode === "image" ? t("mediaGen.reuseEdit") : modelMode === "chat" ? t("mediaGen.reuseAsk") : t("mediaGen.reuseVideoRef");
  function clearAttachments() {
    setAttachments([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }
  /** The composer is emptied of what a finished turn sent, and of nothing else. */
  function clearSentAttachments(sent: UploadableFilePart[]) {
    setAttachments((current) => remainingAttachments(current, sent));
    if (fileInputRef.current) fileInputRef.current.value = "";
  }
  /**
   * Uploads as soon as the file is chosen, so the draft only has to remember a
   * reference. A file that fails to upload is reported here rather than at send
   * time, when the rest of the message is already written.
   */
  function removeAttachmentAt(index: number) {
    setAttachments((current) => current.filter((_, position) => position !== index));
  }

  async function appendAttachments(nextFiles: File[]) {
    await runAttachmentUpload({
      files: nextFiles,
      modelMode,
      existingNames: attachments.map((part) => part.filename ?? ""),
      upload: filesToUploadParts,
      setPageError,
      getVersion: () => viewVersionRef.current,
      getConversationId: () => viewRef.current.chatId,
      commit: (uploaded) => setAttachments((current) => [...current, ...uploaded]),
      setUploading: setIsUploadingAttachments,
      lock: uploadLockRef.current
    });
  }
  async function onReuseImageForEditing(params: { imageUrl: string; key: string; filenameBase: string }) {
    const version = viewVersionRef.current;
    setPageError(null);
    setAttachingImageKey(params.key);
    try {
      const blob = await chatApi.readImage(params.imageUrl);
      if (version !== viewVersionRef.current) return;
      const mediaType = blob.type.startsWith("image/") ? blob.type : "image/png";
      const extension = mediaType.includes("jpeg") ? "jpg" : mediaType.includes("webp") ? "webp" : mediaType.includes("gif") ? "gif" : "png";
      appendAttachments([new File([blob], `${params.filenameBase}.${extension}`, { type: mediaType, lastModified: Date.now() })]);
      textareaRef.current?.focus();
    } catch (error) {
      if (version === viewVersionRef.current) setPageError(error instanceof Error ? error.message : t("mediaGen.attachImageFailed"));
    } finally {
      setAttachingImageKey((current) => current === params.key ? null : current);
    }
  }
  function onAttachmentInputChange(event: ChangeEvent<HTMLInputElement>) {
    appendAttachments(Array.from(event.target.files ?? []));
    event.currentTarget.value = "";
  }

  function generate(kind: "image" | "video", content: string, uploadParts: UploadableFilePart[]) {
    const version = viewVersionRef.current;
    return runMediaGeneration({
      kind, content, uploadParts, model: kind === "image" ? selectedImageModel : selectedVideoModel,
      getView: () => viewRef.current, isOriginView: () => version === viewVersionRef.current,
      ensureActiveChatId, loadChats, setPageError, clearAttachments: () => clearSentAttachments(uploadParts),
      setGenerating: kind === "image" ? setIsGeneratingImage : setIsGeneratingVideo,
      setAsset: (id, url) => (kind === "image" ? setImageByMessageId : setVideoByMessageId)((current) => ({ ...current, [id]: url })),
    });
  }
  return {
    isGeneratingImage, isGeneratingVideo, isUploadingAttachments, setIsUploadingAttachments,
    imageByMessageId, setImageByMessageId, videoByMessageId, setVideoByMessageId, attachments, replaceAttachments,
    attachingImageKey, fileInputRef, attachmentNames, reuseImageActionLabel, clearAttachments, removeAttachmentAt,
    appendAttachments, onReuseImageForEditing, onAttachmentInputChange,
    generateImage: (content: string, uploadParts: UploadableFilePart[]) => generate("image", content, uploadParts),
    generateVideo: (content: string, uploadParts: UploadableFilePart[]) => generate("video", content, uploadParts),
  };
}
