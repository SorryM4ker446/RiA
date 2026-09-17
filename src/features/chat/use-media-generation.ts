import { type SupportedImageModelId, type SupportedVideoModelId } from "@/config/model";
import { dedupeFiles, encodeImageMessage, encodeVideoMessage, type ModelMode, type UploadableFilePart } from "@/features/chat/page-utils";
import { encodePersistedUserMessage } from "@/lib/ai/ui-message";
import { attachmentValidationError } from "@/lib/media/limits";
import type { UIMessage } from "ai";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { type ChangeEvent, useLayoutEffect, useRef, useState } from "react";
import { chatApi, persistConversationMessage } from "@/features/chat/api-client";

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
  selectedImageModel: SupportedImageModelId;
  selectedVideoModel: SupportedVideoModelId;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

type GenerationOptions = Pick<Options, "ensureActiveChatId" | "loadChats" | "setPageError"> & {
  kind: "image" | "video";
  modelId: string;
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
export async function runMediaGeneration({ kind, modelId, content, uploadParts, getView, isOriginView, ensureActiveChatId, loadChats, setPageError, setAsset, clearAttachments, setGenerating }: GenerationOptions) {
  const label = kind === "image" ? "图片" : "视频";
  setGenerating(true);
  try {
    let chatId: string;
    try {
      chatId = await ensureActiveChatId(content || `${label}生成`, isOriginView);
    } catch (error) {
      if (isOriginView()) setPageError(error instanceof Error ? error.message : "创建会话失败");
      return;
    }
    const userMessage: UIMessage = {
      id: crypto.randomUUID(), role: "user",
      parts: [...(content ? [{ type: "text" as const, text: content }] : []), ...uploadParts],
    };
    const assistantMessage: UIMessage = {
      id: crypto.randomUUID(), role: "assistant", parts: [{ type: "text", text: `正在生成${label}...` }],
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
    publish(`正在生成${label}...`);
    try {
      await persistConversationMessage({
        chatId, role: "user", clientMessageId: userMessage.id,
        content: uploadParts.length ? encodePersistedUserMessage({ type: "user-message", text: content, files: uploadParts.map(({ url, mediaType, filename }) => ({ url, mediaType, ...(filename ? { filename } : {}) })) }) : content,
      });
      const payload = await chatApi.generateMedia(kind, content, modelId, uploadParts, chatId);
      const text = `${label}生成完成 · ${payload.modelId ?? modelId}`;
      const result = { assetId: payload.asset.assetId, relativePath: payload.asset.relativePath, mediaType: payload.asset.mediaType, modelId: payload.modelId ?? modelId, text };
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
      const text = `${label}生成失败，请稍后重试。`;
      try {
        await persistConversationMessage({ chatId, role: "assistant", content: text, clientMessageId: assistantMessage.id, status: "error" });
        const view = getView();
        if (view.chatId === chatId && !view.ready) await view.reloadMessages(chatId);
        await loadChats({ silent: true });
      } catch {
        // Keep the failure visible even if persistence is unavailable.
      }
      publish(text);
      if (isOriginView()) setPageError(error instanceof Error ? error.message : `${label}生成失败`);
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
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachingImageKey, setAttachingImageKey] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<MediaView>({ chatId: activeChatId, ready: isHistoryReady, setMessages, reloadMessages });
  const viewVersionRef = useRef(0);
  useLayoutEffect(() => {
    if (viewRef.current.chatId !== activeChatId) viewVersionRef.current += 1;
    viewRef.current = { chatId: activeChatId, ready: isHistoryReady, setMessages, reloadMessages };
  });
  const attachmentNames = attachments.map((file) => file.name || "未命名文件");
  const reuseImageActionLabel = modelMode === "image" ? "继续编辑" : modelMode === "chat" ? "带图追问" : "用作视频参考";
  function clearAttachments() {
    setAttachments([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }
  function appendAttachments(nextFiles: File[]) {
    const combined = dedupeFiles([...attachments, ...nextFiles]);
    const validation = attachmentValidationError(combined) || (modelMode === "video" && combined.length > 1 ? "视频生成最多使用 1 个参考图。" : null);
    if (validation) { setPageError(validation); return; }
    setAttachments(combined);
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
      if (version === viewVersionRef.current) setPageError(error instanceof Error ? error.message : "加入图片附件失败");
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
      kind, content, uploadParts, modelId: kind === "image" ? selectedImageModel : selectedVideoModel,
      getView: () => viewRef.current, isOriginView: () => version === viewVersionRef.current,
      ensureActiveChatId, loadChats, setPageError, clearAttachments,
      setGenerating: kind === "image" ? setIsGeneratingImage : setIsGeneratingVideo,
      setAsset: (id, url) => (kind === "image" ? setImageByMessageId : setVideoByMessageId)((current) => ({ ...current, [id]: url })),
    });
  }
  return {
    isGeneratingImage, isGeneratingVideo, isUploadingAttachments, setIsUploadingAttachments,
    imageByMessageId, setImageByMessageId, videoByMessageId, setVideoByMessageId, attachments,
    attachingImageKey, fileInputRef, attachmentNames, reuseImageActionLabel, clearAttachments,
    appendAttachments, onReuseImageForEditing, onAttachmentInputChange,
    generateImage: (content: string, uploadParts: UploadableFilePart[]) => generate("image", content, uploadParts),
    generateVideo: (content: string, uploadParts: UploadableFilePart[]) => generate("video", content, uploadParts),
  };
}
