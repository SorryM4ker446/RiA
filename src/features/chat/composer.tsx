"use client";
import { useLocale } from "@/lib/locale/client";
import { localizeMessage, t, tf } from "@/lib/locale";
import { modelRefKey } from "@/lib/models/preferences-schema";
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
import { Textarea } from "@/components/ui/textarea";
import { CHAT_ATTACHMENT_TYPES, DOCUMENT_ATTACHMENT_TYPES, IMAGE_MEDIA_TYPES } from "@/lib/media/limits";
import { cn } from "@/lib/utils/cn";
import { ArrowUp, ListPlus, Loader2, Paperclip, Square } from "lucide-react";
import { DocumentToolBar } from "@/features/chat/document-tool-bar";
import { ComposerChoices, type ChoiceWord } from "@/features/chat/composer-choices";
import { SKILL_ICON, SlashMenu, toolIcon } from "@/features/chat/slash-menu";
import { useSlashMenu } from "@/features/chat/use-slash-menu";
import { ComposerAttachments, QueuedMessages } from "@/features/chat/composer-parts";
import { DOCUMENT_TOOLS, toolLabel } from "@/features/chat/use-tools";
import type { ChatState } from "@/features/chat/use-chat-state";
import { ModelMode } from "@/features/chat/page-utils";
import type { ModelLibraryItem } from "@/lib/models/preferences-schema";
import { ContextUsage } from "@/features/chat/context-usage";
import { ApprovalRulePicker } from "@/features/chat/approval-rule-picker";
import { COMPACT_CONTEXT_TOOL } from "@/lib/chat/compact-context";
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type UIEvent } from "react";
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
  useEffect(() => {
    if (choice.tool && allowedToolIds && choice.tool.surface.template !== "always" && !allowedToolIds.includes(choice.tool.id)) removeTool();
  }, [choice.tool, allowedToolIds, removeTool]);
  // Converting a Word file into Word would be no conversion at all.
  const sourceIsWord = attachments.length ? attachments.every(part => part.mediaType === DOCUMENT_ATTACHMENT_TYPES[1]) : /\.docx$/i.test(choice.document?.filename ?? "");
  useEffect(() => { if (choice.tool?.id === "convertDocument" && sourceIsWord && choice.format === "docx") setToolFormat("md"); }, [choice.tool?.id, choice.format, sourceIsWord, setToolFormat]);

  // ---- The slash menu: what the word being typed offers, and moving through it.
  const menu = useSlashMenu({
    modelMode, input, setInput, tools, skills, assistants, choice, chooseTool, toggleSkill, applyAssistant, isPending, loadToolCatalog,
    removeLastChoice, handleTextareaKeyDown, textareaRef, allowedToolIds, modelCanCallTools, activeTemplateId: activeChat?.assistantConfig?.templateId,
  });

  // ---- The chosen words sit in the box's first line; the text starts right after them.
  const choiceWords: ChoiceWord[] = modelMode !== "chat" ? [] : [
    ...(choice.tool ? [{
      key: choice.tool.id,
      label: choice.tool.extensionId ? toolLabel(choice.tool) : localizeMessage(choice.tool.displayName),
      icon: toolIcon(choice.tool.id, Boolean(choice.tool.extensionId)),
      remove: removeTool,
    }] : []),
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
      <QueuedMessages queuedMessages={queuedMessages} queueHeldBy={queueHeldBy} editQueued={editQueued} removeQueued={removeQueued} />
      {modelMode === "chat" && toolCatalogError ? (
        <p className="text-[11px] text-warning">
          {tf("chat.composer.toolCatalogError", { detail: toolCatalogError })}
        </p>
      ) : null}

      {/* One bordered surface holds the prompt, the controls that shape it, and the
        send action. Scattering those across separate full-width rows left the
        send button visually unconnected to what it submits. */}
      <SlashMenu
        open={menu.open} notice={menu.notice} items={menu.items} activeIndex={menu.activeIndex} query={menu.query} listId={menu.listId}
        onActivate={menu.setActiveIndex} onSelect={menu.select} onDismiss={menu.dismiss}
        anchor={
      <div className="composer-surface">
        <div className="composer-body">
          <div className="composer-field">
            {choiceWords.length ? <ComposerChoices ref={choicesRef} words={choiceWords} /> : null}
            <Textarea
              className="composer-input block h-full min-h-0 w-full resize-none overflow-y-auto rounded-none px-4 py-3 shadow-none focus-visible:ring-0"
              onChange={menu.onChange}
              onKeyDown={menu.onKeyDown}
              onSelect={event => menu.onCaret(event.currentTarget.selectionStart)}
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
              role={menu.open ? "combobox" : undefined}
              aria-expanded={menu.open ? true : undefined}
              aria-controls={menu.open ? menu.listId : undefined}
              aria-autocomplete={menu.open ? "list" : undefined}
              aria-activedescendant={menu.open ? `${menu.listId}-${menu.activeIndex}` : undefined}
            />
          </div>
        </div>
        <ComposerAttachments attachments={attachments} removeAttachmentAt={removeAttachmentAt} isUploadingAttachments={isUploadingAttachments} />

        <div className="flex items-end justify-between gap-2 px-3 pb-3">
          <div className="composer-controls flex min-w-0 flex-1 flex-wrap items-center">
            {/* The native control renders untranslated browser chrome inside an
              otherwise Chinese UI, so the label carries the visible copy and the
              input names itself. The selected filenames are announced from our
              own live region rather than left to the browser's default. */}
            <label
              className={cn(
                "inline-flex h-7 w-7 shrink-0 cursor-pointer select-none items-center justify-center rounded-md",
                "text-xs text-muted-foreground transition-colors focus-within:ring-1 focus-within:ring-ring",
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
            {isDocumentTool ? (
              <DocumentToolBar
                document={choice.document}
                onDocumentChange={setToolDocument}
                format={choice.format}
                onFormatChange={setToolFormat}
                showFormat={choice.tool?.id === "convertDocument"}
                hasAttachments={attachments.length > 0}
                scope={activeChat?.documentScope}
                disabled={isPending}
              />
            ) : null}

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
          {isConverting ? (
            <Button size="icon" className="rounded-full" disabled aria-label={t("ui.chat.composer.runningTool")}>
              <Loader2 data-icon="inline-start" className="animate-spin" />
            </Button>
          ) : isWorking ? (
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
