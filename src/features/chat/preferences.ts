import { ModelMode } from "@/features/chat/page-utils";
import { t } from "@/lib/locale";
import type { ChatScopedPreferences, ManualToolSelection } from "@/features/chat/types";
import { CHAT_PREFS_STORAGE_PREFIX } from "@/features/chat/types";
import { settingsRequest } from "@/features/settings/api-client";
import { modelRefKey, providerIds, type ModelLibraryItem, type ModelPreferences, type ModelRef } from "@/lib/models/preferences-schema";

export async function loadAccountChatDefaults(): Promise<{ preferences: ChatScopedPreferences; library: ModelLibraryItem[] }> {
  const { data } = await settingsRequest<{ data: ModelPreferences }>("/api/models");
  return {
    preferences: { modelMode: data.defaultMode, selectedChatModel: data.chat.model, selectedImageModel: data.image.model, selectedVideoModel: data.video.model, selectedManualTool: "none", manualToolsOnly: false },
    library: data.library,
  };
}
export function staleChatModelWarning(chatId: string, library: ModelLibraryItem[]) {
  try {
    const raw = JSON.parse(window.localStorage.getItem(getChatPrefsStorageKey(chatId)) || "null");
    if (raw && [["chat", "selectedChatModel"], ["image", "selectedImageModel"], ["video", "selectedVideoModel"]].some(([mode, key]) => {
      const saved = readStoredModelRef(raw[key]);
      return saved && !library.some(item => item.providerId === saved.providerId && item.modelId === saved.modelId && item.modes.includes(mode as ModelMode));
    })) return t("chatPrefs.staleModelWarning");
  } catch { /* Malformed local preferences are ignored. */ }
  return null;
}

export function getDefaultChatPreferences(): ChatScopedPreferences {
  return { modelMode: "chat", selectedChatModel: null, selectedImageModel: null, selectedVideoModel: null, selectedManualTool: "none", manualToolsOnly: false };
}

export function getChatPrefsStorageKey(chatId: string): string { return `${CHAT_PREFS_STORAGE_PREFIX}${chatId}`; }

/**
 * A stored selection is a provider plus a model id. Entries written before that
 * distinction existed were a bare id, always OpenRouter, and are read that way
 * rather than discarded — the user's saved choice should not evaporate on an
 * upgrade that did not change which provider it used.
 */
function readStoredModelRef(value: unknown): ModelRef | null {
  if (typeof value === "string" && value.length <= 200) return { providerId: "openrouter", modelId: value };
  if (value && typeof value === "object" && "providerId" in value && "modelId" in value) {
    const candidate = value as { providerId?: unknown; modelId?: unknown };
    if (typeof candidate.providerId === "string" && typeof candidate.modelId === "string" && candidate.modelId.length <= 200) {
      return { providerId: candidate.providerId as ModelRef["providerId"], modelId: candidate.modelId };
    }
  }
  return null;
}

export function modelRefValue(ref: ModelRef | null): string {
  return ref ? modelRefKey(ref) : "";
}

export function parseModelRefValue(value: string): ModelRef | null {
  const [providerId, ...rest] = value.split(":");
  const modelId = rest.join(":");
  if (!providerId || !modelId) return null;
  const match = (providerIds as readonly string[]).includes(providerId) && modelId.length <= 200 ? { providerId, modelId } as ModelRef : null;
  return match;
}

export function readChatPreferences(chatId: string): ChatScopedPreferences | null {
  const raw = window.localStorage.getItem(getChatPrefsStorageKey(chatId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ChatScopedPreferences>;
    const modelMode: ModelMode = parsed.modelMode === "chat" || parsed.modelMode === "image" || parsed.modelMode === "video" ? parsed.modelMode : "chat";
    const selectedManualTool: ManualToolSelection = typeof parsed.selectedManualTool === "string" && parsed.selectedManualTool.trim() ? parsed.selectedManualTool : "none";
    return { modelMode, selectedChatModel: readStoredModelRef(parsed.selectedChatModel), selectedImageModel: readStoredModelRef(parsed.selectedImageModel), selectedVideoModel: readStoredModelRef(parsed.selectedVideoModel), selectedManualTool, manualToolsOnly: parsed.manualToolsOnly === true };
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
