import { ModelMode } from "@/features/chat/page-utils";
import { t } from "@/lib/locale";
import type { ModelLibraryItem, ModelRef } from "@/lib/models/preferences-schema";
import { useEffect, useRef, useState } from "react";
import { getChatPrefsStorageKey, getDefaultChatPreferences, readChatPreferences, loadAccountChatDefaults, parseModelRefValue, staleChatModelWarning } from "@/features/chat/preferences";
import type { ChatScopedPreferences, ManualToolSelection } from "@/features/chat/types";

export function useChatPreferences(activeChatId: string | null) {
  const [modelMode, setModelMode] = useState<ModelMode>("chat");
  const [selectedChatModel, setSelectedChatModel] = useState<ModelRef | null>(null);
  const [selectedImageModel, setSelectedImageModel] = useState<ModelRef | null>(null);
  const [selectedVideoModel, setSelectedVideoModel] = useState<ModelRef | null>(null);
  const [modelLibrary, setModelLibrary] = useState<ModelLibraryItem[]>([]);
  const [selectedManualTool, setSelectedManualTool] = useState<ManualToolSelection>("none");
  const [manualToolsOnly, setManualToolsOnly] = useState(false);
  const [hydratedChatId, setHydratedChatId] = useState<string | null>(null);
  const [defaultsLoaded, setDefaultsLoaded] = useState(false), [preferencesError, setPreferencesError] = useState<string | null>(null);
  const accountDefaults = useRef(getDefaultChatPreferences());
  const defaultsErrorRef = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    void loadAccountChatDefaults().then(value => { if (active) { accountDefaults.current = value.preferences; setModelLibrary(value.library); } })
      .catch(error => { if (active) { const message = error instanceof Error ? error.message : t("chatPrefs.defaultsLoadFailed"); defaultsErrorRef.current = message; setPreferencesError(message); } })
      .finally(() => { if (active) setDefaultsLoaded(true); });
    return () => { active = false; };
  }, []);
  function applyChatPreferences(preferences: ChatScopedPreferences) {
    setModelMode(preferences.modelMode);
    setSelectedChatModel(preferences.selectedChatModel);
    setSelectedImageModel(preferences.selectedImageModel);
    setSelectedVideoModel(preferences.selectedVideoModel);
    setSelectedManualTool(preferences.modelMode === "chat" ? preferences.selectedManualTool : "none");
    setManualToolsOnly(preferences.manualToolsOnly);
  }

  function onModelSelect(value: string) {
    setPreferencesError(null);
    // Switching mode re-renders the model select against a different,
    // mode-filtered option list. Radix can emit an empty string in that window,
    // and only the literal "none" mapped to null -- so the empty value stored
    // "" and silently blanked a model that was still configured.
    if (!value) return;
    const selected = value === "none" ? null : parseModelRefValue(value);
    if (modelMode === "chat") {
      setSelectedChatModel(selected);
      return;
    }
    if (modelMode === "image") {
      setSelectedImageModel(selected);
      return;
    }
    setSelectedVideoModel(selected);
  }
  useEffect(() => {
    if (!defaultsLoaded) return;
    const stored = activeChatId ? readChatPreferences(activeChatId) : null;
    // Browser storage must be restored after mount and before saving this chat's controls.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    applyChatPreferences(stored ?? accountDefaults.current);
    const warning = activeChatId ? staleChatModelWarning(activeChatId, modelLibrary) : null;
    setPreferencesError(warning ?? defaultsErrorRef.current);
    setHydratedChatId(activeChatId);
  }, [activeChatId, defaultsLoaded, modelLibrary]);
  useEffect(() => {
    if (!defaultsLoaded || !activeChatId || hydratedChatId !== activeChatId) return;

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
    defaultsLoaded,
    hydratedChatId,
    manualToolsOnly,
    modelMode,
    selectedChatModel,
    selectedImageModel,
    selectedManualTool,
    selectedVideoModel,
  ]);
  return {
    modelMode, setModelMode, selectedChatModel, selectedImageModel,
    selectedVideoModel, selectedManualTool,
    setSelectedManualTool, manualToolsOnly, setManualToolsOnly, applyChatPreferences, onModelSelect,
    isLoadingPreferences: !defaultsLoaded, preferencesError, modelLibrary,
    clearPreferencesError() { defaultsErrorRef.current = null; setPreferencesError(null); },
  };
}
