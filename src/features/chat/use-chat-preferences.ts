import { ModelMode } from "@/features/chat/page-utils";
import { t } from "@/lib/locale";
import type { ModelLibraryItem, ModelRef } from "@/lib/models/preferences-schema";
import { useEffect, useRef, useState } from "react";
import { getDefaultChatPreferences, readChatPreferences, loadAccountChatDefaults, parseModelRefValue, resolveChatPreferences, staleChatModelWarning } from "@/features/chat/preferences";
import type { ChatScopedPreferences } from "@/features/chat/types";
import { onModelPreferencesChanged } from "@/features/models/preference-events";
import { chatApi } from "@/features/chat/api-client";
import { useConversationStore } from "@/features/chat/conversation-store";

type StoredPreferences = Partial<ChatScopedPreferences> | null;

function restorePreferences(chatId: string, saved: StoredPreferences): StoredPreferences {
  // A complete server record is authoritative. The partial record on older
  // workspaces is only a fallback for a browser that cannot see its old storage.
  return saved?.modelMode ? saved : readChatPreferences(chatId) ?? saved;
}

export function useChatPreferences(activeChatId: string | null) {
  const store = useConversationStore();
  const chat = store.chats.find(item => item.id === activeChatId);
  const waitingForChat = activeChatId !== null && store.isLoading && !chat;
  const savedPreferences = JSON.stringify(chat?.modelPreferences ?? null);
  const [preferences, applyChatPreferences] = useState(getDefaultChatPreferences);
  const { modelMode, selectedChatModel, selectedImageModel, selectedVideoModel } = preferences;
  const [modelLibrary, setModelLibrary] = useState<ModelLibraryItem[]>([]);
  const [hydratedChatId, setHydratedChatId] = useState<string | null>(null);
  const [defaultsLoaded, setDefaultsLoaded] = useState(false), [preferencesError, setPreferencesError] = useState<string | null>(null);
  const accountDefaults = useRef(getDefaultChatPreferences());
  // The account's default chat model, which a task without a model of its own follows.
  const [defaultChatModel, setDefaultChatModel] = useState<ModelRef | null>(null);
  const activeIdRef = useRef(activeChatId);
  activeIdRef.current = activeChatId;
  const writes = useRef(new Map<string, { value: ChatScopedPreferences; settled: Promise<StoredPreferences> }>());
  const defaultsErrorRef = useRef<string | null>(null);
  // Bumped whenever the settings window changes the model library or defaults,
  // so the chat offers what was just added without a reload. A reload after the
  // first keeps the page ready rather than going back to its loading state.
  const [defaultsVersion, setDefaultsVersion] = useState(0);
  useEffect(() => onModelPreferencesChanged(() => setDefaultsVersion(version => version + 1)), []);
  useEffect(() => {
    let active = true;
    void loadAccountChatDefaults().then(value => { if (active) { accountDefaults.current = value.preferences; defaultsErrorRef.current = null; setDefaultChatModel(value.preferences.selectedChatModel); setModelLibrary(value.library); } })
      .catch(error => { if (active) { const message = error instanceof Error ? error.message : t("chatPrefs.defaultsLoadFailed"); defaultsErrorRef.current = message; setPreferencesError(message); } })
      .finally(() => { if (active) setDefaultsLoaded(true); });
    return () => { active = false; };
  }, [defaultsVersion]);
  const isLoadingPreferences = !defaultsLoaded || waitingForChat || hydratedChatId !== activeChatId;

  function choosePreferences(value: ChatScopedPreferences) {
    if (isLoadingPreferences) return;
    applyChatPreferences(value);
    setPreferencesError(null);
    if (!activeChatId) return;
    const id = activeChatId;
    // A rapid second selection must be committed after the first one, even
    // when the user opens a different conversation while the save is pending.
    const previous = writes.current.get(id)?.settled ?? Promise.resolve(restorePreferences(id, chat?.modelPreferences ?? null));
    const settled = previous.then(async confirmed => {
      try {
        const { data } = await chatApi.setModelPreferences(id, value);
        store.invalidate();
        store.setChats(current => current.map(item => item.id === id ? { ...item, modelPreferences: data.modelPreferences } : item));
        return data.modelPreferences ?? null;
      } catch (error) {
        if (writes.current.get(id)?.settled === settled && activeIdRef.current === id) {
          applyChatPreferences(resolveChatPreferences(confirmed, accountDefaults.current));
          setPreferencesError(error instanceof Error ? error.message : t("chatPrefs.saveFailed"));
        }
        return confirmed;
      } finally {
        if (writes.current.get(id)?.settled === settled) writes.current.delete(id);
      }
    });
    writes.current.set(id, { value, settled });
  }

  function onModelSelect(value: string) {
    // Switching mode re-renders the model select against a different,
    // mode-filtered option list. Radix can emit an empty string in that window,
    // and only the literal "none" mapped to null -- so the empty value stored
    // "" and silently blanked a model that was still configured.
    if (!value) return;
    const selected = value === "none" ? null : parseModelRefValue(value);
    if (modelMode === "chat") {
      choosePreferences({ ...preferences, selectedChatModel: selected });
      return;
    }
    if (modelMode === "image") {
      choosePreferences({ ...preferences, selectedImageModel: selected });
      return;
    }
    choosePreferences({ ...preferences, selectedVideoModel: selected });
  }
  useEffect(() => {
    if (!defaultsLoaded || waitingForChat) return;
    const stored = activeChatId ? writes.current.get(activeChatId)?.value ?? restorePreferences(activeChatId, JSON.parse(savedPreferences)) : null;
    applyChatPreferences(resolveChatPreferences(stored, accountDefaults.current));
    const warning = staleChatModelWarning(stored, modelLibrary);
    setPreferencesError(warning ?? defaultsErrorRef.current);
    setHydratedChatId(activeChatId);
  }, [activeChatId, defaultsLoaded, modelLibrary, savedPreferences, waitingForChat]);
  return {
    modelMode, setModelMode: (mode: ModelMode) => choosePreferences({ ...preferences, modelMode: mode }), selectedChatModel, selectedImageModel,
    selectedVideoModel, applyChatPreferences, onModelSelect,
    isLoadingPreferences, preferencesError, modelLibrary,
    defaultChatModel,
    clearPreferencesError() { defaultsErrorRef.current = null; setPreferencesError(null); },
  };
}
