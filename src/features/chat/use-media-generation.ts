import {
  type SupportedImageModelId,
  type SupportedVideoModelId
} from "@/config/model";
import {
  dedupeFiles,
  encodeImageMessage,
  encodeVideoMessage,
  ModelMode,
  UploadableFilePart
} from "@/features/chat/page-utils";
import { encodePersistedUserMessage } from "@/lib/ai/ui-message";
import { attachmentValidationError } from "@/lib/media/limits";
import { UIMessage } from "ai";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { ChangeEvent, useRef, useState } from "react";
import { chatApi, persistConversationMessage } from "@/features/chat/api-client";
type Options = { messages: UIMessage[]; setMessages: Dispatch<SetStateAction<UIMessage[]>>; ensureActiveChatId: (title: string) => Promise<string>; loadChats: () => Promise<void>; setPageError: Dispatch<SetStateAction<string | null>>; modelMode: ModelMode; selectedImageModel: SupportedImageModelId; selectedVideoModel: SupportedVideoModelId; textareaRef: RefObject<HTMLTextAreaElement | null>; };
export function useMediaGeneration({ messages, setMessages, ensureActiveChatId, loadChats, setPageError, modelMode, selectedImageModel, selectedVideoModel, textareaRef }: Options) {
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [isGeneratingVideo, setIsGeneratingVideo] = useState(false);
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false);
  const [imageByMessageId, setImageByMessageId] = useState<Record<string, string>>({});
  const [videoByMessageId, setVideoByMessageId] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachingImageKey, setAttachingImageKey] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentNames = attachments.map((file) => file.name || "未命名文件");
  const reuseImageActionLabel =
    modelMode === "image" ? "继续编辑" : modelMode === "chat" ? "带图追问" : "用作视频参考";
  function clearAttachments() {
    setAttachments([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function appendAttachments(nextFiles: File[]) {
    const combined = dedupeFiles([...attachments, ...nextFiles]);
    const validation = attachmentValidationError(combined) || (modelMode === "video" && combined.length > 1 ? "视频生成最多使用 1 个参考图。" : null);
    if (validation) { setPageError(validation); return; }
    setAttachments(combined);
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
      const blob = await chatApi.readImage(params.imageUrl);
      const mediaType = blob.type.startsWith("image/") ? blob.type : "image/png";
      const extension = extensionFromImageType(mediaType);
      const fileName = `${params.filenameBase}.${extension}`;
      const file = new File([blob], fileName, {
        type: mediaType,
        lastModified: Date.now(),
      });

      appendAttachments([file]);
      textareaRef.current?.focus();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "加入图片附件失败");
    } finally {
      setAttachingImageKey(null);
    }
  }

  function onAttachmentInputChange(event: ChangeEvent<HTMLInputElement>) {
    appendAttachments(Array.from(event.target.files ?? []));
    event.currentTarget.value = "";
  }
  async function generateImage(content: string, uploadParts: UploadableFilePart[]) {
    const hasContent = content.length > 0;

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

      const payload = await chatApi.generateMedia("image", content, selectedImageModel, uploadParts, chatId);
      setImageByMessageId((prev) => ({
        ...prev,
        [assistantMessageId]: payload.asset!.url,
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
          assetId: payload.asset.assetId,
          relativePath: payload.asset.relativePath,
          mediaType: payload.asset.mediaType,
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

  }
  async function generateVideo(content: string, uploadParts: UploadableFilePart[]) {
    const hasContent = content.length > 0;

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

      const payload = await chatApi.generateMedia("video", content, selectedVideoModel, uploadParts, chatId);
      setVideoByMessageId((prev) => ({
        ...prev,
        [assistantMessageId]: payload.asset!.url,
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
          assetId: payload.asset.assetId,
          relativePath: payload.asset.relativePath,
          mediaType: payload.asset.mediaType,
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

  }
  return {
    isGeneratingImage, isGeneratingVideo, isUploadingAttachments, setIsUploadingAttachments,
    imageByMessageId, setImageByMessageId, videoByMessageId, setVideoByMessageId, attachments,
    attachingImageKey, fileInputRef, attachmentNames, reuseImageActionLabel, clearAttachments,
    appendAttachments, onReuseImageForEditing, onAttachmentInputChange, generateImage, generateVideo,
  };
}
