"use client";
import { useLocale } from "@/lib/locale/client";
import { localizeMessage, t, tf } from "@/lib/locale";
import { modelRefKey } from "@/lib/models/preferences-schema";
import { attachmentLabel } from "@/features/chat/draft";
import { DocumentAttachment } from "@/components/chat/document-attachment";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectSeparator,
  SelectValue,
} from "@/components/ui/select";
import { useOpenSettings } from "@/features/settings/settings-context";
import { SETTINGS_PARAM, type SettingsSectionId } from "@/lib/settings/sections";
import { Textarea } from "@/components/ui/textarea";
import { CHAT_ATTACHMENT_TYPES, DOCUMENT_ATTACHMENT_TYPES, IMAGE_MEDIA_TYPES, isDocumentAttachment } from "@/lib/media/limits";
import { cn } from "@/lib/utils/cn";
import { ArrowUp, ListPlus, Loader2, Paperclip, PencilLine, Square, X } from "lucide-react";
import { rememberSlashItem, recentSlashItems } from "@/features/chat/slash-recent";
import { DocumentToolBar } from "@/features/chat/document-tool-bar";
import { ComposerChoices, type ChoiceWord } from "@/features/chat/composer-choices";
import { filterSlashItems, SKILL_ICON, SlashMenu, slashQuery, TEMPLATE_ICON, toolIcon, type SlashItem } from "@/features/chat/slash-menu";
import { DOCUMENT_TOOLS, toolLabel } from "@/features/chat/use-tools";
import type { ChatState } from "@/features/chat/use-chat-state";
import { ModelMode } from "@/features/chat/page-utils";
import type { ModelLibraryItem } from "@/lib/models/preferences-schema";
import { ContextUsage } from "@/features/chat/context-usage";
import { ApprovalRulePicker } from "@/features/chat/approval-rule-picker";
import { COMPACT_CONTEXT_TOOL } from "@/lib/chat/compact-context";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type UIEvent } from "react";
import { TASK_DEFAULT_MODEL } from "@/features/chat/types";

/**
 * The model name last shown for a mode. Until the saved choice is read it
 * stands in for the model, so returning to chat starts with the name and the
 * width it ends with rather than growing into them.
 */
/** The model menu's last entry, which leads to adding a model rather than choosing one. */
const ADD_MODEL = "__add_model";

const modelLabelKey = (mode: ModelMode) => `chat:model-label:${mode}`;
const noSubscription = () => () => {};
function useRememberedModelLabel(mode: ModelMode) {
  return useSyncExternalStore(noSubscription, () => { try { return window.localStorage.getItem(modelLabelKey(mode)) ?? ""; } catch { return ""; } }, () => "");
}

type Props = Pick<
  ChatState,
  | "isModelMenuOpen"
  | "setIsModelMenuOpen"
  | "onStop"
  | "onSubmit"
  | "modelMode"
  | "isPending"
  | "isDocumentScopeSaving"
  | "isWorking"
  | "isLoadingPreferences"
  | "isConversationReady"
  | "isConverting"
  | "freedByCompaction"
  | "tools"
  | "skills"
  | "choice"
  | "chooseTool"
  | "toggleSkill"
  | "removeLastChoice"
  | "removeTool"
  | "setToolDocument"
  | "setToolFormat"
  | "loadToolCatalog"
  | "toolCatalogError"
  | "assistants"
  | "applyAssistant"
  | "setInput"
  | "handleTextareaKeyDown"
  | "onTextareaPaste"
  | "textareaRef"
  | "input"
  | "onAttachmentInputChange"
  | "fileInputRef"
  | "attachments"
  | "isUploadingAttachments"
  | "isDraggingFiles"
  | "onComposerDragOver"
  | "onComposerDragLeave"
  | "onComposerDrop"
  | "clearAttachments"
  | "removeAttachmentAt"
  | "attachmentNames"
  | "activeChat"
  | "selectedModel"
  | "selectedModelInfo"
  | "defaultChatModel"
  | "onModeSelect"
  | "onModelSelect"
  | "modelLibrary"
  | "messages"
  | "setApprovalRule"
  | "isApprovalSaving"
  | "isLoadingChats"
  | "queuedMessages"
  | "queueHeldBy"
  | "canQueue"
  | "queueMessage"
  | "removeQueued"
  | "editQueued"
>;
export function Composer({
  onStop,
  onSubmit,
  modelMode,
  isPending,
  isDocumentScopeSaving,
  isWorking,
  isLoadingPreferences,
  isConversationReady,
  isConverting,
  freedByCompaction,
  tools,
  skills,
  choice,
  chooseTool,
  toggleSkill,
  removeLastChoice,
  removeTool,
  setToolDocument,
  setToolFormat,
  loadToolCatalog,
  toolCatalogError,
  assistants,
  applyAssistant,
  setInput,
  handleTextareaKeyDown,
  onTextareaPaste,
  textareaRef,
  input,
  onAttachmentInputChange,
  fileInputRef,
  attachments,
  isUploadingAttachments,
  isDraggingFiles,
  onComposerDragOver,
  onComposerDragLeave,
  onComposerDrop,
  clearAttachments,
  removeAttachmentAt,
  attachmentNames,
  activeChat,
  selectedModel,
  selectedModelInfo,
  defaultChatModel,
  onModeSelect,
  onModelSelect,
  modelLibrary,
  isModelMenuOpen,
  setIsModelMenuOpen,
  messages,
  setApprovalRule,
  isApprovalSaving,
  isLoadingChats,
  queuedMessages,
  queueHeldBy,
  canQueue,
  queueMessage,
  removeQueued,
  editQueued,
}: Props) {
  useLocale();
  const isDocumentTool = modelMode === "chat" && DOCUMENT_TOOLS.has(choice.tool?.id ?? "");
  const isConvertTool = modelMode === "chat" && choice.tool?.id === "convertDocument";
  const isDirectRun = modelMode === "chat" && choice.tool?.surface.user?.run === "direct" && !input.trim();
  const isCompact = modelMode === "chat" && choice.tool?.id === COMPACT_CONTEXT_TOOL;
  const canSend = isCompact || (isDocumentTool ? attachments.length > 0 || Boolean(choice.document) : Boolean(input.trim()) || attachments.length > 0);
  const allowedToolIds = activeChat?.assistantConfig?.tools;
  // A task's conversation that names no model follows the default chat model.
  const followsDefault = modelMode === "chat" && Boolean(activeChat?.task) && !activeChat?.task?.model;
  const defaultModelName = (defaultChatModel && modelLibrary.find(model => modelRefKey(model) === modelRefKey(defaultChatModel))?.name) ?? defaultChatModel?.modelId ?? t("chat.toolbar.modelNone");
  const modelCanCallTools = selectedModelInfo?.supportsTools !== false;
  const openSettings = useOpenSettings();
  // A tool the model would have to call goes with a model that cannot, as it does with a template that does not allow it.
  useEffect(() => { if (modelMode === "chat" && !modelCanCallTools && choice.tool?.surface.user?.run === "model") removeTool(); }, [modelMode, modelCanCallTools, choice.tool, removeTool]);

  // A template that no longer allows the chosen tool takes it away, rather than refusing the send later.
  useEffect(() => { if (choice.tool && allowedToolIds && choice.tool.surface.template !== "always" && !allowedToolIds.includes(choice.tool.id)) removeTool(); }, [choice.tool, allowedToolIds, removeTool]);
  // Converting a Word file into Word would be no conversion at all.
  const sourceIsWord = attachments.length ? attachments.every(part => part.mediaType === DOCUMENT_ATTACHMENT_TYPES[1]) : /\.docx$/i.test(choice.document?.filename ?? "");
  useEffect(() => { if (choice.tool?.id === "convertDocument" && sourceIsWord && choice.format === "docx") setToolFormat("md"); }, [choice.tool?.id, choice.format, sourceIsWord, setToolFormat]);

  // ---- The slash menu: what the word being typed offers, and moving through it.
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [activeRow, setActiveRow] = useState({ word: "", index: 0 });
  const slash = modelMode === "chat" ? slashQuery(input, caret) : null;
  const allItems = useMemo<SlashItem[]>(() => {
    const items: SlashItem[] = [];
    for (const tool of tools) {
      const user = tool.surface.user;
      if (!user || !tool.modeSupport.includes("chat") || (allowedToolIds && tool.surface.template !== "always" && !allowedToolIds.includes(tool.id))) continue;
      const label = tool.extensionId ? toolLabel(tool) : localizeMessage(tool.displayName);
      const blocked = !tool.available ? t("chat.slash.needsSetup") : user.run === "model" && !modelCanCallTools ? t("chat.slash.modelCannotCall") : undefined;
      items.push({
        key: `tool:${tool.id}`, group: tool.extensionId ? "plugins" : "tools", label, description: tool.extensionId ? tool.description : localizeMessage(tool.description),
        meta: tool.extensionName, icon: toolIcon(tool.id, Boolean(tool.extensionId)), chosen: choice.tool?.id === tool.id, blocked, terms: tool.id,
        // A tool waiting on setup leads there; one the model cannot call has nothing to offer.
        run: () => {
          if (tool.available) return chooseTool(tool);
          const section = tool.configEntry ? new URL(tool.configEntry, window.location.href).searchParams.get(SETTINGS_PARAM) : null;
          if (section) openSettings(section as SettingsSectionId);
        },
        opensSetup: !tool.available,
      });
    }
    for (const skill of skills) items.push({
      key: `skill:${skill.packageId}:${skill.skillId}`, group: "skills", label: skill.name, description: skill.description, meta: skill.plugin, icon: SKILL_ICON,
      chosen: choice.skills.some(item => item.packageId === skill.packageId && item.skillId === skill.skillId), run: () => toggleSkill(skill),
    });
    for (const template of assistants) {
      const name = template.builtin ? localizeMessage(template.config.name) : template.config.name;
      items.push({ key: `template:${template.id}`, group: "templates", label: name, description: template.builtin ? localizeMessage(template.config.description) : template.config.description, icon: TEMPLATE_ICON, chosen: activeChat?.assistantConfig?.templateId === template.id, run: () => void applyAssistant(template.id) });
    }
    return items;
  }, [tools, skills, assistants, allowedToolIds, modelCanCallTools, choice.tool, choice.skills, activeChat?.assistantConfig?.templateId, chooseTool, toggleSkill, applyAssistant, openSettings]);
  const visibleItems = useMemo(() => {
    if (!slash) return [];
    if (slash.query) return filterSlashItems(allItems, slash.query);
    // Before anything is typed, only what can be used now, led by what was used last.
    const usable = allItems.filter(item => !item.blocked);
    const recent = recentSlashItems().flatMap(key => usable.filter(item => item.key === key)).slice(0, 4);
    return [...recent.map(item => ({ ...item, group: "recent" as const })), ...usable.filter(item => !recent.includes(item))];
  }, [allItems, slash]);
  // Said where the missing tools would be, so a short or empty list explains itself.
  const slashNotice = slash && !modelCanCallTools ? t("chat.slash.toolLessNotice") : undefined;
  const menuOpen = Boolean(slash) && (visibleItems.length > 0 || Boolean(slashNotice)) && dismissedAt !== slash?.start && !isPending;
  // The catalog may have changed in settings since this page loaded.
  const wasOpen = useRef(false);
  useEffect(() => { if (menuOpen && !wasOpen.current) void loadToolCatalog(); wasOpen.current = menuOpen; }, [menuOpen, loadToolCatalog]);
  // Each new word starts from the top of what it finds.
  const slashWord = `${slash?.start}:${slash?.query}`;
  const activeIndex = activeRow.word === slashWord ? activeRow.index : 0;
  const setActiveIndex = (index: number) => setActiveRow({ word: slashWord, index });
  function selectItem(item: SlashItem) {
    if (!slash) return;
    if (item.blocked && !item.opensSetup) return;
    if (!item.blocked) rememberSlashItem(item.key);
    const end = slash.start + 1 + slash.query.length;
    setInput(current => `${current.slice(0, slash.start)}${current.slice(end)}`);
    setCaret(slash.start);
    item.run();
    const box = textareaRef.current, at = slash.start;
    requestAnimationFrame(() => { box?.focus(); box?.setSelectionRange(at, at); });
  }
  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen && !event.nativeEvent.isComposing) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((activeIndex + step + visibleItems.length) % visibleItems.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const item = visibleItems[Math.min(activeIndex, visibleItems.length - 1)];
        if (item) selectItem(item);
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); setDismissedAt(slash?.start ?? null); return; }
    }
    // A second slash on a word whose menu was just closed asks for the menu again.
    if (event.key === "/" && slash && !slash.query && dismissedAt === slash.start && !event.nativeEvent.isComposing) { event.preventDefault(); setDismissedAt(null); return; }
    const box = event.currentTarget;
    if (event.key === "Backspace" && !event.nativeEvent.isComposing && box.selectionStart === 0 && box.selectionEnd === 0 && (choice.tool || choice.skills.length)) { event.preventDefault(); removeLastChoice(); return; }
    handleTextareaKeyDown(event);
  }

  // ---- The chosen words sit in the box's first line; the text starts right after them.
  const choiceWords: ChoiceWord[] = modelMode !== "chat" ? [] : [
    ...(choice.tool ? [{ key: choice.tool.id, label: choice.tool.extensionId ? toolLabel(choice.tool) : localizeMessage(choice.tool.displayName), icon: toolIcon(choice.tool.id, Boolean(choice.tool.extensionId)), remove: removeTool }] : []),
    ...choice.skills.map(skill => ({ key: `${skill.packageId}:${skill.skillId}`, label: skill.name, icon: SKILL_ICON, remove: () => toggleSkill(skill) })),
  ];
  const choicesRef = useRef<HTMLDivElement>(null);
  const wordKeys = choiceWords.map(word => `${word.key}:${word.label}`).join("|");
  useLayoutEffect(() => {
    const box = choicesRef.current, input = textareaRef.current;
    if (!input) return;
    const measure = () => {
      const last = box?.querySelector<HTMLElement>("[data-choice-word]:last-child");
      const first = box?.querySelector<HTMLElement>("[data-choice-word]");
      if (!box || !last || !first) { input.style.textIndent = ""; input.style.paddingTop = ""; return; }
      const right = last.getBoundingClientRect().right + parseFloat(getComputedStyle(last).marginRight);
      input.style.textIndent = `${Math.round(right - box.getBoundingClientRect().left)}px`;
      input.style.paddingTop = `calc(0.75rem + ${Math.round(last.getBoundingClientRect().top - first.getBoundingClientRect().top)}px)`;
    };
    measure();
    if (!box) return;
    // A word's own width changes when the font finishes loading, which the box around it never notices.
    const observer = new ResizeObserver(measure);
    box.querySelectorAll("[data-choice-word]").forEach(word => observer.observe(word));
    void document.fonts?.ready.then(measure);
    return () => observer.disconnect();
  }, [wordKeys, textareaRef]);
  const followScroll = (event: UIEvent<HTMLTextAreaElement>) => { if (choicesRef.current) choicesRef.current.style.transform = `translateY(${-event.currentTarget.scrollTop}px)`; };
  const rememberedModelLabel = useRememberedModelLabel(modelMode);
  const modelLabel = !selectedModel ? t("chat.toolbar.modelNone")
    : modelLibrary.find(model => modelRefKey(model) === modelRefKey(selectedModel) && model.modes.includes(modelMode))?.name ?? tf("chat.toolbar.modelUnavailable", { modelId: selectedModel.modelId });
  useEffect(() => {
    if (isLoadingPreferences) return;
    try { window.localStorage.setItem(modelLabelKey(modelMode), modelLabel); } catch { /* Only a starting label; nothing depends on it being kept. */ }
  }, [isLoadingPreferences, modelMode, modelLabel]);
  return (
    <form
      className={cn(
        "mx-auto flex w-full max-w-[42rem] flex-col gap-2 rounded-xl transition-shadow duration-[--dur-fast]",
        // Only lit while a real file drag is over the composer, so a drag of
        // selected text does not look like an invitation to drop a file.
        isDraggingFiles &&
          "ring-2 ring-ring ring-offset-2 ring-offset-background",
      )}
      noValidate
      onDragLeave={onComposerDragLeave}
      onDragOver={onComposerDragOver}
      onDrop={onComposerDrop}
      onSubmit={onSubmit}
    >
      {/* Written while the answer was still coming: sent in order once the conversation is free. */}
      {queuedMessages.length ? (
        <ol className="composer-queue" aria-label={t("chat.queue.label")}>
          {queuedMessages.map(item => (
            <li key={item.id} className="composer-queue-item">
              <span className="composer-queue-text truncate">{item.text || item.attachments.map(file => file.filename ?? "").join(t("chat.composer.attachmentSeparator"))}</span>
              <Button type="button" variant="ghost" size="icon-sm" className="composer-queue-action" aria-label={t("chat.queue.edit")} title={t("chat.queue.edit")} onClick={() => editQueued(item.id)}><PencilLine aria-hidden="true" /></Button>
              <Button type="button" variant="ghost" size="icon-sm" className="composer-queue-action" aria-label={t("chat.queue.remove")} title={t("chat.queue.remove")} onClick={() => removeQueued(item.id)}><X aria-hidden="true" /></Button>
            </li>
          ))}
          {queueHeldBy
            ? <li className="composer-queue-hint composer-queue-held" role="status">{tf(queueHeldBy.key, queueHeldBy.values ?? {})}</li>
            : <li className="composer-queue-hint">{t("chat.queue.hint")}</li>}
        </ol>
      ) : null}
      {modelMode === "chat" && toolCatalogError ? (
        <p className="text-[11px] text-warning">
          {tf("chat.composer.toolCatalogError", { detail: toolCatalogError })}
        </p>
      ) : null}

      {/* One bordered surface holds the prompt, the controls that shape it, and the
        send action. Scattering those across separate full-width rows left the
        send button visually unconnected to what it submits. */}
      <SlashMenu open={menuOpen} notice={slashNotice} items={visibleItems} activeIndex={activeIndex} query={slash?.query ?? ""} listId={listId} onActivate={setActiveIndex} onSelect={selectItem} onDismiss={() => setDismissedAt(slash?.start ?? null)} anchor={
      <div className="composer-surface">
        <div className="composer-body">
          <div className="composer-field">
            {choiceWords.length ? <ComposerChoices ref={choicesRef} words={choiceWords} /> : null}
            <Textarea
              className="composer-input block h-full min-h-0 w-full resize-none overflow-y-auto rounded-none px-4 py-3 shadow-none focus-visible:ring-0"
              onChange={(event) => {
                setInput(event.target.value); setCaret(event.target.selectionStart);
                // A closed menu stays closed only for the word it was closed on.
                if (slashQuery(event.target.value, event.target.selectionStart)?.start !== dismissedAt) setDismissedAt(null);
              }}
              onKeyDown={onComposerKeyDown}
              onSelect={event => setCaret(event.currentTarget.selectionStart)}
              onScroll={followScroll}
              onPaste={onTextareaPaste}
              placeholder={
                modelMode === "image"
                  ? t("chat.composer.placeholderImage")
                  : modelMode === "video"
                    ? t("chat.composer.placeholderVideo")
                    : choice.tool?.surface.user
                      ? localizeMessage(choice.tool.surface.user.hint)
                      : choice.skills.length
                        ? t("chat.slash.skillHint")
                        : t("chat.composer.placeholderChat")
              }
              ref={textareaRef}
              rows={3}
              value={input}
              role={menuOpen ? "combobox" : undefined}
              aria-expanded={menuOpen ? true : undefined}
              aria-controls={menuOpen ? listId : undefined}
              aria-autocomplete={menuOpen ? "list" : undefined}
              aria-activedescendant={menuOpen ? `${listId}-${activeIndex}` : undefined}
            />
          </div>
        </div>
        {/*
        A thumbnail is worth more than a file name here: the user is deciding
        whether the right picture got attached, and a name cannot answer that.
        Each one removes itself rather than only offering "remove all", because
        fixing a wrong pick should not cost the picks that were right.
      */}
        {attachments.length > 0 ? (
          <ul
            className="flex flex-wrap gap-2 px-3 pt-3"
            aria-label={t("chat.composer.attachmentListLabel")}
          >
            {attachments.map((attachment, index) => isDocumentAttachment(attachment.mediaType) ? (
              <li className="w-56 max-w-full" key={attachment.url}>
                <DocumentAttachment {...attachment} onRemove={() => removeAttachmentAt(index)} />
              </li>
            ) : (
              <li className="group relative" key={`${attachment.url}-${index}`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- the asset
                  lives behind the local credential, which a next/image loader
                  would fetch without it. */}
                <img
                  alt={attachmentLabel(attachment)}
                  className="h-14 w-14 rounded-md border border-border object-cover"
                  src={attachment.url}
                />
                <button
                  aria-label={t("chat.composer.removeAttachment")}
                  className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-border bg-background text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => removeAttachmentAt(index)}
                  type="button"
                >
                  <X aria-hidden="true" className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {isUploadingAttachments ? (
          <p
            className="flex items-center gap-1.5 px-3 pt-2 text-[11px] text-muted-foreground"
            role="status"
          >
            <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
            {t("chat.composer.uploadingAttachment")}
          </p>
        ) : null}

        <div className="flex items-end justify-between gap-2 px-3 pb-3">
          <div className="composer-controls flex min-w-0 flex-1 flex-wrap items-center">
            {/* The native control renders untranslated browser chrome inside an
              otherwise Chinese UI, so the label carries the visible copy and the
              input names itself. The selected filenames are announced from our
              own live region rather than left to the browser's default. */}
            <label
              className={cn(
                "inline-flex h-7 w-7 shrink-0 cursor-pointer select-none items-center justify-center rounded-md text-xs text-muted-foreground transition-colors focus-within:ring-1 focus-within:ring-ring",
                "hover:bg-accent hover:text-foreground",
                (!isConversationReady || isUploadingAttachments) && "pointer-events-none opacity-50",
              )}
            >
              <Paperclip aria-hidden="true" className="h-3.5 w-3.5" />
              <span className="sr-only">{t("chat.composer.chooseFile")}</span>
              <input
                accept={modelMode === "chat" ? [...CHAT_ATTACHMENT_TYPES, ".pdf", ".docx"].join(",") : IMAGE_MEDIA_TYPES.join(",")}
                aria-label={t("chat.composer.fileInputLabel")}
                className="sr-only"
                disabled={!isConversationReady || isUploadingAttachments}
                multiple
                onChange={onAttachmentInputChange}
                ref={fileInputRef}
                type="file"
              />
            </label>
            {/* Choosing a document tool already says what kind of work this is, and a
              conversion needs no model, so their controls make way for its own. */}
            {isDocumentTool ? null : <Select
              disabled={isPending}
              onValueChange={(value) => onModeSelect(value as ModelMode)}
              value={modelMode}
            >
              <SelectTrigger
                aria-label={t("chat.toolbar.modeChat")}
                variant="ghost"
                size="sm"
                className="composer-control w-auto"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="chat">
                  {t("chat.toolbar.modeChat")}
                </SelectItem>
                <SelectItem value="image">
                  {t("chat.toolbar.modeImage")}
                </SelectItem>
                <SelectItem value="video">
                  {t("chat.toolbar.modeVideo")}
                </SelectItem>
              </SelectContent>
            </Select>}
            {isConvertTool ? null : <Select
              disabled={isPending || (modelMode === "chat" && !!activeChat?.assistantConfig?.model)}
              open={isModelMenuOpen}
              onOpenChange={setIsModelMenuOpen}
              // "添加模型…" opens the model settings instead of becoming the selection.
              onValueChange={value => value === ADD_MODEL ? openSettings("models") : onModelSelect(value)}
              // Until the saved choice is read, the last model shown stands in for
              // it, rather than "选择模型" claiming no model is chosen. With no
              // model the placeholder says so; it is not an item to tick.
              // A task that follows the default chat model shows that choice, not the model it resolves to.
              value={followsDefault ? TASK_DEFAULT_MODEL : selectedModel && !isLoadingPreferences ? modelRefKey(selectedModel) : ""}
            >
              {/* Sized to the name; a different name eases to its width instead of pushing the tools aside. */}
              <SelectTrigger
                aria-label={t("chat.toolbar.modelSelectLabel")}
                variant="ghost"
                size="sm"
                fluid
                className="composer-control w-auto max-w-[200px]"
              >
                <SelectValue className="truncate" placeholder={isLoadingPreferences ? rememberedModelLabel : t("chat.toolbar.modelNone")} />
              </SelectTrigger>
              <SelectContent>
                {activeChat?.task && modelMode === "chat" ? <>
                  <SelectItem value={TASK_DEFAULT_MODEL}>{tf("chat.toolbar.taskDefaultModel", { name: defaultModelName })}</SelectItem>
                  <SelectSeparator />
                </> : null}
                {!followsDefault && selectedModel &&
                !modelLibrary.some(
                  (model) =>
                    modelRefKey(model) === modelRefKey(selectedModel) &&
                    model.modes.includes(modelMode),
                ) ? (
                  <SelectItem value={modelRefKey(selectedModel)}>
                    {tf("chat.toolbar.modelUnavailable", {
                      modelId: selectedModel.modelId,
                    })}
                  </SelectItem>
                ) : null}
                {modelLibrary
                  .filter((model: ModelLibraryItem) =>
                    model.modes.includes(modelMode),
                  )
                  .map((model) => (
                    <SelectItem
                      key={modelRefKey(model)}
                      value={modelRefKey(model)}
                    >
                      {model.name}
                    </SelectItem>
                  ))}
                <SelectSeparator />
                <SelectItem value={ADD_MODEL}>{t("chat.modelHint.addMenuItem")}</SelectItem>
              </SelectContent>
            </Select>}
            {isDocumentTool ? <DocumentToolBar document={choice.document} onDocumentChange={setToolDocument} format={choice.format} onFormatChange={setToolFormat} showFormat={choice.tool?.id === "convertDocument"} hasAttachments={attachments.length > 0} scope={activeChat?.documentScope} disabled={isPending} /> : null}

            {/* Choosing a folder already lets the assistant work there; the rule beside the
              context ring says what waits for the user first. */}
            {modelMode === "chat" && selectedModelInfo?.supportsTools !== false ? <ApprovalRulePicker
              rule={activeChat?.approvalRule ?? null}
              locked={isPending}
              saving={isApprovalSaving || isLoadingChats}
              onSelect={setApprovalRule}
            /> : null}
            {modelMode === "chat" && !isConvertTool ? <ContextUsage messages={messages} freedTokens={freedByCompaction} /> : null}

            {/* Visible hint stays exactly as before; this second, hidden node
              exists only so a screen reader hears the attachment state in the
              interface language instead of the browser's own wording. */}
            {attachmentNames.length > 0 ? (
              <span className="truncate text-[11px] text-muted-foreground">
                {attachmentNames.join(t("chat.composer.attachmentSeparator"))}
              </span>
            ) : (
              <span className="sr-only">
                {t("chat.composer.pasteHint")}
              </span>
            )}
            <span aria-live="polite" className="sr-only">
              {attachmentNames.length > 0
                ? tf("chat.composer.attachmentsSelected", {
                    count: attachmentNames.length,
                    names: attachmentNames.join(
                      t("chat.composer.attachmentSeparator"),
                    ),
                  })
                : ""}
            </span>
            {attachments.length > 0 ? (
              <Button
                onClick={clearAttachments}
                size="sm"
                type="button"
                variant="ghost"
              >
                {tf("chat.composer.clearAttachments", {
                  count: attachments.length,
                })}
              </Button>
            ) : null}
          </div>

          {/* Stopping replaces sending while a turn is running. The label says
            exactly that: the request to the provider is abandoned, not undone,
            and anything already produced stays on screen. */}
          {/* While an answer is coming, what is written now can wait its turn (Enter does the same). */}
          {isWorking && canQueue ? (
            <Button type="button" size="icon" variant="ghost" className="rounded-full" aria-label={t("chat.queue.add")} title={t("chat.queue.add")} onClick={queueMessage}>
              <ListPlus aria-hidden="true" />
            </Button>
          ) : null}
          {isConverting ? <Button size="icon" className="rounded-full" disabled aria-label={t("ui.chat.composer.runningTool")}><Loader2 data-icon="inline-start" className="animate-spin" /></Button> : isWorking ? (
            <Button
              aria-label={t("chat.composer.stop")}
              className="rounded-full"
              size="icon"
              onClick={onStop}
              type="button"
              variant="secondary"
            >
              <Square aria-hidden="true" className="fill-current" />
              <span className="sr-only">{t("chat.composer.stop")}</span>
            </Button>
          ) : (
            <Button
              size="icon"
              className="rounded-full"
              disabled={!isConversationReady || isDocumentScopeSaving || !canSend}
              type="submit"
            >
              <ArrowUp aria-hidden="true" strokeWidth={2.25} />
              <span className="sr-only">
                {isCompact ? t("chat.compact.submit") : isDirectRun ? t("chat.convert.submit") : t("chat.composer.send")}
              </span>
            </Button>
          )}
        </div>
      </div>
      } />
    </form>
  );
}
