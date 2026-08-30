import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MODEL,
  DEFAULT_VIDEO_MODEL,
  resolveImageModelId,
  resolveModelId,
  resolveVideoModelId,
  type SupportedImageModelId,
  type SupportedModelId,
  type SupportedVideoModelId
} from "@/config/model";
import { ModelMode } from "@/features/chat/page-utils";
import { useEffect, useState } from "react";
import { getChatPrefsStorageKey, getDefaultChatPreferences, readChatPreferences } from "@/features/chat/preferences";
import type { ChatScopedPreferences, ManualToolSelection } from "@/features/chat/types";

export function useChatPreferences(activeChatId: string | null) {
  const [modelMode, setModelMode] = useState<ModelMode>("chat");
  const [selectedChatModel, setSelectedChatModel] = useState<SupportedModelId>(DEFAULT_MODEL);
  const [selectedImageModel, setSelectedImageModel] = useState<SupportedImageModelId>(DEFAULT_IMAGE_MODEL);
  const [selectedVideoModel, setSelectedVideoModel] = useState<SupportedVideoModelId>(DEFAULT_VIDEO_MODEL);
  const [selectedManualTool, setSelectedManualTool] = useState<ManualToolSelection>("none");
  const [manualToolsOnly, setManualToolsOnly] = useState(false);
  const [hydratedChatId, setHydratedChatId] = useState<string | null>(null);
  function applyChatPreferences(preferences: ChatScopedPreferences) {
    setModelMode(preferences.modelMode);
    setSelectedChatModel(preferences.selectedChatModel);
    setSelectedImageModel(preferences.selectedImageModel);
    setSelectedVideoModel(preferences.selectedVideoModel);
    setSelectedManualTool(preferences.modelMode === "chat" ? preferences.selectedManualTool : "none");
    setManualToolsOnly(preferences.manualToolsOnly);
  }

  function onModelSelect(value: string) {
    if (modelMode === "chat") {
      setSelectedChatModel(resolveModelId(value));
      return;
    }
    if (modelMode === "image") {
      setSelectedImageModel(resolveImageModelId(value));
      return;
    }
    setSelectedVideoModel(resolveVideoModelId(value));
  }
  useEffect(() => {
    if (!activeChatId) return;
    const stored = readChatPreferences(activeChatId);
    // Browser storage must be restored after mount and before saving this chat's controls.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    applyChatPreferences(stored ?? getDefaultChatPreferences());
    setHydratedChatId(activeChatId);
  }, [activeChatId]);
  useEffect(() => {
    if (!activeChatId || hydratedChatId !== activeChatId) return;

    const preferences: ChatScopedPreferences = {
      modelMode,
      selectedChatModel,
      selectedImageModel,
      selectedVideoModel,
      selectedManualTool,
      manualToolsOnly,
    };

    window.localStorage.setItem(getChatPrefsStorageKey(activeChatId), JSON.stringify(preferences));
  }, [
    activeChatId,
    hydratedChatId,
    manualToolsOnly,
    modelMode,
    selectedChatModel,
    selectedImageModel,
    selectedManualTool,
    selectedVideoModel,
  ]);
  return {
    modelMode, setModelMode, selectedChatModel, setSelectedChatModel, selectedImageModel,
    setSelectedImageModel, selectedVideoModel, setSelectedVideoModel, selectedManualTool,
    setSelectedManualTool, manualToolsOnly, setManualToolsOnly, applyChatPreferences, onModelSelect,
  };
}
