import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MODEL,
  DEFAULT_VIDEO_MODEL,
  resolveImageModelId,
  resolveModelId,
  resolveVideoModelId
} from "@/config/model";
import { ModelMode } from "@/features/chat/page-utils";
import type { ChatScopedPreferences, ManualToolSelection } from "@/features/chat/types";
import { CHAT_PREFS_STORAGE_PREFIX } from "@/features/chat/types";
import { settingsRequest } from "@/features/settings/api-client";
import { availableModel, modelModes, type ModelPreferences } from "@/lib/models/preferences-schema";

export async function loadAccountChatDefaults(): Promise<ChatScopedPreferences> {
  const { data } = await settingsRequest<{ data: ModelPreferences }>("/api/models");
  if (modelModes.some(mode => !availableModel(mode, data[mode].modelId))) throw new Error("保存的默认模型已失效，请前往“模型与用量”重新选择。");
  return { ...getDefaultChatPreferences(), modelMode: data.defaultMode, selectedChatModel: resolveModelId(data.chat.modelId), selectedImageModel: resolveImageModelId(data.image.modelId), selectedVideoModel: resolveVideoModelId(data.video.modelId) };
}
export function staleChatModelWarning(chatId: string) {
  try {
    const raw = JSON.parse(window.localStorage.getItem(getChatPrefsStorageKey(chatId)) || "null");
    if (raw && [["chat", "selectedChatModel"], ["image", "selectedImageModel"], ["video", "selectedVideoModel"]].some(([mode, key]) => raw[key] && !availableModel(mode as "chat" | "image" | "video", raw[key]))) return "此会话保存的旧模型已失效，请确认当前模型选择。";
  } catch { /* Malformed local preferences retain the existing default behavior. */ }
  return null;
}

export function getDefaultChatPreferences(): ChatScopedPreferences {
  return {
    modelMode: "chat",
    selectedChatModel: DEFAULT_MODEL,
    selectedImageModel: DEFAULT_IMAGE_MODEL,
    selectedVideoModel: DEFAULT_VIDEO_MODEL,
    selectedManualTool: "none",
    manualToolsOnly: false,
  };
}

export function getChatPrefsStorageKey(chatId: string): string {
  return `${CHAT_PREFS_STORAGE_PREFIX}${chatId}`;
}

export function readChatPreferences(chatId: string): ChatScopedPreferences | null {
  const raw = window.localStorage.getItem(getChatPrefsStorageKey(chatId));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<ChatScopedPreferences>;
    const modelMode: ModelMode =
      parsed.modelMode === "chat" || parsed.modelMode === "image" || parsed.modelMode === "video"
        ? parsed.modelMode
        : "chat";

    const selectedManualTool: ManualToolSelection =
      typeof parsed.selectedManualTool === "string" && parsed.selectedManualTool.trim()
        ? parsed.selectedManualTool
        : "none";

    return {
      modelMode,
      selectedChatModel: resolveModelId(parsed.selectedChatModel),
      selectedImageModel: resolveImageModelId(parsed.selectedImageModel),
      selectedVideoModel: resolveVideoModelId(parsed.selectedVideoModel),
      selectedManualTool,
      manualToolsOnly: parsed.manualToolsOnly === true,
    };
  } catch {
    return null;
  }
}
