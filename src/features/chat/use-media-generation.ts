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
  /**
   * Uploads as soon as the file is chosen, so the draft only has to remember a
   * reference. A file that fails to upload is reported here rather than at send
   * time, when the rest of the message is already written.
   */
  function removeAttachmentAt(index: number) {
    setAttachments((current) => current.filter((_, position) => position !== index));
  }

  async function appendAttachments(nextFiles: File[]) {
    const combined = dedupeAttachmentNames([...attachments.map((part) => part.filename ?? ""), ...nextFiles.map((file) => file.name ?? "")]);
    const validation = attachmentValidationError(nextFiles) || (modelMode === "video" && combined.length > 1 ? t("mediaGen.videoReferenceLimit") : null);
    if (validation) { setPageError(validation); return; }
    if (attachments.length + nextFiles.length > MEDIA_LIMITS.attachmentCount) { setPageError(t("mediaGen.videoReferenceLimit")); return; }
    const version = viewVersionRef.current;
    setIsUploadingAttachments(true);
    setPageError(null);
    try {
      const uploaded = await filesToUploadParts(nextFiles);
      if (version !== viewVersionRef.current) return;
      setAttachments((current) => [...current, ...uploaded]);
    } catch (error) {
      if (version === viewVersionRef.current) setPageError(error instanceof Error ? error.message : t("chatApi.uploadAttachmentFailed"));
    } finally {
      if (version === viewVersionRef.current) setIsUploadingAttachments(false);
    }
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
      ensureActiveChatId, loadChats, setPageError, clearAttachments,
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
