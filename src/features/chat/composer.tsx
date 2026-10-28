"use client";
import { useLocale } from "@/lib/locale/client";
import { localizeMessage, t, tf } from "@/lib/locale";
import { modelRefKey } from "@/lib/models/preferences-schema";
import { attachmentLabel } from "@/features/chat/draft";
import { DocumentAttachment } from "@/components/chat/document-attachment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
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
import { CHAT_ATTACHMENT_TYPES, IMAGE_MEDIA_TYPES, isDocumentAttachment } from "@/lib/media/limits";
import { cn } from "@/lib/utils/cn";
import { ArrowUp, Loader2, Paperclip, Square, X } from "lucide-react";
import { DocumentToolInput } from "@/features/chat/document-tool-input";
import { getManualToolFieldError } from "@/features/chat/tool-input";
import type { ManualToolSelection } from "@/features/chat/types";
import type { ChatState } from "@/features/chat/use-chat-state";
import { ModelMode } from "@/features/chat/page-utils";
import type { ModelLibraryItem } from "@/lib/models/preferences-schema";
import { ContextUsage } from "@/features/chat/context-usage";
import { useEffect, useSyncExternalStore } from "react";

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
  | "isRunningManualTool"
  | "selectedToolDocument"
  | "setSelectedToolDocument"
  | "setSelectedManualTool"
  | "manualToolSelectValue"
  | "manualTools"
  | "selectedManualToolConfig"
  | "manualToolFieldValues"
  | "setManualToolFieldValues"
  | "manualToolFieldErrors"
  | "setManualToolFieldErrors"
  | "toolCatalogError"
  | "unavailableTools"
  | "setInput"
  | "handleTextareaKeyDown"
  | "onTextareaPaste"
  | "textareaRef"
  | "input"
  | "isManualToolSelected"
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
  | "onModeSelect"
  | "onModelSelect"
  | "modelLibrary"
  | "messages"
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
  isRunningManualTool,
  selectedToolDocument,
  setSelectedToolDocument,
  setSelectedManualTool,
  manualToolSelectValue,
  manualTools,
  selectedManualToolConfig,
  manualToolFieldValues,
  setManualToolFieldValues,
  manualToolFieldErrors,
  setManualToolFieldErrors,
  toolCatalogError,
  unavailableTools,
  setInput,
  handleTextareaKeyDown,
  onTextareaPaste,
  textareaRef,
  input,
  isManualToolSelected,
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
  onModeSelect,
  onModelSelect,
  modelLibrary,
  isModelMenuOpen,
  setIsModelMenuOpen,
  messages,
}: Props) {
  useLocale();
  const isDocumentTool = modelMode === "chat" && ["readDocument", "convertDocument"].includes(selectedManualToolConfig?.id ?? "");
  const rememberedModelLabel = useRememberedModelLabel(modelMode);
  const openSettings = useOpenSettings();
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
      {modelMode === "chat" &&
      selectedManualToolConfig &&
      selectedManualToolConfig.manual.fields.length > 0 ? (
        <FieldGroup className="gap-2 rounded-xl border border-border/60 bg-card/70 p-3 md:grid md:grid-cols-3">
          {selectedManualToolConfig.manual.fields.map((field) => {
            const value = manualToolFieldValues[field.key] ?? "";
            const fieldId = `manual-tool-${field.key}`;
            if (field.type === "select") {
              return (
                <Field key={field.key}>
                  <FieldLabel htmlFor={fieldId} className="sr-only">{localizeMessage(field.label)}</FieldLabel>
                  <Select
                    onValueChange={(nextValue) =>
                      setManualToolFieldValues((prev) => ({
                        ...prev,
                        [field.key]: nextValue,
                      }))
                    }
                    value={value || field.defaultValue || ""}
                  >
                    <SelectTrigger id={fieldId} className="h-8">
                      <SelectValue placeholder={localizeMessage(field.label)} />
                    </SelectTrigger>
                    <SelectContent>
                      {(field.options ?? []).map((option) => (
                        <SelectItem
                          key={`${field.key}-${option.value}`}
                          value={option.value}
                        >
                          {localizeMessage(option.label)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              );
            }

            const error = manualToolFieldErrors[field.key];
            const fieldErrorId = `manual-tool-${field.key}-error`;
            return (
              <Field className="gap-1.5" key={field.key} data-invalid={!!error}>
                <FieldLabel htmlFor={fieldId} className="sr-only">{localizeMessage(field.label)}</FieldLabel>
                <Input
                  id={fieldId}
                  aria-describedby={error ? fieldErrorId : undefined}
                  aria-invalid={error ? true : undefined}
                  className={cn(
                    "h-8",
                    error
                      ? "border-destructive/60 bg-background text-foreground focus-visible:border-destructive focus-visible:ring-destructive/20"
                      : "",
                  )}
                  inputMode={field.type === "number" ? "decimal" : undefined}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setManualToolFieldValues((prev) => ({
                      ...prev,
                      [field.key]: nextValue,
                    }));
                    setManualToolFieldErrors((prev) => {
                      const nextError = getManualToolFieldError(
                        field,
                        nextValue,
                      );
                      if (nextError) {
                        return { ...prev, [field.key]: nextError };
                      }
                      const rest = { ...prev };
                      delete rest[field.key];
                      return rest;
                    });
                  }}
                  placeholder={localizeMessage(field.placeholder ?? field.label)}
                  type={field.type === "number" ? "text" : field.type}
                  value={value}
                />
                {error ? (
                  <p
                    className="px-1 text-[11px] leading-4 text-destructive/90"
                    id={fieldErrorId}
                    role="alert"
                  >
                    <span>{localizeMessage(error)}</span>
                  </p>
                ) : null}
              </Field>
            );
          })}
        </FieldGroup>
      ) : null}

      {modelMode === "chat" ? (
        toolCatalogError ? (
          <p className="text-[11px] text-warning">
            {tf("chat.composer.toolCatalogError", { detail: toolCatalogError })}
          </p>
        ) : selectedManualToolConfig ? (
          <p className="text-[11px] text-muted-foreground">
            {localizeMessage(selectedManualToolConfig.description)}
          </p>
        ) : null
      ) : null}

      {/* One bordered surface holds the prompt, the controls that shape it, and the
        send action. Scattering those across separate full-width rows left the
        send button visually unconnected to what it submits. */}
      <div className="composer-surface">
        {isDocumentTool ? <DocumentToolInput key={`${activeChat?.documentScope ?? ""}:${selectedManualToolConfig?.id}`} value={selectedToolDocument} onChange={setSelectedToolDocument} scope={activeChat?.documentScope} disabled={isPending} /> : <Textarea
          className="composer-input block h-20 min-h-0 resize-none overflow-y-auto rounded-none px-4 py-3 shadow-none focus-visible:ring-0"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleTextareaKeyDown}
          onPaste={onTextareaPaste}
          placeholder={
            modelMode === "image"
              ? t("chat.composer.placeholderImage")
              : modelMode === "video"
                ? t("chat.composer.placeholderVideo")
                : selectedManualToolConfig
                  ? localizeMessage(selectedManualToolConfig.manual.placeholder)
                  : t("chat.composer.placeholderChat")
          }
          ref={textareaRef}
          rows={3}
          value={input}
        />}
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
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {/* The native control renders untranslated browser chrome inside an
              otherwise Chinese UI, so the label carries the visible copy and the
              input names itself. The selected filenames are announced from our
              own live region rather than left to the browser's default. */}
            <label
              className={cn(
                "inline-flex h-7 w-7 shrink-0 cursor-pointer select-none items-center justify-center rounded-md text-xs text-muted-foreground transition-colors focus-within:ring-1 focus-within:ring-ring",
                "hover:bg-accent hover:text-foreground",
                (!isConversationReady || isManualToolSelected || isUploadingAttachments) && "pointer-events-none opacity-50",
              )}
            >
              <Paperclip aria-hidden="true" className="h-3.5 w-3.5" />
              <span className="sr-only">{t("chat.composer.chooseFile")}</span>
              <input
                accept={modelMode === "chat" ? [...CHAT_ATTACHMENT_TYPES, ".pdf", ".docx"].join(",") : IMAGE_MEDIA_TYPES.join(",")}
                aria-label={t("chat.composer.fileInputLabel")}
                className="sr-only"
                disabled={!isConversationReady || isManualToolSelected || isUploadingAttachments}
                multiple
                onChange={onAttachmentInputChange}
                ref={fileInputRef}
                type="file"
              />
            </label>
            <Select
              disabled={isPending}
              onValueChange={(value) => onModeSelect(value as ModelMode)}
              value={modelMode}
            >
              <SelectTrigger
                aria-label={t("chat.toolbar.modeChat")}
                variant="ghost"
                size="sm"
                className="w-auto"
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
            </Select>
            <Select
              disabled={isPending || (modelMode === "chat" && !!activeChat?.assistantConfig?.model)}
              open={isModelMenuOpen}
              onOpenChange={setIsModelMenuOpen}
              // "添加模型…" opens the model settings instead of becoming the selection.
              onValueChange={value => value === ADD_MODEL ? openSettings("models") : onModelSelect(value)}
              // Until the saved choice is read, the last model shown stands in for
              // it, rather than "选择模型" claiming no model is chosen. With no
              // model the placeholder says so; it is not an item to tick.
              value={selectedModel && !isLoadingPreferences ? modelRefKey(selectedModel) : ""}
            >
              {/* Sized to the name; a different name eases to its width instead of pushing the tools aside. */}
              <SelectTrigger
                aria-label={t("chat.toolbar.modelSelectLabel")}
                variant="ghost"
                size="sm"
                fluid
                className="w-auto max-w-[200px] data-[placeholder]:text-foreground"
              >
                <SelectValue className="truncate" placeholder={isLoadingPreferences ? rememberedModelLabel : t("chat.toolbar.modelNone")} />
              </SelectTrigger>
              <SelectContent>
                {selectedModel &&
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
            </Select>

            {modelMode === "chat" ? (
              <>
                <Select
                  disabled={isPending}
                  onValueChange={(value) =>
                    setSelectedManualTool(value as ManualToolSelection)
                  }
                  value={manualToolSelectValue}
                >
                  <SelectTrigger
                    aria-label={t("chat.composer.toolSelectLabel")}
                    variant="ghost"
                    size="sm"
                    className="w-auto max-w-[160px]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">
                      {t("chat.composer.toolAutoOption")}
                    </SelectItem>
                    {unavailableTools.map((tool) => (
                      <SelectItem
                        disabled
                        key={tool.id}
                        value={`unavailable-${tool.id}`}
                      >
                        {`${(tool.extensionId ? tool.displayName : localizeMessage(tool.displayName))}（${tool.extensionId ? tool.reason === "disabled" ? t("ui.chat.composer.disabled") : tool.reason === "notTested" ? t("ui.chat.composer.notTested") : tool.reason === "toolDisabled" ? t("ui.chat.composer.toolNotEnabled") : t("ui.chat.composer.credentialsUnavailable") : t("chat.composer.toolNotConfigured")}）`}
                      </SelectItem>
                    ))}
                    {manualTools.map((tool) => (
                      <SelectItem key={tool.id} value={tool.id}>
                        {(tool.extensionId ? tool.displayName : localizeMessage(tool.displayName))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <ContextUsage messages={messages} />
              </>
            ) : null}

            {/* Visible hint stays exactly as before; this second, hidden node
              exists only so a screen reader hears the attachment state in the
              interface language instead of the browser's own wording. */}
            {attachmentNames.length > 0 ? (
              <span className="truncate text-[11px] text-muted-foreground">
                {attachmentNames.join(t("chat.composer.attachmentSeparator"))}
              </span>
            ) : (
              <span className="sr-only">
                {isManualToolSelected
                  ? t("chat.composer.attachmentsBlocked")
                  : t("chat.composer.pasteHint")}
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
          {isRunningManualTool ? <Button size="icon" className="rounded-full" disabled aria-label={t("ui.chat.composer.runningTool")}><Loader2 data-icon="inline-start" className="animate-spin" /></Button> : isWorking ? (
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
              disabled={!isConversationReady || isDocumentScopeSaving || (isDocumentTool ? !selectedToolDocument : !input.trim() && attachments.length === 0)}
              type="submit"
            >
              <ArrowUp aria-hidden="true" strokeWidth={2.25} />
              <span className="sr-only">
                {isManualToolSelected
                  ? ((selectedManualToolConfig ? localizeMessage(selectedManualToolConfig.manual.submitLabel) : undefined) ??
                    t("chat.composer.runTool"))
                  : t("chat.composer.send")}
              </span>
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
