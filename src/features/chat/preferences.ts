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
