import { ModelMode } from "@/features/chat/page-utils";
import { t } from "@/lib/locale";
import type { ChatScopedPreferences, ManualToolSelection } from "@/features/chat/types";
import { CHAT_PREFS_STORAGE_PREFIX } from "@/features/chat/types";
import { settingsRequest } from "@/features/settings/api-client";
import type { ModelLibraryItem, ModelPreferences } from "@/lib/models/preferences-schema";

export async function loadAccountChatDefaults(): Promise<{ preferences: ChatScopedPreferences; library: ModelLibraryItem[] }> {
  const { data } = await settingsRequest<{ data: ModelPreferences }>("/api/models");
  return {
    preferences: { modelMode: data.defaultMode, selectedChatModel: data.chat.modelId, selectedImageModel: data.image.modelId, selectedVideoModel: data.video.modelId, selectedManualTool: "none", manualToolsOnly: false },
    library: data.library,
  };
}
export function staleChatModelWarning(chatId: string, library: ModelLibraryItem[]) {
  try {
    const raw = JSON.parse(window.localStorage.getItem(getChatPrefsStorageKey(chatId)) || "null");
    if (raw && [["chat", "selectedChatModel"], ["image", "selectedImageModel"], ["video", "selectedVideoModel"]].some(([mode, key]) => raw[key] && !library.some(item => item.modelId === raw[key] && item.modes.includes(mode as ModelMode)))) return t("chatPrefs.staleModelWarning");
  } catch { /* Malformed local preferences are ignored. */ }
  return null;
}

export function getDefaultChatPreferences(): ChatScopedPreferences {
  return { modelMode: "chat", selectedChatModel: null, selectedImageModel: null, selectedVideoModel: null, selectedManualTool: "none", manualToolsOnly: false };
}

export function getChatPrefsStorageKey(chatId: string): string { return `${CHAT_PREFS_STORAGE_PREFIX}${chatId}`; }

export function readChatPreferences(chatId: string): ChatScopedPreferences | null {
  const raw = window.localStorage.getItem(getChatPrefsStorageKey(chatId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ChatScopedPreferences>;
    const modelMode: ModelMode = parsed.modelMode === "chat" || parsed.modelMode === "image" || parsed.modelMode === "video" ? parsed.modelMode : "chat";
    const selectedManualTool: ManualToolSelection = typeof parsed.selectedManualTool === "string" && parsed.selectedManualTool.trim() ? parsed.selectedManualTool : "none";
    const id = (value: unknown) => typeof value === "string" && value.length <= 200 ? value : null;
    return { modelMode, selectedChatModel: id(parsed.selectedChatModel), selectedImageModel: id(parsed.selectedImageModel), selectedVideoModel: id(parsed.selectedVideoModel), selectedManualTool, manualToolsOnly: parsed.manualToolsOnly === true };
  } catch { return null; }
}

/**
 * Side-rail visibility is a workspace-level preference, not a per-conversation
 * one: collapsing the task list to read a message should not reset the next
 * time the user opens a different conversation.
 */
const PANEL_VISIBILITY_STORAGE_KEY = "private-ai.chat.panel-visibility";

export type PanelVisibility = { conversations: boolean; tasks: boolean };

export function readPanelVisibility(): PanelVisibility {
  if (typeof window === "undefined") return { conversations: true, tasks: true };
  try {
    const raw = JSON.parse(window.localStorage.getItem(PANEL_VISIBILITY_STORAGE_KEY) || "null");
    if (raw && typeof raw === "object") {
      return {
        conversations: raw.conversations !== false,
        tasks: raw.tasks !== false,
      };
    }
  } catch {
    // A corrupt entry just falls back to both panels open.
  }
  return { conversations: true, tasks: true };
}

export function writePanelVisibility(value: PanelVisibility): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PANEL_VISIBILITY_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Private-mode storage refusals must not break the toggle itself.
  }
}
